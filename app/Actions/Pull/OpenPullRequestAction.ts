import { Action } from '@stacksjs/actions'
import { schema } from '@stacksjs/validation'
import { refusal, spendFor } from '../../Api/token-limits'
import { isSafeRef, mergeBase, runGit } from '../Git/git'
import { repositoryPath } from '../Git/storage'
import { allocateNumber, authorizeRepository } from '../Repo/authorize'
import { codeownersFor, ownersForPaths, resolveOwners } from './codeowners'

/**
 * Open a pull request.
 *
 * The head and base are resolved through git at open time so the pull request
 * records the commits it was opened against. Without that, a review has nothing
 * stable to anchor to and a rebase silently changes what was approved.
 *
 * A pull request whose base is another open pull request's branch is recorded
 * as stacked, which is what lets the stack retarget itself when the bottom of
 * it merges.
 */
export default new Action({
  name: 'OpenPullRequest',
  description: 'Open a pull request between two branches',
  method: 'POST',

  /*
   * Declared here so the reference lists them and the validator enforces them
   * from the same object. Read against the handler rather than the field name:
   * a declared rule is enforced, so a wrong one turns an ordinary request into
   * a 422 - which is how `assignees: string` broke assigning somebody.
   */
  validations: {
    owner: { rule: schema.string().required() },
    repo: { rule: schema.string() },
    repository: { rule: schema.string() },
    title: { rule: schema.string().required() },
    head: { rule: schema.string().required() },
    base: { rule: schema.string() },
    body: { rule: schema.string() },
    draft: { rule: schema.boolean() },
  },

  responses: {
    201: { description: 'The pull request, with the number it was given.' },
    401: { description: 'Unauthenticated.' },
    409: { description: 'An open pull request from this head to this base already exists. Two of them would be two conversations about one change.' },
    422: { description: 'A title and a head branch are required, the head must exist, and it cannot be the base.' },
    404: { description: 'No such repository or pull request, or none this caller may see. A private repository answers this rather than 403, because a 403 confirms it exists.' },
  },

  async handle(request: any) {
    const auth = await authorizeRepository(request, 'pull:open')
    if (!auth.ok)
      return response.json({ error: auth.error }, auth.status)

    const { repository, user } = auth.context
    if (!user)
      return response.json({ error: 'Unauthenticated' }, 401)

    const head = String(request.get('head') ?? '').trim()
    const base = String(request.get('base') ?? repository.default_branch).trim()

    if (!isSafeRef(head) || !isSafeRef(base))
      return response.json({ error: 'That branch name cannot be used' }, 422)

    if (head === base)
      return response.json({ error: 'A pull request needs two different branches' }, 422)

    const title = String(request.get('title') ?? '').trim()
    if (!title)
      return response.json({ error: 'A pull request needs a title' }, 422)

    const resolved = repositoryPath(String(request.get('owner')), repository.name)
    if (!resolved.ok)
      return response.json({ error: 'Repository not found' }, 404)

    const headSha = await revision(resolved.path!, head)
    const baseSha = await revision(resolved.path!, base)

    if (!headSha)
      return response.json({ error: `There is no branch named ${head}` }, 422)

    if (!baseSha)
      return response.json({ error: `There is no branch named ${base}` }, 422)

    // Nothing to review: the head is already contained in the base.
    if (await mergeBase(resolved.path!, headSha, baseSha) === headSha)
      return response.json({ error: 'That branch is already merged into the base' }, 422)

    const existing = await db
      .selectFrom('pull_requests')
      .select(['number'])
      .where('repository_id', '=', repository.id)
      .where('head_branch', '=', head)
      .where('base_branch', '=', base)
      .where('state', '=', 'open')
      .executeTakeFirst()

    if (existing)
      return response.json({ error: `A pull request for these branches is already open (#${existing.number})` }, 409)

    // A pull request opened against another open pull request's branch is part
    // of a stack, and needs to know its parent so it can be retargeted when the
    // parent merges rather than left pointing at a deleted branch.
    const parent = await db
      .selectFrom('pull_requests')
      .select(['id'])
      .where('repository_id', '=', repository.id)
      .where('head_branch', '=', base)
      .where('state', '=', 'open')
      .executeTakeFirst()

    /*
     * The token's hourly budget, spent before anything is created.
     *
     * Before `allocateNumber`, because that increments the repository's counter
     * and a refusal after it would burn a pull request number on a request that
     * never happened - leaving a gap somebody has to explain.
     */
    const budget = await spendFor(request, 'pull_requests')
    if (!budget.verdict.allowed)
      return refusal('pull_requests', budget.limit, budget.verdict)

    const number = await allocateNumber(repository.id)

    const created = await db
      .insertInto('pull_requests')
      .values({
        repository_id: repository.id,
        number,
        title,
        body: String(request.get('body') ?? ''),
        author_id: user.id,
        state: 'open',
        head_repository_id: repository.id,
        head_branch: head,
        head_sha: headSha,
        base_branch: base,
        base_sha: baseSha,
        draft: Boolean(request.get('draft')),
        mergeable_state: 'unknown',
        stack_parent_id: parent ? Number(parent.id) : null,
        additions: 0,
        deletions: 0,
        changed_files: 0,
      })
      .returning(['id'])
      .executeTakeFirst()

    const requested = await requestCodeOwners({
      diskPath: resolved.path!,
      pullRequestId: Number(created?.id),
      baseSha,
      headSha,
      authorId: user.id,
    })

    // After the row exists, and after the owners are asked, so the people
    // `CODEOWNERS` just named are addressed by the same event rather than
    // needing a second one.
    const { notify } = await import('../../Notifications/emit')
    const askedIds: any[] = requested.length === 0
      ? []
      : await db.selectFrom('users').select(['id']).where('handle', 'in', requested).execute()

    await notify('pr:opened', {
      actorId: user.id,
      actorHandle: user.handle,
      repositoryId: repository.id,
      owner: String(request.get('owner') ?? '').trim().toLowerCase(),
      repository: repository.name,
      subjectType: 'pull_request',
      subjectId: Number(created?.id),
      number,
      title,
      addressed: askedIds.map(row => Number(row.id)),
      // Opening something subscribes you to it, as the author.
      subscribeActor: 'author',
    })

    return response.json({
      id: Number(created?.id),
      number,
      title,
      head: { branch: head, sha: headSha },
      base: { branch: base, sha: baseSha },
      stacked_on: parent ? Number(parent.id) : null,
      state: 'open',
      review_requests: requested,
    }, 201)
  },
})

/** The commit a branch points at, or null when the branch does not exist. */
async function revision(path: string, ref: string): Promise<string | null> {
  const result = await runGit(path, ['rev-parse', '--verify', `refs/heads/${ref}`])

  return result.ok ? result.stdout.trim() : null
}

/**
 * Ask whoever `CODEOWNERS` names for the files this pull request touches.
 *
 * Read from the base rather than the head: a pull request that adds itself to
 * `CODEOWNERS` would otherwise choose its own reviewers, which is a way to be
 * approved by nobody.
 *
 * The author is never asked to review their own change. Being named as an owner
 * of a file you are changing is the normal case, not an exception, so filtering
 * it out is most of what this does in practice - including when the naming is
 * indirect, through a team the author is on.
 *
 * A name resolving to nobody here - an unknown handle, an email address, a
 * team this forge has never heard of - is skipped rather than failing the
 * request. The file is checked in and can name anyone; refusing to open a pull
 * request because of a stale line in it would make an unrelated problem look
 * like the forge being broken. A team that *is* known resolves to its members,
 * each asked as themselves: `resolveOwners` in `codeowners.ts`.
 *
 * Never throws. This runs *after* the pull request exists, so an error here
 * would report a failure for something that succeeded.
 */
async function requestCodeOwners(options: {
  diskPath: string
  pullRequestId: number
  baseSha: string
  headSha: string
  authorId: number
}): Promise<string[]> {
  if (!options.pullRequestId)
    return []

  try {
    const rules = await codeownersFor(options.diskPath, options.baseSha)
    if (rules.length === 0)
      return []

    const changed = await changedPaths(options.diskPath, options.baseSha, options.headSha)
    const named = ownersForPaths(rules, changed)
    if (named.length === 0)
      return []

    const people = await resolveOwners(named)

    const asked: string[] = []
    for (const person of people) {
      if (person.id === options.authorId)
        continue

      await db.insertInto('pull_request_reviewers').values({
        pull_request_id: options.pullRequestId,
        reviewer_type: 'user',
        reviewer_id: person.id,
        from_code_owners: true,
      }).execute()

      asked.push(person.handle)
    }

    return asked
  }
  catch {
    return []
  }
}

/** The paths a branch changes against its base, three dots. */
async function changedPaths(diskPath: string, baseSha: string, headSha: string): Promise<string[]> {
  const result = await runGit(diskPath, ['diff', '--name-only', `${baseSha}...${headSha}`])

  return result.ok ? result.stdout.split('\n').map(line => line.trim()).filter(Boolean) : []
}

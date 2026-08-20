/**
 * Opening a pull request, without a request.
 *
 * Extracted from `OpenPullRequestAction` when the repair agent needed to open
 * one, and extracted rather than copied for the reason this codebase keeps
 * saying about `settle.ts`: two implementations of "what it means to open a
 * pull request" is how the two end up disagreeing about stacking, or code
 * owners, or which duplicate is refused - and the one nobody looks at is the
 * one that goes wrong.
 *
 * What stayed in the action is everything that is about a *request*:
 * authorization, the declared validations, and the token's hourly budget. What
 * moved here is everything that is about a *pull request*, which is what a job
 * needs too.
 */

import { db } from '@stacksjs/database'
import { isSafeRef, mergeBase, runGit } from '../Git/git'
import { allocateNumber } from '../Repo/authorize'
import { codeownersFor, ownersForPaths, resolveOwners } from './codeowners'

export interface OpenPullRequestInput {
  /** The bare repository on this node. */
  diskPath: string
  repositoryId: number
  /** The owner's handle, which the notification reads. */
  owner: string
  /** The repository's name, same. */
  repository: string
  title: string
  body?: string
  head: string
  base: string
  authorId: number
  /** The author's handle, for the notification. Looked up when absent. */
  authorHandle?: string
  draft?: boolean
}

export type OpenPullRequestResult =
  | {
    ok: true
    id: number
    number: number
    title: string
    head: { branch: string, sha: string }
    base: { branch: string, sha: string }
    stackedOn: number | null
    reviewRequests: string[]
  }
  | { ok: false, status: number, error: string }

/**
 * Open one.
 *
 * Returns a status alongside the error rather than throwing, because the caller
 * that has a response to write needs the number and the caller that does not -
 * a job - needs a value it can record. An exception would serve neither well.
 */
export async function openPullRequest(input: OpenPullRequestInput): Promise<OpenPullRequestResult> {
  const head = String(input.head ?? '').trim()
  const base = String(input.base ?? '').trim()
  const title = String(input.title ?? '').trim()

  if (!isSafeRef(head) || !isSafeRef(base))
    return { ok: false, status: 422, error: 'That branch name cannot be used' }

  if (head === base)
    return { ok: false, status: 422, error: 'A pull request needs two different branches' }

  if (!title)
    return { ok: false, status: 422, error: 'A pull request needs a title' }

  const headSha = await revision(input.diskPath, head)
  const baseSha = await revision(input.diskPath, base)

  if (!headSha)
    return { ok: false, status: 422, error: `There is no branch named ${head}` }

  if (!baseSha)
    return { ok: false, status: 422, error: `There is no branch named ${base}` }

  // Nothing to review: the head is already contained in the base.
  if (await mergeBase(input.diskPath, headSha, baseSha) === headSha)
    return { ok: false, status: 422, error: 'That branch is already merged into the base' }

  const existing = await db
    .selectFrom('pull_requests')
    .select(['number'])
    .where('repository_id', '=', input.repositoryId)
    .where('head_branch', '=', head)
    .where('base_branch', '=', base)
    .where('state', '=', 'open')
    .executeTakeFirst()

  if (existing)
    return { ok: false, status: 409, error: `A pull request for these branches is already open (#${existing.number})` }

  // A pull request opened against another open pull request's branch is part of
  // a stack, and needs to know its parent so it can be retargeted when the
  // parent merges rather than left pointing at a deleted branch.
  const parent = await db
    .selectFrom('pull_requests')
    .select(['id'])
    .where('repository_id', '=', input.repositoryId)
    .where('head_branch', '=', base)
    .where('state', '=', 'open')
    .executeTakeFirst()

  const number = await allocateNumber(input.repositoryId)

  const created = await db
    .insertInto('pull_requests')
    .values({
      repository_id: input.repositoryId,
      number,
      title,
      body: String(input.body ?? ''),
      author_id: input.authorId,
      state: 'open',
      head_repository_id: input.repositoryId,
      head_branch: head,
      head_sha: headSha,
      base_branch: base,
      base_sha: baseSha,
      draft: Boolean(input.draft),
      mergeable_state: 'unknown',
      stack_parent_id: parent ? Number(parent.id) : null,
      additions: 0,
      deletions: 0,
      changed_files: 0,
    })
    .returning(['id'])
    .executeTakeFirst()

  const requested = await requestCodeOwners({
    diskPath: input.diskPath,
    pullRequestId: Number(created?.id),
    repositoryId: input.repositoryId,
    baseSha,
    headSha,
    authorId: input.authorId,
  })

  // After the row exists, and after the owners are asked, so the people
  // `CODEOWNERS` just named are addressed by the same event rather than needing
  // a second one.
  const { notify } = await import('../../Notifications/emit')
  const askedIds: any[] = requested.length === 0
    ? []
    : await db.selectFrom('users').select(['id']).where('handle', 'in', requested).execute()

  await notify('pr:opened', {
    actorId: input.authorId,
    actorHandle: input.authorHandle ?? await handleOf(input.authorId),
    repositoryId: input.repositoryId,
    owner: String(input.owner ?? '').trim().toLowerCase(),
    repository: input.repository,
    subjectType: 'pull_request',
    subjectId: Number(created?.id),
    number,
    title,
    addressed: askedIds.map(row => Number(row.id)),
    // Opening something subscribes you to it, as the author.
    subscribeActor: 'author',
  })

  return {
    ok: true,
    id: Number(created?.id),
    number,
    title,
    head: { branch: head, sha: headSha },
    base: { branch: base, sha: baseSha },
    stackedOn: parent ? Number(parent.id) : null,
    reviewRequests: requested,
  }
}

/** The commit a branch points at, or null when the branch does not exist. */
export async function revision(path: string, ref: string): Promise<string | null> {
  const result = await runGit(path, ['rev-parse', '--verify', `refs/heads/${ref}`])

  return result.ok ? result.stdout.trim() : null
}

/** An author's handle, when the caller did not already have it. */
async function handleOf(userId: number): Promise<string> {
  const row: any = await db
    .selectFrom('users')
    .select(['handle'])
    .where('id', '=', userId)
    .executeTakeFirst()
    .catch(() => null)

  return String(row?.handle ?? '')
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
 * A name resolving to nobody here - an unknown handle, an email address, a team
 * this forge has never heard of - is skipped rather than failing the request.
 * The file is checked in and can name anyone; refusing to open a pull request
 * because of a stale line in it would make an unrelated problem look like the
 * forge being broken. A team that *is* known resolves to its members, each
 * asked as themselves: `resolveOwners` in `codeowners.ts`.
 *
 * Never throws. This runs *after* the pull request exists, so an error here
 * would report a failure for something that succeeded.
 */
async function requestCodeOwners(options: {
  diskPath: string
  pullRequestId: number
  /** The shard key, carried down so the row can be routed on it. */
  repositoryId: number
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
        repository_id: options.repositoryId,
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

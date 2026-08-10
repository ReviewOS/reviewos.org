import { Job } from '@stacksjs/queue'
import { mkdir, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import process from 'node:process'
import type { ExternalAuthor, LocalAccount } from '../Actions/Import/attribution'
import { buildLinkMap, parseClaims, rewriteReferences } from '../Actions/Import/attribution'
import type { ImportProgress, ImportStage } from '../Actions/Import/plan'
import { describeProgress, emptyProgress, isFinished, nextStage, noteProblem, record, summarize } from '../Actions/Import/plan'
import { runGit } from '../Actions/Git/git'
import { repositoryPath } from '../Actions/Git/storage'
import { buildThreads, mapIssue, mapLabel, mapPull, mapReviewComment, onlyIssues } from '../Actions/Mirror/github'
import { GitHubClient } from '../Actions/Mirror/github-client'
import { issueRow, pullNumberOf, pullRow, reviewCommentRow, threadRow } from '../Actions/Mirror/metadata'
import { recountComments, recountOpenIssues } from '../Actions/Repo/counters'

/**
 * Bring a GitHub repository here, with its history and its conversations.
 *
 * Nobody adopts a forge they cannot move to, and the quality of this decides
 * whether an evaluation ends in a migration or a shrug. So the bar is not "the
 * commits arrived": it is that `#123` still resolves, that a review thread is
 * still anchored to the line it was written about, and that nobody's name is on
 * a comment they did not write.
 *
 * ## Git first, deliberately
 *
 * `git clone --mirror` runs before any metadata, so the repository is usable -
 * clonable, browsable, reviewable - within a minute or two of starting, while
 * the issues are still arriving. The other order produces an instance full of
 * issues pointing at code that is not there yet, which reads as broken.
 *
 * ## Resumable, because it will be interrupted
 *
 * An import of a real repository outlives deploys, worker restarts, and rate
 * limits. The job walks named stages with a cursor and re-dispatches itself, so
 * an interruption costs one page rather than the migration. Every write is
 * keyed on something stable from the source, so re-running a page updates
 * rather than duplicates - the cursor is an optimisation on top of that, not
 * the correctness argument.
 *
 * ## Numbers are preserved
 *
 * A repository whose `#123` no longer resolves has lost every cross reference
 * in its own history, including the ones in commit messages that no importer
 * can rewrite. So issues and pull requests keep their numbers, and the counter
 * is set past the highest of them.
 */
export default new Job({
  name: 'ImportRepositoryJob',
  description: 'Import a repository and its metadata from GitHub',
  queue: 'git',
  tries: 3,

  async handle(payload: any) {
    const operationId = Number(payload?.operationId ?? 0)
    const repositoryId = Number(payload?.repositoryId ?? 0)
    const source = String(payload?.source ?? '')
    const [owner, name] = source.split('/')

    if (!repositoryId || !owner || !name)
      return

    const progress: ImportProgress = payload?.progress ?? emptyProgress()
    const claims = parseClaims(String(payload?.claims ?? ''))

    const client = new GitHubClient({
      token: String(process.env.GITHUB_TOKEN ?? '') || null,
      baseUrl: String(payload?.baseUrl ?? '') || undefined,
    })

    await report(operationId, progress)

    try {
      await runStage(progress, { client, owner, name, repositoryId, claims, source: payload?.source })
    }
    catch (error) {
      /*
       * A stage that threw is recorded and *retried*, not abandoned.
       *
       * The queue's own retry is what handles a transient failure; this catch
       * exists so the reason reaches the operation row, because an import that
       * stops with an opaque "failed" is one somebody restarts from the
       * beginning rather than from where it stopped.
       */
      noteProblem(progress, `${progress.stage}: ${error instanceof Error ? error.message : String(error)}`)
      await report(operationId, progress, 'running')

      throw error
    }

    if (isFinished(progress)) {
      await recountOpenIssues(repositoryId).catch(() => undefined)
      await report(operationId, progress, 'succeeded')

      return
    }

    await report(operationId, progress)

    // Re-dispatched rather than looped, so one stage is one job: a worker
    // restart between stages costs nothing, and the queue's own visibility
    // applies to each of them.
    await (await import('./ImportRepositoryJob')).default.dispatch({ ...payload, progress })
  },
})

interface StageContext {
  client: GitHubClient
  owner: string
  name: string
  repositoryId: number
  claims: Map<string, string>
  source: string
}

/** Do one stage's work, and advance the cursor to whatever is next. */
async function runStage(progress: ImportProgress, context: StageContext): Promise<void> {
  const handlers: Record<ImportStage, (p: ImportProgress, c: StageContext) => Promise<void>> = {
    git: importGit,
    labels: importLabels,
    milestones: importMilestones,
    issues: importIssues,
    pulls: importPulls,
    comments: importIssueComments,
    reviews: importReviews,
    releases: skip,
    done: skip,
  }

  await handlers[progress.stage](progress, context)

  progress.stage = nextStage(progress.stage)
  progress.page = 1
}

/** Stages that have nothing to do yet, so the walk stays complete. */
async function skip(): Promise<void> {}

/**
 * The repository itself, before anything else.
 *
 * `--mirror` rather than `--bare`: it brings every ref, including tags and the
 * remote's own branches, which is what makes the result a copy rather than a
 * snapshot of the default branch. It also sets the remote as a mirror, so the
 * `origin` config is removed afterwards - an imported repository is *ours* now,
 * and leaving a remote pointing at GitHub is how somebody later pushes a local
 * change back to a repository they thought they had left.
 */
async function importGit(progress: ImportProgress, context: StageContext): Promise<void> {
  const db = (globalThis as any).db
  const row: any = await db
    .selectFrom('repositories')
    .select(['disk_path', 'name', 'owner_type', 'owner_id'])
    .where('id', '=', context.repositoryId)
    .executeTakeFirst()

  if (!row)
    throw new Error('the repository row disappeared mid-import')

  const handle = await ownerHandle(row)
  const resolved = repositoryPath(handle, String(row.name))

  if (!resolved.ok)
    throw new Error('the repository name does not resolve to a safe path')

  const path = resolved.path!

  // Already cloned. The stage is re-entrant because a resumed import re-runs
  // whichever stage it was in, and re-cloning would throw away anything pushed
  // since.
  const existing = await runGit(path, ['rev-parse', '--git-dir'])

  if (existing.ok) {
    record(progress, 'git', 0)

    return
  }

  await mkdir(dirname(path), { recursive: true })

  const remote = String(process.env.GITHUB_CLONE_BASE ?? 'https://github.com').replace(/\/$/, '')
  const clone = await runGit(dirname(path), ['clone', '--mirror', `${remote}/${context.owner}/${context.name}.git`, path])

  if (!clone.ok) {
    // A half-written directory would make the re-entrancy check above think the
    // clone succeeded, so it goes before the failure is reported.
    await rm(path, { recursive: true, force: true }).catch(() => undefined)

    throw new Error(`git clone failed: ${clone.stderr.slice(0, 300)}`)
  }

  // The remote goes. An imported repository is this instance's, and a remote
  // pointing at GitHub is how somebody later pushes here and finds it upstream.
  await runGit(path, ['remote', 'remove', 'origin'])

  record(progress, 'git')
}

async function importLabels(progress: ImportProgress, context: StageContext): Promise<void> {
  const db = (globalThis as any).db
  const page = await context.client.labels(context.owner, context.name)

  if (!page.ok)
    throw new Error(page.error ?? 'the labels could not be read')

  for (const raw of page.items) {
    const label = mapLabel(raw)

    if (!label)
      continue

    const existing: any = await db
      .selectFrom('repository_labels')
      .select(['id'])
      .where('repository_id', '=', context.repositoryId)
      .where('name', '=', label.name)
      .executeTakeFirst()

    if (existing) {
      await db
        .updateTable('repository_labels')
        .set({ color: label.color, description: label.description })
        .where('id', '=', Number(existing.id))
        .execute()

      continue
    }

    await db.insertInto('repository_labels').values({
      repository_id: context.repositoryId,
      name: label.name,
      color: label.color,
      description: label.description,
      is_default: false,
    }).execute()

    record(progress, 'labels')
  }
}

/**
 * Milestones, which are what most of a repository's history is filed under.
 *
 * Keyed on the title within the repository. There is no external id column on
 * `milestones` and adding one would be the third table to carry it - the title
 * is what an issue references, what a person searches for, and what GitHub
 * itself treats as the milestone's identity in every url it prints.
 */
async function importMilestones(progress: ImportProgress, context: StageContext): Promise<void> {
  const db = (globalThis as any).db
  const page = await context.client.milestones(context.owner, context.name)

  if (!page.ok)
    throw new Error(page.error ?? 'the milestones could not be read')

  for (const raw of page.items) {
    const title = String((raw as any).title ?? '').trim()

    if (!title)
      continue

    const values = {
      repository_id: context.repositoryId,
      title,
      description: String((raw as any).description ?? '') || null,
      due_on: (raw as any).due_on ? String((raw as any).due_on) : null,
      state: String((raw as any).state ?? 'open') === 'closed' ? 'closed' : 'open',
    }

    const existing: any = await db
      .selectFrom('milestones')
      .select(['id'])
      .where('repository_id', '=', context.repositoryId)
      .where('title', '=', title)
      .executeTakeFirst()

    if (existing) {
      await db.updateTable('milestones').set(values as any).where('id', '=', Number(existing.id)).execute()

      continue
    }

    await db.insertInto('milestones').values(values as any).execute()
    record(progress, 'milestones')
  }
}

/**
 * Every comment on every issue and pull request.
 *
 * **The conversation, which is the reason to migrate at all.** A repository
 * whose issues arrived without their comments has kept the questions and lost
 * every answer, and that is not a partial import - it is a worse artefact than
 * a link to the old forge.
 *
 * Fetched as one collection rather than per issue: a repository with two
 * thousand issues would otherwise cost two thousand requests against an hourly
 * limit.
 */
async function importIssueComments(progress: ImportProgress, context: StageContext): Promise<void> {
  const db = (globalThis as any).db
  const page = await context.client.issueComments(context.owner, context.name)

  if (!page.ok)
    throw new Error(page.error ?? 'the issue comments could not be read')

  const linked = await linkMapFor(page.items.map(raw => (raw as any).user), context)
  const imported = await importedRepositories()
  const touched = new Set<number>()

  for (const raw of page.items) {
    const externalId = String((raw as any).id ?? '')
    const number = issueNumberOf(raw)

    if (!externalId || !number)
      continue

    /*
     * The subject, which may be an issue or a pull request.
     *
     * GitHub files both under `/issues/comments`, and here they are separate
     * tables - so the number is looked up in both, issues first. A comment
     * attached to the wrong one would appear on an unrelated conversation that
     * happens to share a number, which is the shape of mistake nobody reviews
     * for because it looks like ordinary data.
     */
    const issue: any = await db
      .selectFrom('issues')
      .select(['id'])
      .where('repository_id', '=', context.repositoryId)
      .where('number', '=', number)
      .executeTakeFirst()

    const pull: any = issue
      ? null
      : await db
          .selectFrom('pull_requests')
          .select(['id'])
          .where('repository_id', '=', context.repositoryId)
          .where('number', '=', number)
          .executeTakeFirst()

    if (!issue && !pull) {
      noteProblem(progress, `a comment refers to #${number}, which was not imported`)

      continue
    }

    const seen: any = await db
      .selectFrom('issue_comments')
      .select(['id'])
      .where('external_id', '=', externalId)
      .executeTakeFirst()

    if (seen)
      continue

    const login = String((raw as any).user?.login ?? '').toLowerCase()
    const authorId = linked.get(login) ?? null

    await db.insertInto('issue_comments').values({
      commentable_type: issue ? 'issue' : 'pull_request',
      commentable_id: Number(issue?.id ?? pull?.id),
      author_id: authorId,
      // Named rather than reassigned when nobody claimed them, exactly as the
      // issues and reviews are.
      external_author: authorId ? null : (String((raw as any).user?.login ?? '') || null),
      external_id: externalId,
      body: rewriteReferences(String((raw as any).body ?? ''), imported),
    } as any).execute()

    record(progress, 'comments')
    touched.add(Number(issue?.id ?? pull?.id))
  }

  /*
   * The comment counters, once per subject rather than once per comment.
   *
   * An invariant test in this codebase says anything writing comments must
   * recount them, and it caught this: without it every imported issue would
   * show a comment count of zero beside a conversation that is plainly there,
   * which reads as a broken page rather than a stale number.
   *
   * Batched to the end because an issue with forty comments would otherwise be
   * forty recounts of the same row.
   */
  for (const subjectId of touched)
    await recountComments(subjectId).catch(() => undefined)
}

/**
 * The issue or pull request number a comment hangs off, from its url.
 *
 * GitHub gives `issue_url` and nothing else usable: there is no `issue_number`
 * field, and the `html_url` carries a fragment that is the comment's own id
 * rather than the subject's.
 */
function issueNumberOf(comment: unknown): number {
  const url = String((comment as any)?.issue_url ?? '')
  const match = /\/issues\/(\d+)(?:$|[?#])/.exec(url)

  return match ? Number(match[1]) : 0
}

async function importIssues(progress: ImportProgress, context: StageContext): Promise<void> {
  const db = (globalThis as any).db
  const page = await context.client.issues(context.owner, context.name)

  if (!page.ok)
    throw new Error(page.error ?? 'the issues could not be read')

  const items = onlyIssues(page.items)
  const linked = await linkMapFor(items.map(raw => (raw as any).user), context)
  const imported = await importedRepositories()

  for (const raw of items) {
    const issue = mapIssue(raw, linked)

    if (!issue)
      continue

    const values = {
      ...issueRow(issue, context.repositoryId),
      // Rewritten after the mapper, because the body it produces is the source
      // of truth for everything else and the references are a presentation
      // concern layered on top.
      body: rewriteReferences(String(issue.body ?? ''), imported),
    }

    /*
     * Keyed on the number, which is preserved.
     *
     * So a re-run of this page updates the same row rather than making a second
     * issue with the same number - and the number is what every cross reference
     * in the repository's own history depends on.
     */
    const existing: any = await db
      .selectFrom('issues')
      .select(['id'])
      .where('repository_id', '=', context.repositoryId)
      .where('number', '=', issue.number)
      .executeTakeFirst()

    if (existing) {
      await db.updateTable('issues').set(values as any).where('id', '=', Number(existing.id)).execute()

      continue
    }

    await db.insertInto('issues').values(values as any).execute()
    record(progress, 'issues')
  }

  await advanceCounter(context.repositoryId)
}

async function importPulls(progress: ImportProgress, context: StageContext): Promise<void> {
  const db = (globalThis as any).db
  const page = await context.client.pulls(context.owner, context.name)

  if (!page.ok)
    throw new Error(page.error ?? 'the pull requests could not be read')

  const linked = await linkMapFor(page.items.map(raw => (raw as any).user), context)
  const imported = await importedRepositories()

  for (const raw of page.items) {
    const pull = mapPull(raw, linked)

    if (!pull)
      continue

    const values = {
      ...pullRow(pull, context.repositoryId),
      body: rewriteReferences(String(pull.body ?? ''), imported),
    }

    const existing: any = await db
      .selectFrom('pull_requests')
      .select(['id'])
      .where('repository_id', '=', context.repositoryId)
      .where('number', '=', pull.number)
      .executeTakeFirst()

    if (existing) {
      await db.updateTable('pull_requests').set(values as any).where('id', '=', Number(existing.id)).execute()

      continue
    }

    await db.insertInto('pull_requests').values(values as any).execute()
    record(progress, 'pull_requests')
  }

  await advanceCounter(context.repositoryId)
}

/**
 * Review threads, anchored to the same lines they were written about.
 *
 * **The part other importers drop, and most of the value here.** A review
 * comment without its file, line and side is a comment at the bottom of a pull
 * request saying "this should be a constant", about nothing. Keeping the anchor
 * is what makes an imported review still a review.
 */
async function importReviews(progress: ImportProgress, context: StageContext): Promise<void> {
  const db = (globalThis as any).db
  const page = await context.client.reviewComments(context.owner, context.name)

  if (!page.ok)
    throw new Error(page.error ?? 'the review comments could not be read')

  const linked = await linkMapFor(page.items.map(raw => (raw as any).user), context)

  const comments = page.items
    .map(raw => mapReviewComment(raw, linked))
    .filter((one): one is NonNullable<typeof one> => one !== null)

  /*
   * Grouped by pull request first, then into threads.
   *
   * `buildThreads` rebuilds a conversation from `in_reply_to`, and it has to be
   * given one pull request's comments at a time - handed the whole repository's
   * it would chain replies across pull requests that happen to share an id
   * space, which is a thread that never existed.
   */
  const byPull = new Map<number, typeof comments>()

  for (const raw of page.items) {
    const number = pullNumberOf(raw)
    const mapped = comments.find(one => one.externalId === Number((raw as any).id))

    if (!number || !mapped)
      continue

    byPull.set(number, [...(byPull.get(number) ?? []), mapped])
  }

  for (const [pullNumber, own] of byPull) {

    const pull: any = await db
      .selectFrom('pull_requests')
      .select(['id'])
      .where('repository_id', '=', context.repositoryId)
      .where('number', '=', pullNumber)
      .executeTakeFirst()

    if (!pull) {
      // A comment on a pull request that is not here is worth saying out loud:
      // it means the pulls stage missed something, which is a bug rather than a
      // property of the repository.
      noteProblem(progress, `a review thread refers to pull request #${pullNumber}, which was not imported`)

      continue
    }

    for (const thread of buildThreads(own)) {
      const row = threadRow(thread, Number(pull.id))

      if (!row)
        continue

      const anchor = String((row as any).external_id ?? '')

      const existing: any = await db
        .selectFrom('review_threads')
        .select(['id'])
        .where('pull_request_id', '=', Number(pull.id))
        .where('external_id', '=', anchor)
        .executeTakeFirst()

      const threadId = existing
        ? Number(existing.id)
        : Number((await db.insertInto('review_threads').values(row as any).returning(['id']).executeTakeFirst())?.id)

      if (!existing)
        record(progress, 'review_threads')

      for (const comment of thread) {
        const seen: any = await db
          .selectFrom('review_comments')
          .select(['id'])
          .where('external_id', '=', String(comment.externalId))
          .executeTakeFirst()

        if (seen)
          continue

        await db.insertInto('review_comments').values(reviewCommentRow(comment, threadId) as any).execute()
        record(progress, 'comments')
      }
    }
  }
}

/**
 * The `login -> local user id` map for this page's authors.
 *
 * Built per stage rather than once, because the authors differ per stage and
 * the map is small. It folds together what the mirror already knows - accounts
 * that linked their GitHub identity - with the two sources an import adds: a
 * matching verified email, and the operator's explicit claims.
 */
async function linkMapFor(authors: readonly unknown[], context: StageContext): Promise<Map<string, number>> {
  const [linked, accounts] = await Promise.all([linkedAccounts(), localAccounts()])

  return buildLinkMap({
    linked,
    accounts,
    claims: context.claims,
    authors: authors.filter(Boolean) as ExternalAuthor[],
  })
}

/** Accounts that linked a GitHub identity themselves, which outranks any guess. */
async function linkedAccounts(): Promise<Map<string, number>> {
  const db = (globalThis as any).db
  const map = new Map<string, number>()

  try {
    const rows: any[] = await db.selectFrom('users').select(['id', 'github_username']).whereNotNull('github_username').execute()

    for (const row of rows) {
      const login = String(row.github_username ?? '').trim().toLowerCase()

      if (login)
        map.set(login, Number(row.id))
    }
  }
  catch {
    // No column, no links. Everything falls through to an external author,
    // which is the safe direction.
  }

  return map
}

/** Every local account, for attribution. Small enough to hold, once per stage. */
async function localAccounts(): Promise<LocalAccount[]> {
  const db = (globalThis as any).db

  try {
    const rows: any[] = await db.selectFrom('users').select(['id', 'handle', 'email']).execute()

    return rows.map(row => ({ id: Number(row.id), handle: String(row.handle), email: row.email ? String(row.email) : null }))
  }
  catch {
    return []
  }
}

/**
 * Which GitHub repositories exist here, so a cross reference can be rewritten.
 *
 * Only these. A link to a repository this instance does not have must stay a
 * GitHub link - making it relative would point at a page that does not exist,
 * which is worse than an external link that works.
 */
async function importedRepositories(): Promise<Map<string, string>> {
  const db = (globalThis as any).db
  const map = new Map<string, string>()

  try {
    const rows: any[] = await db
      .selectFrom('repository_mirrors')
      .select(['remote_owner', 'remote_name', 'repository_id'])
      .execute()

    for (const row of rows) {
      const repository: any = await db
        .selectFrom('repositories')
        .select(['name', 'owner_type', 'owner_id'])
        .where('id', '=', Number(row.repository_id))
        .executeTakeFirst()

      if (!repository)
        continue

      const handle = await ownerHandle(repository)

      map.set(`${String(row.remote_owner).toLowerCase()}/${String(row.remote_name).toLowerCase()}`, `${handle}/${repository.name}`)
    }
  }
  catch {
    // No mirrors table, or none recorded. Every reference stays a GitHub link,
    // which is the safe direction.
  }

  return map
}

/** The handle of whoever owns a repository row, user or organization. */
async function ownerHandle(repository: { owner_type: unknown, owner_id: unknown }): Promise<string> {
  const db = (globalThis as any).db
  const table = String(repository.owner_type) === 'organization' ? 'organizations' : 'users'

  const row: any = await db
    .selectFrom(table)
    .select(['handle'])
    .where('id', '=', Number(repository.owner_id))
    .executeTakeFirst()

  return String(row?.handle ?? '')
}

/**
 * Move the number counter past everything imported.
 *
 * Otherwise the next issue somebody opens is given a number an imported one
 * already has, and the insert fails - or worse, succeeds and produces two `#7`s
 * in one repository.
 */
async function advanceCounter(repositoryId: number): Promise<void> {
  const db = (globalThis as any).db

  try {
    const rows: any[] = await db
      .selectFrom('issues')
      .select(['number'])
      .where('repository_id', '=', repositoryId)
      .execute()

    const pulls: any[] = await db
      .selectFrom('pull_requests')
      .select(['number'])
      .where('repository_id', '=', repositoryId)
      .execute()

    const highest = [...rows, ...pulls].reduce((top, row) => Math.max(top, Number(row.number) || 0), 0)

    const current: any = await db
      .selectFrom('repositories')
      .select(['issue_counter'])
      .where('id', '=', repositoryId)
      .executeTakeFirst()

    if (highest > Number(current?.issue_counter ?? 0))
      await db.updateTable('repositories').set({ issue_counter: highest }).where('id', '=', repositoryId).execute()
  }
  catch (error) {
    console.error('[import] could not advance the issue counter:', error)
  }
}

/**
 * Write progress onto the operation row.
 *
 * The operation is what the interface and the API read, so this is the whole of
 * "progress in the interface": what has been imported, what remains, and what
 * failed. Written on every stage boundary rather than every row, because an
 * import of forty thousand comments should not be forty thousand updates.
 */
async function report(operationId: number, progress: ImportProgress, status = 'running'): Promise<void> {
  if (!operationId)
    return

  const db = (globalThis as any).db

  try {
    await db.updateTable('operations').set({
      status,
      result: JSON.stringify({
        stage: progress.stage,
        description: describeProgress(progress),
        summary: summarize(progress),
        counts: progress.counts,
        problems: progress.problems,
      }),
      ...(status === 'succeeded' ? { finished_at: new Date().toISOString() } : {}),
    }).where('id', '=', operationId).execute()
  }
  catch (error) {
    // Never fails an import. A progress line that could not be written is a
    // worse outcome than a silent import only if it stops the import.
    console.error('[import] could not record progress:', error)
  }
}

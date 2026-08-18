import { Job } from '@stacksjs/queue'
import { mkdir, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import process from 'node:process'
import type { ExternalAuthor, LocalAccount } from '../Actions/Import/attribution'
import { buildLinkMap, parseClaims, rewriteReferences } from '../Actions/Import/attribution'
import type { ForgeKind, ImportSource } from '../Actions/Import/forges'
import { FORGES, pullNumber } from '../Actions/Import/forges'
import type { ImportProgress, ImportStage } from '../Actions/Import/plan'
import { describeProgress, emptyProgress, isFinished, nextStage, noteProblem, record, summarize } from '../Actions/Import/plan'
import { mirrorClone, runGit } from '../Actions/Git/git'
import { repositoryPath } from '../Actions/Git/storage'
import { buildThreads, mapIssue, mapLabel, mapPull, mapReviewComment, onlyIssues } from '../Actions/Mirror/github'
import { GitHubClient } from '../Actions/Mirror/github-client'
import { issueRow, pullNumberOf, pullRow, reviewCommentRow, threadRow } from '../Actions/Mirror/metadata'
import { recountComments, recountOpenIssues } from '../Actions/Repo/counters'
import { db } from '@stacksjs/database'

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

    /*
     * Which forge, and how to talk to it.
     *
     * Gitea and Forgejo answer GitHub's shape closely enough to share this
     * client - `app/Actions/Import/forges.ts` holds the handful of places they
     * genuinely differ, and each of those is a parameter here rather than an
     * assumption in the code.
     */
    const forge: ForgeKind = FORGES[payload?.forge as ForgeKind] ? payload.forge : 'github'
    const shape = FORGES[forge]
    const token = String(payload?.token ?? process.env.GITHUB_TOKEN ?? '') || null

    /*
     * GitLab gets an adapter rather than the same client with options.
     *
     * It shares none of GitHub's paths - a repository is a project addressed by
     * an encoded path, comments are notes on a subject, review threads are
     * discussions with a position - and threading that through as flags would
     * produce a client that is two clients with a switch, which is the shape
     * nobody can safely change.
     */
    const client: ImportSource = forge === 'gitlab'
      ? new (await import('../Actions/Import/gitlab-client')).GitLabClient({
          token,
          baseUrl: String(payload?.baseUrl ?? ''),
        })
      : new GitHubClient({
          token,
          baseUrl: String(payload?.baseUrl ?? '') || undefined,
          authorization: shape.authorization,
        })

    await report(operationId, progress)

    try {
      await runStage(progress, { client, owner, name, repositoryId, claims, forge, source: payload?.source })
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
  client: ImportSource
  owner: string
  name: string
  repositoryId: number
  claims: Map<string, string>
  forge: ForgeKind
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
    releases: importReleases,
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
  const row = await db
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

  // `mirrorClone`, never `runGit`: `runGit` prepends `--git-dir`, which a clone
  // reads as its destination, and its 30 second timeout would SIGKILL any
  // non-trivial import mid-transfer.
  const clone = await mirrorClone(`${remote}/${context.owner}/${context.name}.git`, path)

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
  const page = await context.client.labels(context.owner, context.name)

  if (!page.ok)
    throw new Error(page.error ?? 'the labels could not be read')

  for (const raw of page.items) {
    const label = mapLabel(raw)

    if (!label)
      continue

    const existing = await db
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

    const existing = await db
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
    const issue = await db
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

    const seen = await db
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
    const existing = await db
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
  const page = await context.client.pulls(context.owner, context.name)

  if (!page.ok)
    throw new Error(page.error ?? 'the pull requests could not be read')

  const linked = await linkMapFor(page.items.map(raw => (raw as any).user), context)
  const imported = await importedRepositories()

  /*
   * The number, normalised before anything reads it.
   *
   * GitHub says `number` and Gitea says `index`, and the mapper this import
   * shares with the mirror knows only the first - so a Gitea pull request
   * arrived with no number and was dropped entirely, silently, which is how the
   * first version of this passed its own tests and imported nothing.
   *
   * Translated once here rather than branched on at every use, the same way the
   * per-review comments are given a `pull_request_url` above.
   */
  const items = page.items.map(raw => ({ ...(raw as any), number: pullNumber(raw) }))

  for (const raw of items) {
    const pull = mapPull(raw, linked)

    if (!pull)
      continue

    const number = Number(raw.number) || pull.number

    const values = {
      ...pullRow(pull, context.repositoryId),
      number,
      body: rewriteReferences(String(pull.body ?? ''), imported),
    }

    const existing = await db
      .selectFrom('pull_requests')
      .select(['id'])
      .where('repository_id', '=', context.repositoryId)
      .where('number', '=', number)
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
  const page = FORGES[context.forge].hasRepositoryWideReviewComments
    ? await context.client.reviewComments(context.owner, context.name)
    : await reviewCommentsPerPull(context)

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

    const pull = await db
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

      const existing = await db
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
        const seen = await db
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
 * Review comments gathered a pull request at a time.
 *
 * For Gitea and Forgejo, which have no repository-wide list. Each comment is
 * given the `pull_request_url` shape the rest of this import reads, so the code
 * after this point does not have to know which forge it came from - one
 * translation here beats a branch at every use.
 */
async function reviewCommentsPerPull(context: StageContext): Promise<{ ok: boolean, items: any[], error: string | null }> {
  const items: any[] = []

  const pulls = await db
    .selectFrom('pull_requests')
    .select(['number'])
    .where('repository_id', '=', context.repositoryId)
    .execute()

  for (const pull of pulls) {
    const index = Number(pull.number)
    const reviews = await context.client.pullReviews(context.owner, context.name, index)

    if (!reviews.ok)
      return { ok: false, items, error: reviews.error }

    for (const review of reviews.items) {
      const comments = await context.client.reviewComments(context.owner, context.name, index, Number((review as any).id))

      if (!comments.ok)
        return { ok: false, items, error: comments.error }

      for (const comment of comments.items)
        items.push({ ...(comment as any), pull_request_url: `/pulls/${index}` })
    }
  }

  return { ok: true, items, error: null }
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

/**
 * Releases, and the files attached to them.
 *
 * The assets are the part that matters and the part that is easy to skip. A
 * release without its binary is a tag with a paragraph attached: every link in
 * a changelog, every install script, and every "download the previous version"
 * request points at a file that is no longer anywhere. Downloading them is slow
 * and worth it.
 *
 * Each asset is fetched, checksummed and stored the same way an upload through
 * the interface is, so a downloaded asset and an uploaded one are the same kind
 * of row - there is no import-only path to keep working.
 */
async function importReleases(progress: ImportProgress, context: StageContext): Promise<void> {
  const page = await context.client.releases(context.owner, context.name)

  if (!page.ok)
    throw new Error(page.error ?? 'the releases could not be read')

  const linked = await linkMapFor(page.items.map(raw => (raw as any).author), context)
  const imported = await importedRepositories()

  for (const raw of page.items) {
    const tag = String((raw as any).tag_name ?? '').trim()

    if (!tag)
      continue

    const login = String((raw as any).author?.login ?? '').toLowerCase()

    const values = {
      repository_id: context.repositoryId,
      tag_name: tag,
      /*
       * The framework's own columns on this table, filled in rather than left
       * null - `version` is not null, and a release's version *is* its tag.
       * `ManageReleaseAction` writes exactly these, and an imported release
       * that skipped them would be a row the dashboard renders differently
       * from one published here.
       */
      version: tag.slice(0, 50),
      status: (raw as any).draft ? 'draft' : 'published',
      name: String((raw as any).name ?? tag),
      notes: rewriteReferences(String((raw as any).body ?? ''), imported),
      is_prerelease: Boolean((raw as any).prerelease),
      target_sha: String((raw as any).target_commitish ?? '') || null,
      published_at: (raw as any).published_at ? String((raw as any).published_at) : null,
      user_id: linked.get(login) ?? null,
      // `releases.author` is a plain string on this table, so an unmapped
      // author is recorded there rather than lost - the same rule as everywhere
      // else, using the column this table happens to have.
      author: String((raw as any).author?.login ?? '') || null,
    }

    // Keyed on the tag, which is the release's identity everywhere: in git, in
    // a changelog, and in every url that points at it.
    const existing = await db
      .selectFrom('releases')
      .select(['id'])
      .where('repository_id', '=', context.repositoryId)
      .where('tag_name', '=', tag)
      .executeTakeFirst()

    const releaseId = existing
      ? Number(existing.id)
      : Number((await db.insertInto('releases').values(values as any).returning(['id']).executeTakeFirst())?.id)

    if (existing)
      await db.updateTable('releases').set(values as any).where('id', '=', releaseId).execute()
    else
      record(progress, 'releases')

    for (const asset of (raw as any).assets ?? [])
      await importAsset(progress, releaseId, asset, context)
  }
}

/**
 * One file from a release, downloaded and stored.
 *
 * Skipped rather than fatal when it fails. A release with nine of its ten
 * assets is worth having, and a migration that stopped on a single 404 from a
 * file somebody deleted upstream years ago would never finish - the problem is
 * recorded so an operator can fetch it by hand.
 */
async function importAsset(progress: ImportProgress, releaseId: number, asset: any, context: StageContext): Promise<void> {
  const name = String(asset?.name ?? '').trim()
  const url = String(asset?.browser_download_url ?? asset?.url ?? '')

  if (!name || !url)
    return

  const existing = await db
    .selectFrom('release_assets')
    .select(['id'])
    .where('release_id', '=', releaseId)
    .where('name', '=', name)
    .executeTakeFirst()

  if (existing)
    return

  try {
    const answer = await fetch(url, { headers: { Accept: 'application/octet-stream' } })

    if (!answer.ok)
      throw new Error(`the download answered ${answer.status}`)

    const bytes = new Uint8Array(await answer.arrayBuffer())

    const { assetPath, checksumOf, decideAsset, newAssetKey } = await import('../Actions/Release/assets')
    const decision = decideAsset(name, bytes.byteLength)

    if (!decision.ok)
      throw new Error(decision.error)

    const key = newAssetKey()
    const path = assetPath(key)

    if (!path)
      throw new Error('the asset key did not resolve to a path')

    await mkdir(dirname(path), { recursive: true })
    await Bun.write(path, bytes)

    await db.insertInto('release_assets').values({
      release_id: releaseId,
      name: decision.name,
      storage_path: path,
      content_type: String(asset?.content_type ?? 'application/octet-stream'),
      size_bytes: bytes.byteLength,
      checksum: checksumOf(bytes),
      download_count: 0,
    }).execute()

    record(progress, 'assets')
  }
  catch (error) {
    noteProblem(progress, `${context.owner}/${context.name} ${name}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** Accounts that linked a GitHub identity themselves, which outranks any guess. */
async function linkedAccounts(): Promise<Map<string, number>> {
  const map = new Map<string, number>()

  try {
    const rows = await db.selectFrom('users').select(['id', 'github_username']).whereNotNull('github_username').execute()

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

  try {
    const rows = await db.selectFrom('users').select(['id', 'handle', 'email']).execute()

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
  const map = new Map<string, string>()

  try {
    const rows = await db
      .selectFrom('repository_mirrors')
      .select(['remote_owner', 'remote_name', 'repository_id'])
      .execute()

    for (const row of rows) {
      const repository = await db
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
  const table = String(repository.owner_type) === 'organization' ? 'organizations' : 'users'

  const row = await db
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

  try {
    const rows = await db
      .selectFrom('issues')
      .select(['number'])
      .where('repository_id', '=', repositoryId)
      .execute()

    const pulls = await db
      .selectFrom('pull_requests')
      .select(['number'])
      .where('repository_id', '=', repositoryId)
      .execute()

    const highest = [...rows, ...pulls].reduce((top, row) => Math.max(top, Number(row.number) || 0), 0)

    const current = await db
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

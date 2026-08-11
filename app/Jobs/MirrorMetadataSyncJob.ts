import { dispatch } from '@stacksjs/events'
import { Job } from '@stacksjs/queue'
import { GitHubClient } from '../Actions/Mirror/github-client'
import type { MappedIssue, MappedPull } from '../Actions/Mirror/github'
import { buildThreads, mapIssue, mapLabel, mapPull, mapRepository, mapReviewComment, onlyIssues } from '../Actions/Mirror/github'
import {
  issueRow,
  metadataBackoffSeconds,
  pullNumberOf,
  pullRow,
  planByExternalId,
  planByNumber,
  reviewCommentRow,
  threadRow,
} from '../Actions/Mirror/metadata'
import { recountOpenIssues } from '../Actions/Repo/counters'

/**
 * Import a mirrored repository's issues, pull requests and review threads.
 *
 * Separate from `MirrorSyncJob` because the two cost differently and fail
 * differently. Commits come from one `git fetch`; metadata is many API calls
 * against a rate limit shared by every mirror using the same token. Folding
 * them together would mean a rate limit on the backlog stopped the commits from
 * updating, and would make the repository page say the mirror is broken when
 * only half of it is.
 *
 * The import is one-way. A mirror is a view of somewhere else, and writing
 * local review state back upstream is a different feature with a different set
 * of ways to go wrong.
 */
export default new Job({
  name: 'MirrorMetadataSync',
  description: 'Import issues, pull requests and review threads from the upstream host',
  queue: 'mirrors',
  tries: 2,
  backoff: 120,

  async handle(payload: { mirrorId: number }) {
    const mirrorId = Number(payload?.mirrorId)
    if (!Number.isFinite(mirrorId))
      return { ok: false, reason: 'no mirror id' }

    const mirror: any = await db
      .selectFrom('repository_mirrors')
      .selectAll()
      .where('id', '=', mirrorId)
      .executeTakeFirst()

    if (!mirror)
      return { ok: false, reason: 'mirror not found' }

    if (!mirror.enabled || !mirror.sync_metadata)
      return { ok: false, reason: 'metadata sync not enabled' }

    if (String(mirror.provider ?? '') !== 'github')
      return { ok: false, reason: `no metadata importer for ${mirror.provider}` }

    const owner = String(mirror.remote_owner ?? '')
    const name = String(mirror.remote_name ?? '')
    if (!owner || !name)
      return { ok: false, reason: 'mirror does not name a remote repository' }

    const repositoryId = Number(mirror.repository_id)
    const client = new GitHubClient({ token: await resolveToken(mirror.credential_ref) })

    // Who upstream maps to a local user. Read once: the alternative is a query
    // per row, and an import of two thousand issues would spend longer in the
    // database than on the network.
    const linked = await linkedAccounts()

    const issuesResult = await client.issues(owner, name)
    const pullsResult = await client.pulls(owner, name)
    const commentsResult = await client.reviewComments(owner, name)

    // A partial import is still worth writing. Whatever came back is real, and
    // discarding it because a later page failed means starting from nothing
    // next time and hitting the same limit at the same place.
    const failure = [issuesResult, pullsResult, commentsResult].find(r => !r.ok)

    const issues = onlyIssues(issuesResult.items)
      .map(item => mapIssue(item, linked))
      .filter((item): item is NonNullable<typeof item> => item !== null)

    const pulls = pullsResult.items
      .map(item => mapPull(item, linked))
      .filter((item): item is NonNullable<typeof item> => item !== null)

    const written = {
      issues: await writeIssues(issues, repositoryId),
      pulls: await writePulls(pulls, repositoryId),
      threads: await writeReviewThreads(commentsResult.items, repositoryId, linked),
      /*
       * The repository's own fields, and the labels and milestones under it.
       *
       * After the issues rather than before, because a label only matters once
       * something wears it, and a failure here must not cost the import that
       * did land. `client.repository()` answers null rather than throwing for
       * the same reason: a mirror whose git data and issues arrived and whose
       * description did not is a working mirror with a stale sentence.
       */
      repository: await writeRepositoryMetadata(client, owner, name, repositoryId),
      labels: await writeLabels(client, owner, name, repositoryId),
    }

    // A sync is the largest single change to a repository's issue count there
    // is - a mirror arrives with hundreds at once, and the upstream closes
    // some of them between one run and the next. Without this the repository
    // read `0 open issues` no matter how many it had just imported.
    await recountOpenIssues(repositoryId)

    if (failure) {
      const failures = Number(mirror.metadata_failure_count ?? 0) + 1

      await db
        .updateTable('repository_mirrors')
        .set({
          metadata_error: failure.error,
          metadata_failure_count: failures,
          // The successful part still counts as progress, so the timestamp
          // moves. Without it a mirror that always fails on its last page would
          // re-import everything before it on every single sweep.
          last_metadata_sync_at: new Date().toISOString(),
        })
        .where('id', '=', mirrorId)
        .execute()

      dispatch('mirror:metadata-failed', { mirrorId, repositoryId, error: failure.error, written })

      return {
        ok: false,
        reason: failure.error,
        written,
        retryInSeconds: metadataBackoffSeconds(failures),
      }
    }

    await db
      .updateTable('repository_mirrors')
      .set({ last_metadata_sync_at: new Date().toISOString(), metadata_error: null, metadata_failure_count: 0 })
      .where('id', '=', mirrorId)
      .execute()

    dispatch('mirror:metadata-synced', { mirrorId, repositoryId, written })

    return { ok: true, written }
  },
})

/**
 * GitHub logins mapped to local user ids, lowercased.
 *
 * Only accounts a user has actually linked appear here. An unlinked login is
 * shown by name and attributed to nobody: two people with the same handle on
 * two hosts is ordinary, and putting words in someone's mouth is not a bug you
 * can apologise your way out of.
 */
async function linkedAccounts(): Promise<Map<string, number>> {
  const rows: any[] = await db
    .selectFrom('users')
    .select(['id', 'github_username'])
    // `whereNotNull` rather than `where(col, 'is not', null)`: the latter binds
    // the null as a parameter and Postgres rejects `IS NOT $1`.
    .whereNotNull('github_username')
    .execute()

  const map = new Map<string, number>()
  for (const row of rows) {
    const login = String(row.github_username ?? '').trim().toLowerCase()
    if (login) map.set(login, Number(row.id))
  }
  return map
}

/**
 * The token for a mirror, by reference.
 *
 * The mirror row stores a name, never a secret: a token copied into the
 * database is a token in every backup and every dump anyone takes of it.
 */
/**
 * The token this mirror uses, from the shared resolver.
 *
 * Delegated rather than duplicated. This function and the git fetch each had
 * their own idea of where a credential comes from - except the git one had none
 * at all - and one implementation is what stops them drifting again. It also
 * gains the `_FILE` form for free, which is what an operator with a secret
 * manager already produces.
 */
async function resolveToken(credentialRef: string | null | undefined): Promise<string | null> {
  const { mirrorToken } = await import('../Actions/Mirror/credentials')

  return await mirrorToken(credentialRef)
}

async function writeIssues(present: MappedIssue[], repositoryId: number) {
  if (present.length === 0) return { created: 0, updated: 0 }

  const rows: any[] = await db
    .selectFrom('issues')
    .select(['id', 'number'])
    .where('repository_id', '=', repositoryId)
    .where('is_pull_request', '=', false)
    .execute()

  const existing = new Map(rows.map(r => [Number(r.number), { id: Number(r.id) }]))
  const plan = planByNumber(present, existing)

  for (const item of plan.create)
    await db.insertInto('issues').values(issueRow(item, repositoryId) as any).execute()

  for (const { id, incoming } of plan.update)
    await db.updateTable('issues').set(issueRow(incoming, repositoryId) as any).where('id', '=', id).execute()

  return { created: plan.create.length, updated: plan.update.length }
}

async function writePulls(present: MappedPull[], repositoryId: number) {
  if (present.length === 0) return { created: 0, updated: 0 }

  const rows: any[] = await db
    .selectFrom('pull_requests')
    .select(['id', 'number'])
    .where('repository_id', '=', repositoryId)
    .execute()

  const existing = new Map(rows.map(r => [Number(r.number), { id: Number(r.id) }]))
  const plan = planByNumber(present, existing)

  for (const item of plan.create)
    await db.insertInto('pull_requests').values(pullRow(item, repositoryId) as any).execute()

  for (const { id, incoming } of plan.update)
    await db.updateTable('pull_requests').set(pullRow(incoming, repositoryId) as any).where('id', '=', id).execute()

  return { created: plan.create.length, updated: plan.update.length }
}

/**
 * Import review comments as threads hanging off their pull requests.
 *
 * Threads are rebuilt rather than read: GitHub models one as a root comment
 * plus replies pointing at it, and the shape only exists once those pointers
 * are followed.
 */
async function writeReviewThreads(
  rawComments: any[],
  repositoryId: number,
  linked: Map<string, number>,
) {
  if (rawComments.length === 0) return { created: 0, updated: 0 }

  const pullRows: any[] = await db
    .selectFrom('pull_requests')
    .select(['id', 'number'])
    .where('repository_id', '=', repositoryId)
    .execute()

  const pullIdByNumber = new Map(pullRows.map(r => [Number(r.number), Number(r.id)]))

  // Group by pull request first, because a thread never spans two of them and
  // building threads across the whole repository at once would let a reply id
  // collide with a root id from a different conversation.
  const byPull = new Map<number, any[]>()
  for (const raw of rawComments) {
    const number = pullNumberOf(raw)
    if (number === null) continue

    const pullId = pullIdByNumber.get(number)
    // A comment on a pull request that was not imported has nowhere to hang.
    // It is skipped rather than dropped silently: the next sync, once the pull
    // request is in, picks it up.
    if (pullId === undefined) continue

    const list = byPull.get(pullId) ?? []
    list.push(raw)
    byPull.set(pullId, list)
  }

  let created = 0
  let updated = 0

  for (const [pullId, raws] of byPull) {
    const mapped = raws
      .map(raw => mapReviewComment(raw, linked))
      .filter((c): c is NonNullable<typeof c> => c !== null)

    for (const thread of buildThreads(mapped)) {
      const row = threadRow(thread, pullId)
      if (!row) continue

      const existingThread: any = await db
        .selectFrom('review_threads')
        .select(['id'])
        .where('external_id', '=', row.external_id as number)
        .executeTakeFirst()

      let threadId: number
      if (existingThread) {
        threadId = Number(existingThread.id)
        await db.updateTable('review_threads').set(row as any).where('id', '=', threadId).execute()
      }
      else {
        const inserted: any = await db
          .insertInto('review_threads')
          .values(row as any)
          .returning(['id'])
          .executeTakeFirst()
        threadId = Number(inserted?.id)
      }

      if (!Number.isFinite(threadId)) continue

      const commentRows: any[] = await db
        .selectFrom('review_comments')
        .select(['id', 'external_id'])
        .where('review_thread_id', '=', threadId)
        .execute()

      const existing = new Map(
        commentRows
          .filter(r => r.external_id !== null)
          .map(r => [Number(r.external_id), { id: Number(r.id) }]),
      )

      const plan = planByExternalId(thread, existing)

      for (const comment of plan.create) {
        await db.insertInto('review_comments').values(reviewCommentRow(comment, threadId) as any).execute()
        created++
      }

      for (const { id, incoming } of plan.update) {
        await db
          .updateTable('review_comments')
          .set(reviewCommentRow(incoming, threadId) as any)
          .where('id', '=', id)
          .execute()
        updated++
      }
    }
  }

  return { created, updated }
}

/**
 * The repository's description, topics, visibility and default branch.
 *
 * **Only fields the mirror owns.** A repository that is a mirror is a copy, so
 * upstream is authoritative for what it says about itself - but overwriting
 * `name` would move its URL under readers who have it bookmarked, and
 * overwriting `visibility` upward would publish a repository somebody
 * deliberately made private here. Visibility follows upstream only in the safe
 * direction: public upstream never forces public here.
 *
 * Returns what changed rather than a boolean, so a sync that adjusted nothing
 * reads as such in the job's result instead of as a write that happened.
 */
async function writeRepositoryMetadata(
  client: GitHubClient,
  owner: string,
  name: string,
  repositoryId: number,
): Promise<{ updated: string[] }> {
  const mapped = mapRepository(await client.repository(owner, name))
  if (!mapped)
    return { updated: [] }

  const current: any = await db
    .selectFrom('repositories')
    .select(['id', 'description', 'visibility', 'default_branch', 'is_archived'])
    .where('id', '=', repositoryId)
    .executeTakeFirst()

  if (!current)
    return { updated: [] }

  const changes: Record<string, unknown> = {}

  if (mapped.description !== String(current.description ?? ''))
    changes.description = mapped.description

  /*
   * The default branch follows upstream, which is the point of this box: a
   * repository that renamed `master` to `main` shows the wrong branch here
   * forever otherwise, and every link into the code browser lands on a ref
   * that no longer moves.
   */
  if (mapped.defaultBranch && mapped.defaultBranch !== String(current.default_branch ?? ''))
    changes.default_branch = mapped.defaultBranch

  if (mapped.archived !== Boolean(current.is_archived))
    changes.is_archived = mapped.archived

  /*
   * Private upstream makes it private here. The reverse is deliberately not
   * done: somebody may have mirrored a public repository into a private one on
   * purpose, and a sync that publishes it because upstream is public would be
   * a disclosure performed by a background job.
   */
  if (mapped.visibility === 'private' && String(current.visibility) !== 'private')
    changes.visibility = 'private'

  if (Object.keys(changes).length > 0) {
    await db
      .updateTable('repositories')
      .set(changes)
      .where('id', '=', repositoryId)
      .execute()
  }

  await writeTopics(mapped.topics, repositoryId)

  return { updated: Object.keys(changes) }
}

/**
 * Topics, as the set upstream has.
 *
 * Replaced rather than merged, because topics are a set and a topic removed
 * upstream should disappear here - the alternative is a mirror that only ever
 * accumulates, and a repository that was once tagged `deprecated` wearing it
 * forever.
 */
async function writeTopics(topics: string[], repositoryId: number): Promise<void> {
  const existing: any[] = await db
    .selectFrom('repo_topics')
    .select(['id', 'topic'])
    .where('repository_id', '=', repositoryId)
    .execute()

  const have = new Set(existing.map(row => String(row.topic)))
  const want = new Set(topics)

  const gone = existing.filter(row => !want.has(String(row.topic))).map(row => Number(row.id))
  if (gone.length > 0)
    await db.deleteFrom('repo_topics').where('id', 'in', gone).execute()

  for (const topic of topics) {
    if (have.has(topic))
      continue

    try {
      await db.insertInto('repo_topics').values({ repository_id: repositoryId, topic }).execute()
    }
    catch {
      // The unique index on (repository_id, topic) is the authority. A race
      // with another sync of the same repository is not worth failing over.
    }
  }
}

/**
 * Labels, matched by name.
 *
 * Name rather than upstream id, because a label's identity here *is* its name -
 * that is what an issue references and what a reader filters by. Matching on id
 * would create a second `bug` the first time somebody recreated it upstream.
 *
 * Nothing is deleted, for the reason `planByNumber` gives: a label removed
 * upstream is usually still worn by issues here, and removing it would strip
 * them to tidy up.
 */
async function writeLabels(
  client: GitHubClient,
  owner: string,
  name: string,
  repositoryId: number,
): Promise<{ created: number, updated: number }> {
  const result = await client.labels(owner, name)

  const incoming = result.items
    .map(item => mapLabel(item))
    .filter((item): item is NonNullable<typeof item> => item !== null)

  if (incoming.length === 0)
    return { created: 0, updated: 0 }

  const existing: any[] = await db
    .selectFrom('repository_labels')
    .select(['id', 'name', 'color', 'description'])
    .where('repository_id', '=', repositoryId)
    .execute()

  const byName = new Map(existing.map(row => [String(row.name).toLowerCase(), row]))

  let created = 0
  let updated = 0

  for (const label of incoming) {
    const found = byName.get(label.name.toLowerCase())

    if (!found) {
      try {
        await db.insertInto('repository_labels').values({
          repository_id: repositoryId,
          name: label.name,
          color: label.color,
          description: label.description,
        }).execute()
        created++
      }
      catch {
        // Raced with another sync. The row exists either way, which is the
        // desired state.
      }
      continue
    }

    if (String(found.color) === label.color && String(found.description ?? '') === label.description)
      continue

    await db
      .updateTable('repository_labels')
      .set({ color: label.color, description: label.description })
      .where('id', '=', Number(found.id))
      .execute()

    updated++
  }

  return { created, updated }
}

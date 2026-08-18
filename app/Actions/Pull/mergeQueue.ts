/**
 * The merge queue: what lands next, and what happens when it does not.
 *
 * "Green on my branch" and "green after everything ahead of me lands" are
 * different questions, and only the second one decides whether main works. Two
 * pull requests that each pass alone and break together are the ordinary case
 * rather than the exotic one - a renamed function and a new caller of it will
 * do it - and a forge that merges on the first answer breaks main regularly and
 * blames whoever pushed last.
 *
 * So an entry is tested against the **prospective merge result**: the base
 * branch with everything ahead of it already merged, plus this one. That is the
 * commit that will exist if it lands, and anything else is a commit nobody will
 * ever have.
 *
 * The decisions in this file, all of them pure, because each is one somebody
 * will read off a queue screen and check against what happened.
 */

export type EntryState = 'queued' | 'testing' | 'merged' | 'ejected'

/**
 * One pull request waiting to land.
 *
 * Named `MergeQueueEntry` rather than `QueueEntry` because `Pull/queue.ts` -
 * the *review* queue, "what is waiting on you" - already owns that name, and
 * two `QueueEntry` types in one directory is the sort of thing that reads fine
 * until somebody imports the wrong one.
 */
export interface MergeQueueEntry {
  id: number
  pullRequestId: number
  position: number
  state: EntryState
  mergeSha?: string
}

/**
 * Which entry should be tested next.
 *
 * The lowest position that is still waiting, and **only when nothing is being
 * tested**. Testing two at once is possible and deliberately not done here:
 * speculative parallel testing doubles the machine cost to save latency, and
 * doing it before anybody has asked would be paying for a problem this
 * instance's users have not reported.
 */
export function nextToTest(entries: readonly MergeQueueEntry[]): MergeQueueEntry | null {
  if (entries.some(entry => entry.state === 'testing'))
    return null

  const waiting = entries
    .filter(entry => entry.state === 'queued')
    .sort((left, right) => left.position - right.position)

  return waiting[0] ?? null
}

export interface EjectOutcome {
  /** The entry that failed and is leaving the queue. */
  ejected: MergeQueueEntry
  /**
   * Entries behind it that must be tested again.
   *
   * Everything behind a failure was tested on top of a commit that is not
   * going to exist, so their green is about a history nobody will have. Not
   * re-testing them is how a merge queue lands the thing that breaks main -
   * and re-testing is exactly what people pay a queue for.
   */
  requeue: MergeQueueEntry[]
}

/**
 * What a failing entry does to the rest of the queue.
 *
 * The failure leaves; the entries behind it go back to `queued` and are tested
 * again on the new prospective result. Their position is kept, so the order
 * people were told is the order that happens - a queue that reshuffles on a
 * failure is one nobody can plan around.
 */
export function ejectFailure(entries: readonly MergeQueueEntry[], failed: MergeQueueEntry): EjectOutcome {
  const behind = entries
    .filter(entry => entry.position > failed.position && (entry.state === 'queued' || entry.state === 'testing'))
    .sort((left, right) => left.position - right.position)

  return { ejected: failed, requeue: behind }
}

/**
 * Where a new entry goes.
 *
 * The end, always. A queue with a priority lane is a queue where the important
 * change waits behind three important changes, and "important" is decided by
 * whoever is most annoyed.
 */
export function nextPosition(entries: readonly MergeQueueEntry[]): number {
  return entries.reduce((highest, entry) => Math.max(highest, entry.position), 0) + 1
}

/**
 * The base an entry is tested on: what is already merged ahead of it.
 *
 * The last entry ahead that has a prospective merge commit, or the branch tip
 * when there is none. This is the speculative part - entry three is tested on
 * top of entries one and two as though they had landed - and it is what makes
 * the queue faster than merging one at a time and waiting.
 */
export function baseFor(entries: readonly MergeQueueEntry[], entry: MergeQueueEntry, branchTip: string): string {
  const ahead = entries
    .filter(one => one.position < entry.position && one.mergeSha && one.state !== 'ejected')
    .sort((left, right) => right.position - left.position)

  return ahead[0]?.mergeSha || branchTip
}

/**
 * Whether a queue is stuck rather than busy.
 *
 * An entry that has been testing since before `since` is one whose run died
 * without reporting, and the queue behind it is waiting on a machine that is
 * never coming back. Said as a question rather than acted on here: what to do
 * about it - eject, re-test, tell somebody - is a policy, and this is the
 * observation it needs.
 */
export function stalled(entries: readonly MergeQueueEntry[], startedAt: Map<number, Date>, since: Date): MergeQueueEntry[] {
  return entries.filter((entry) => {
    if (entry.state !== 'testing')
      return false

    const started = startedAt.get(entry.id)

    return Boolean(started && started < since)
  })
}

/*
 * Everything below touches the database and the repository on disk. The rules
 * above are pure because they are the part somebody will read off a queue
 * screen and check against what happened; these are the writes that carry them
 * out.
 */

import { db } from '@stacksjs/database'
import { runGit } from '../Git/git'
import { repositoryPath } from '../Git/storage'
import { performMerge } from './apply'

/** The queue for one branch, in landing order. */
export async function queueFor(repositoryId: number, baseBranch: string): Promise<MergeQueueEntry[]> {
  const rows = await db
    .selectFrom('merge_queue_entries')
    .select(['id', 'pull_request_id', 'position', 'state', 'merge_sha'])
    .where('repository_id', '=', repositoryId)
    .where('base_branch', '=', baseBranch)
    .where('state', 'in', ['queued', 'testing'])
    .orderBy('position', 'asc')
    .execute()
    .catch(() => [])

  return rows.map(row => ({
    id: Number(row.id),
    pullRequestId: Number(row.pull_request_id),
    position: Number(row.position ?? 0),
    state: String(row.state) as EntryState,
    mergeSha: row.merge_sha ? String(row.merge_sha) : '',
  }))
}

export type EnqueueOutcome =
  | { ok: true, id: number, position: number }
  | { ok: false, reason: string, status: number }

/**
 * Add a pull request to the queue for its base branch.
 *
 * Refused when it is already in one, rather than added twice: two entries for
 * one pull request would each be tested, and the second would be testing a
 * change the first already landed.
 */
export async function enqueue(input: {
  repositoryId: number
  pullRequestId: number
  baseBranch: string
}): Promise<EnqueueOutcome> {
  const existing = await db
    .selectFrom('merge_queue_entries')
    .select(['id', 'state'])
    .where('pull_request_id', '=', input.pullRequestId)
    .executeTakeFirst()
    .catch(() => null)

  if (existing && ['queued', 'testing'].includes(String(existing.state)))
    return { ok: false, reason: 'That pull request is already in the queue', status: 409 }

  const entries = await queueFor(input.repositoryId, input.baseBranch)
  const position = nextPosition(entries)

  if (existing) {
    /*
     * A pull request that was ejected can rejoin, and it takes a new position
     * at the back. Keeping the old one would put a change that already failed
     * ahead of changes that have been waiting behind it.
     */
    await db
      .updateTable('merge_queue_entries')
      .set({ state: 'queued', position, merge_sha: '', reason: '', workflow_run_id: null })
      .where('id', '=', Number(existing.id))
      .execute()

    return { ok: true, id: Number(existing.id), position }
  }

  const row = await db
    .insertInto('merge_queue_entries')
    .values({
      repository_id: input.repositoryId,
      pull_request_id: input.pullRequestId,
      base_branch: input.baseBranch,
      state: 'queued',
      position,
    })
    .returning(['id'])
    .executeTakeFirst()

  return { ok: true, id: Number(row?.id ?? 0), position }
}

export type StartOutcome =
  | { ok: true, entryId: number, mergeSha: string, ref: string }
  | { ok: false, reason: string }
  | { ok: true, entryId: null, mergeSha: null, ref: null }

/**
 * Build the next entry's prospective merge commit, and put it on a ref.
 *
 * The commit is written into the repository under `refs/merge-queue/<number>`
 * so a runner can check it out like any other ref - a prospective merge that
 * exists only as an object nothing points at is one git will eventually collect
 * while the run is still using it.
 *
 * Conflicts eject immediately: a change that cannot merge onto what is ahead of
 * it is not going to become mergeable by being tested.
 */
export async function startNext(input: {
  repositoryId: number
  ownerHandle: string
  repositoryName: string
  baseBranch: string
}): Promise<StartOutcome> {
  const entries = await queueFor(input.repositoryId, input.baseBranch)
  const next = nextToTest(entries)

  if (!next)
    return { ok: true, entryId: null, mergeSha: null, ref: null }

  const resolved = repositoryPath(input.ownerHandle, input.repositoryName)

  if (!resolved.path)
    return { ok: false, reason: 'That repository has no directory on this instance' }

  const tip = await runGit(resolved.path, ['rev-parse', '--verify', `refs/heads/${input.baseBranch}`]).catch(() => null)

  if (!tip || tip.code !== 0)
    return { ok: false, reason: `\`${input.baseBranch}\` does not exist` }

  const pull = await db
    .selectFrom('pull_requests')
    .select(['number', 'head_sha', 'title'])
    .where('id', '=', next.pullRequestId)
    .executeTakeFirst()

  if (!pull)
    return { ok: false, reason: 'That pull request is gone' }

  // The speculative part: on top of what is ahead, as though it had landed.
  const base = baseFor(entries, next, tip.stdout.trim())

  const merged = await performMerge(resolved.path, {
    strategy: 'merge',
    base: input.baseBranch,
    headSha: String(pull.head_sha),
    baseSha: base,
    subject: `Merge queue: #${Number(pull.number)}`,
    body: String(pull.title ?? ''),
    authorName: 'ReviewOS merge queue',
    authorEmail: 'merge-queue@users.noreply.local',
    // The branch itself must not move: this is a prospective result, and
    // moving `main` here would land the change before it was tested.
    dryRun: true,
  })

  if (!merged.ok) {
    await db
      .updateTable('merge_queue_entries')
      .set({ state: 'ejected', reason: `Cannot merge onto what is ahead of it: ${merged.error}` })
      .where('id', '=', next.id)
      .execute()

    return { ok: false, reason: merged.error }
  }

  const ref = `refs/merge-queue/${Number(pull.number)}`

  await runGit(resolved.path, ['update-ref', ref, merged.sha]).catch(() => null)

  await db
    .updateTable('merge_queue_entries')
    .set({ state: 'testing', merge_sha: merged.sha })
    .where('id', '=', next.id)
    .execute()

  return { ok: true, entryId: next.id, mergeSha: merged.sha, ref }
}

/**
 * What a finished run does to the queue.
 *
 * Success lands the prospective commit - which is already built and already
 * tested, so landing it is moving the ref rather than merging again. Failure
 * ejects, and **everything behind goes back to the queue**: they were tested on
 * top of a commit that is not going to exist, so their green is about a history
 * nobody will have.
 */
export async function settleEntry(input: {
  entryId: number
  passed: boolean
  reason?: string
  ownerHandle: string
  repositoryName: string
}): Promise<{ ok: boolean, merged: boolean, requeued: number }> {
  const row = await db
    .selectFrom('merge_queue_entries')
    .select(['id', 'repository_id', 'pull_request_id', 'base_branch', 'position', 'state', 'merge_sha'])
    .where('id', '=', input.entryId)
    .executeTakeFirst()
    .catch(() => null)

  if (!row || String(row.state) !== 'testing')
    return { ok: false, merged: false, requeued: 0 }

  const entries = await queueFor(Number(row.repository_id), String(row.base_branch))
  const entry: MergeQueueEntry = {
    id: Number(row.id),
    pullRequestId: Number(row.pull_request_id),
    position: Number(row.position),
    state: 'testing',
    mergeSha: String(row.merge_sha ?? ''),
  }

  if (!input.passed) {
    const outcome = ejectFailure(entries, entry)

    await db
      .updateTable('merge_queue_entries')
      .set({ state: 'ejected', reason: input.reason || 'The run against the prospective merge failed.' })
      .where('id', '=', entry.id)
      .execute()

    for (const behind of outcome.requeue) {
      await db
        .updateTable('merge_queue_entries')
        .set({ state: 'queued', merge_sha: '', workflow_run_id: null })
        .where('id', '=', behind.id)
        .execute()
    }

    return { ok: true, merged: false, requeued: outcome.requeue.length }
  }

  const resolved = repositoryPath(input.ownerHandle, input.repositoryName)

  if (resolved.path && entry.mergeSha) {
    /*
     * Landing is moving the branch to the commit that was tested, guarded by
     * where it was - not merging again. Merging again would produce a
     * *different* commit from the one the run went green on, which is the
     * whole thing a merge queue exists to prevent.
     */
    const tip = await runGit(resolved.path, ['rev-parse', '--verify', `refs/heads/${String(row.base_branch)}`]).catch(() => null)

    const moved = await runGit(resolved.path, [
      'update-ref',
      `refs/heads/${String(row.base_branch)}`,
      entry.mergeSha,
      ...(tip?.code === 0 ? [tip.stdout.trim()] : []),
    ]).catch(() => null)

    if (!moved || moved.code !== 0) {
      await db
        .updateTable('merge_queue_entries')
        .set({ state: 'queued', merge_sha: '' })
        .where('id', '=', entry.id)
        .execute()

      // The branch moved under the queue - somebody pushed directly. Back in
      // the queue rather than forced: the push is not wrong, the assumption was.
      return { ok: true, merged: false, requeued: 1 }
    }

    await runGit(resolved.path, ['update-ref', '-d', `refs/merge-queue/${entry.pullRequestId}`]).catch(() => null)
  }

  await db
    .updateTable('merge_queue_entries')
    .set({ state: 'merged' })
    .where('id', '=', entry.id)
    .execute()

  await db
    .updateTable('pull_requests')
    .set({ state: 'merged', merged_at: new Date().toISOString() })
    .where('id', '=', entry.pullRequestId)
    .execute()
    .catch(() => null)

  return { ok: true, merged: true, requeued: 0 }
}

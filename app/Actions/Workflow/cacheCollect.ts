/**
 * Letting go of snapshots, by size and by age.
 *
 * A cache with no collector is a disk that fills, and the day it fills is the
 * day every job on the instance fails at once for a reason nobody connects to
 * caching. So this is not optional infrastructure - it is the half that makes
 * the other half safe to turn on.
 *
 * ## The policy is visible before it deletes anything
 *
 * The roadmap asks for exactly that, and it is a reaction to how these things
 * usually go: a cron job with the numbers inlined, which nobody can quote and
 * nobody can predict, so the first time somebody notices is when a cache they
 * were relying on is gone. Here the numbers are configuration, `prunable` is a
 * pure function anybody can call, and `buddy ci:caches` prints what the next
 * sweep would remove without removing it.
 *
 * ## Why age is measured from the last restore
 *
 * An entry a hundred runs a day reach for should outlive one written this
 * morning and never read again. Age from the write would drop the first and
 * keep the second, which is precisely backwards: what makes a cache worth its
 * disk is being restored.
 */

import process from 'node:process'

/** One entry, as much of it as a decision needs. */
export interface Collectable {
  id: number
  sizeBytes: number
  /** ISO 8601. The last restore, or the write when it has never been restored. */
  lastUsedAt: string
  scope: string
}

export interface CachePolicy {
  /** How much one repository may keep. Oldest unused go first past this. */
  maxBytesPerRepository: number
  /** How long an entry nobody restores is kept. */
  maxIdleDays: number
}

/**
 * The default policy.
 *
 * Ten gigabytes is a few snapshots of a large repository and many of an
 * ordinary one; seven days is long enough that a branch somebody returns to on
 * Monday still has its cache, and short enough that a fork's entry from a
 * merged pull request does not sit there for a quarter.
 */
export const DEFAULT_POLICY: CachePolicy = {
  maxBytesPerRepository: 10 * 1024 * 1024 * 1024,
  maxIdleDays: 7,
}

/** The policy an operator configured, or the default. */
export function cachePolicy(env: Record<string, string | undefined> = {}): CachePolicy {
  const bytes = Number(env.REVIEWOS_CACHE_MAX_BYTES)
  const days = Number(env.REVIEWOS_CACHE_MAX_IDLE_DAYS)

  return {
    maxBytesPerRepository: Number.isFinite(bytes) && bytes > 0 ? bytes : DEFAULT_POLICY.maxBytesPerRepository,
    maxIdleDays: Number.isFinite(days) && days > 0 ? days : DEFAULT_POLICY.maxIdleDays,
  }
}

export interface Verdict {
  /** What goes, in the order it would go. */
  remove: Collectable[]
  /** What stays. */
  keep: Collectable[]
  /** Bytes the removal frees. */
  freed: number
}

/**
 * What a sweep would do to one repository's entries.
 *
 * Pure, so the command that shows an operator the answer and the job that acts
 * on it cannot disagree - the usual way a "dry run" lies is by being a second
 * implementation of the real thing.
 *
 * Two rules, applied in this order:
 *
 * 1. **Idle too long goes**, whatever the total is. An entry nobody has
 *    restored in a week is one whose lockfile has almost certainly moved on.
 * 2. **Then, if what remains is over the size limit, the least recently
 *    restored go** until it fits. Least recently restored rather than oldest
 *    written, for the reason at the top of this file.
 */
export function prunable(entries: readonly Collectable[], policy: CachePolicy, now: number): Verdict {
  const idleCutoff = now - policy.maxIdleDays * 86_400_000

  const remove: Collectable[] = []
  let keep: Collectable[] = []

  for (const entry of entries) {
    const used = Date.parse(entry.lastUsedAt)

    // A date that will not parse is a row somebody edited or a version that is
    // gone. Kept rather than removed: deleting on the strength of a value this
    // cannot read is how a bug in a date format becomes a bug in somebody's
    // cache.
    if (Number.isFinite(used) && used < idleCutoff)
      remove.push(entry)
    else
      keep.push(entry)
  }

  const total = (rows: readonly Collectable[]): number => rows.reduce((sum, one) => sum + Math.max(0, one.sizeBytes), 0)

  if (total(keep) > policy.maxBytesPerRepository) {
    // Least recently restored first, so the entry every run reaches for is the
    // last one standing.
    const byAge = [...keep].sort((left, right) => Date.parse(left.lastUsedAt) - Date.parse(right.lastUsedAt))

    let held = total(keep)

    while (held > policy.maxBytesPerRepository && byAge.length > 0) {
      const going = byAge.shift()!

      remove.push(going)
      held -= Math.max(0, going.sizeBytes)
    }

    keep = byAge
  }

  return { remove, keep, freed: total(remove) }
}

/**
 * Read every repository's entries, decide, and act.
 *
 * One repository at a time rather than one query across all of them: the size
 * limit is per repository, so a global sort would let a busy repository's
 * snapshots evict a quiet one's - which is the failure where the repository
 * that pays the most for caching gets the least out of it.
 *
 * `dryRun` is the same code path with the deletes skipped, so what an operator
 * is shown and what happens next cannot drift apart.
 */
export async function collectCaches(options: { dryRun?: boolean, now?: number } = {}): Promise<{
  repositories: number
  removed: number
  freed: number
  removals: Array<{ repositoryId: number, scope: string, sizeBytes: number }>
}> {
  const { db } = await import('@stacksjs/database')
  const { blobStore } = await import('../Git/blobs')

  const policy = cachePolicy(process.env as Record<string, string | undefined>)
  const now = options.now ?? Date.now()

  const rows: any[] = await db
    .selectFrom('workflow_cache_entries')
    .select(['id', 'repository_id', 'scope', 'digest', 'blob_key', 'size_bytes', 'last_used_at', 'created_at'])
    .execute()
    .catch(() => [])

  const byRepository = new Map<number, any[]>()

  for (const row of rows) {
    const id = Number(row.repository_id)

    byRepository.set(id, [...(byRepository.get(id) ?? []), row])
  }

  const removals: Array<{ repositoryId: number, scope: string, sizeBytes: number }> = []
  let removed = 0
  let freed = 0

  for (const [repositoryId, entries] of byRepository) {
    const verdict = prunable(
      entries.map(row => ({
        id: Number(row.id),
        sizeBytes: Number(row.size_bytes ?? 0),
        // A row that has never been restored is judged from when it was
        // written, which is the only date it has.
        lastUsedAt: String(row.last_used_at ?? row.created_at ?? new Date(now).toISOString()),
        scope: String(row.scope ?? ''),
      })),
      policy,
      now,
    )

    for (const going of verdict.remove) {
      removals.push({ repositoryId, scope: going.scope, sizeBytes: going.sizeBytes })
      freed += going.sizeBytes
      removed += 1

      if (options.dryRun)
        continue

      const row = entries.find(one => Number(one.id) === going.id)

      /*
       * The row first, the bytes second - the opposite of the save.
       *
       * Saving writes bytes then row, so a crash between them leaves an
       * unreferenced snapshot this sweep collects. Deleting goes the other way
       * for the same reason: a crash between them leaves bytes nothing points
       * at, which costs disk, where the reverse would leave a row pointing at
       * nothing, which costs a restore that fails on a machine somebody is
       * waiting for.
       */
      await db.deleteFrom('workflow_cache_entries').where('id', '=', going.id).execute().catch(() => null)

      /*
       * And the bytes only when nothing else points at them.
       *
       * Snapshots are content-addressed, so two scopes whose installs are
       * identical share one file - and deleting it because one of them expired
       * would take the other's cache with it.
       */
      const key = String(row?.blob_key ?? '')

      if (!key)
        continue

      const shared: any = await db
        .selectFrom('workflow_cache_entries')
        .select(['id'])
        .where('blob_key', '=', key)
        .executeTakeFirst()
        .catch(() => null)

      if (!shared)
        await blobStore().then(store => store.delete(key)).catch(() => null)
    }
  }

  return { repositories: byRepository.size, removed, freed, removals }
}

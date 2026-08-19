/**
 * Deciding, after the fact, whether a recorded push actually happened.
 *
 * Kept apart from `wal.ts` so the rule itself is testable without a database:
 * `verdictFor` takes what the log claimed and what the repository says now,
 * and answers. Everything else here is the query around it.
 */

import { db } from '@stacksjs/database'
import { isFullSha, runGit } from './git'
import { commitPush, voidPush } from './wal'
import type { WalRefUpdate } from './wal'

export type Verdict = 'landed' | 'abandoned' | 'unknown'

/**
 * Did this ref update happen?
 *
 * - The ref points at the sha the entry says it moved to: **landed**, plainly.
 * - The repository has never heard of that sha: **abandoned**. git refused it,
 *   or it never arrived.
 * - The repository knows the sha but the ref has moved on: **landed**. A later
 *   push built on it, which is the ordinary case for anything but the newest
 *   entry, and treating it as abandoned would void most of the log.
 *
 * A deletion is the mirror: the ref being gone means it landed.
 */
export function verdictFor(update: WalRefUpdate, present: { tip: string | null, knowsAfter: boolean }): Verdict {
  const deleting = /^0{40}$/.test(update.after)

  if (deleting)
    return present.tip === null ? 'landed' : 'abandoned'

  if (!isFullSha(update.after))
    return 'unknown'

  if (present.tip === update.after)
    return 'landed'

  // Known object, ref elsewhere: something landed on top of it.
  if (present.knowsAfter)
    return 'landed'

  return 'abandoned'
}

/**
 * The whole entry's verdict from its updates'.
 *
 * A push is atomic, so a mixed answer is not "half landed" - it is a state
 * nothing should act on automatically. `unknown` leaves the row pending for a
 * person to look at, which is the honest outcome for something that should be
 * impossible.
 */
export function entryVerdict(verdicts: readonly Verdict[]): Verdict {
  if (verdicts.length === 0)
    return 'unknown'

  if (verdicts.every(verdict => verdict === 'landed'))
    return 'landed'

  if (verdicts.every(verdict => verdict === 'abandoned'))
    return 'abandoned'

  return 'unknown'
}

export interface ReconcileOutcome {
  examined: number
  committed: number
  voided: number
  unresolved: number
}

/**
 * Sweep pending entries older than a grace window.
 *
 * The window matters: a push in flight right now is legitimately pending, and
 * a sweep with no grace would void entries whose post-receive has not run yet.
 */
export async function reconcilePending(options: { olderThanMinutes?: number } = {}): Promise<ReconcileOutcome> {
  const grace = new Date(Date.now() - Math.max(0, options.olderThanMinutes ?? 10) * 60_000).toISOString()

  const rows: any[] = await db
    .selectFrom('git_wal_entries')
    .select(['id', 'repository_id', 'updates', 'created_at'])
    .where('status', '=', 'pending')
    .where('created_at', '<', grace as any)
    .orderBy('created_at', 'asc')
    .limit(500)
    .execute()
    .catch(() => [])

  const outcome: ReconcileOutcome = { examined: 0, committed: 0, voided: 0, unresolved: 0 }
  const paths = new Map<number, string | null>()

  for (const row of rows) {
    outcome.examined += 1

    const repositoryId = Number(row.repository_id)

    if (!paths.has(repositoryId))
      paths.set(repositoryId, await pathFor(repositoryId))

    const path = paths.get(repositoryId) ?? null

    if (!path) {
      // No repository on this node. Not a verdict: phase 18c makes a missing
      // repository an ordinary state that gets materialized, and voiding the
      // log because the cache is cold would destroy the thing it is
      // materialized from.
      outcome.unresolved += 1

      continue
    }

    const updates = parse(row.updates)
    const verdicts: Verdict[] = []

    for (const update of updates)
      verdicts.push(verdictFor(update, await observe(path, update)))

    const verdict = entryVerdict(verdicts)

    if (verdict === 'landed') {
      await commitPush(Number(row.id))
      outcome.committed += 1
    }
    else if (verdict === 'abandoned') {
      await voidPush(Number(row.id), 'the refs on disk never carried this push')
      outcome.voided += 1
    }
    else {
      outcome.unresolved += 1
    }
  }

  return outcome
}

/** What the repository says about one ref right now. */
async function observe(path: string, update: WalRefUpdate): Promise<{ tip: string | null, knowsAfter: boolean }> {
  const tip = await runGit(path, ['rev-parse', '--verify', `${update.ref}^{commit}`], { priority: 'background' })
  const known = isFullSha(update.after)
    ? await runGit(path, ['cat-file', '-e', `${update.after}^{commit}`], { priority: 'background' })
    : { ok: false }

  return {
    tip: tip.ok ? tip.stdout.trim() : null,
    knowsAfter: known.ok,
  }
}

async function pathFor(repositoryId: number): Promise<string | null> {
  const row: any = await db
    .selectFrom('repositories')
    .select(['name', 'owner_type', 'owner_id'])
    .where('id', '=', repositoryId)
    .executeTakeFirst()
    .catch(() => null)

  if (!row)
    return null

  const table = String(row.owner_type) === 'organization' ? 'organizations' : 'users'
  const owner: any = await db
    .selectFrom(table)
    .select(['handle'])
    .where('id', '=', Number(row.owner_id))
    .executeTakeFirst()
    .catch(() => null)

  if (!owner?.handle)
    return null

  const { ensureLocal } = await import('./storage')
  const local = await ensureLocal(String(owner.handle), String(row.name))

  return local.ok ? local.path! : null
}

function parse(raw: unknown): WalRefUpdate[] {
  try {
    const parsed = JSON.parse(String(raw ?? '[]'))

    return Array.isArray(parsed) ? parsed : []
  }
  catch {
    return []
  }
}

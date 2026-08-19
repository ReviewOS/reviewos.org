/**
 * The ref ledger, and the compare-and-swap that moves it.
 *
 * Phase 18c: the database becomes the truth about where a repository's refs
 * point, and disk becomes a cache of that. `update-ref` follows this, never
 * leads it.
 *
 * ## The atomicity argument, written down because it is unusual
 *
 * There is no advisory lock here (phase 17's design forbids them) and no
 * multi-statement transaction (this codebase's query builder exposes none).
 * What there is instead:
 *
 * - **The write-ahead log's unique `(repository_id, sequence)`** is the
 *   linearization point. Whoever wins that insert owns the right to apply its
 *   ref transaction, and the loser retries with a new sequence.
 * - **Each ref moves by a conditional update** - `SET sha = :after WHERE
 *   repository_id = :id AND ref = :ref AND sha = :before` - which is atomic on
 *   its own on every engine, and which a writer with a stale view simply
 *   loses.
 *
 * What this does *not* give is all-or-nothing across the refs of one push. A
 * process that dies mid-apply leaves some refs moved and some not, and the
 * answer to that is the same as everywhere else in this phase: **the WAL row
 * is the truth and the ledger is an index of it**, so the drift audit finishes
 * or reports what the crash left. Phase 17's per-repo `GET_LOCK` upgrades this
 * to all-or-nothing when it lands; nothing here has to change for that.
 */

import { db } from '@stacksjs/database'
import { isFullSha, runGit } from './git'
import type { WalRefUpdate } from './wal'

export const ZERO_SHA = '0'.repeat(40)

export interface LedgerEntry {
  ref: string
  sha: string
  sequence: number
}

/** Whether an update is a deletion rather than a move. */
export function isDeletion(update: { after: string }): boolean {
  return update.after === ZERO_SHA || !update.after
}

/** Whether an update creates a ref that did not exist. */
export function isCreation(update: { before: string }): boolean {
  return update.before === ZERO_SHA || !update.before
}

export type RefOutcome = 'applied' | 'conflicted' | 'rejected'

export interface RefResult {
  ref: string
  outcome: RefOutcome
  /** What the ledger held when a conflict was detected, for the message. */
  held?: string | null
}

/**
 * Whether a ref transaction is one this application will attempt at all.
 *
 * Pure, and checked before anything is written: a sha that is not a sha, or a
 * ref name git would not accept, is a bug or an attempt rather than a race,
 * and it should be refused with a reason rather than turned into a conflict
 * nobody can explain.
 */
export function acceptable(update: WalRefUpdate): boolean {
  if (!update.ref.startsWith('refs/') || update.ref.includes('..') || update.ref.includes(' '))
    return false

  const beforeOk = isCreation(update) || isFullSha(update.before)
  const afterOk = isDeletion(update) || isFullSha(update.after)

  return beforeOk && afterOk
}

/** The whole ledger for a repository. */
export async function ledgerFor(repositoryId: number): Promise<LedgerEntry[]> {
  const rows: any[] = await db
    .selectFrom('git_refs')
    .select(['ref', 'sha', 'sequence'])
    .where('repository_id', '=', repositoryId)
    .execute()
    .catch(() => [])

  return rows.map(row => ({
    ref: String(row.ref),
    sha: String(row.sha),
    sequence: Number(row.sequence ?? 0),
  }))
}

/**
 * Apply one push's refs to the ledger, each by compare-and-swap.
 *
 * The caller has already won its sequence, so this is not a race for the right
 * to write - it is a check that the world still looks the way the push assumed
 * when it was accepted. A ref that moved underneath comes back `conflicted`
 * and is not written.
 */
export async function applyToLedger(
  repositoryId: number,
  updates: readonly WalRefUpdate[],
  sequence: number,
): Promise<RefResult[]> {
  const results: RefResult[] = []

  for (const update of updates) {
    if (!acceptable(update)) {
      results.push({ ref: update.ref, outcome: 'rejected' })

      continue
    }

    results.push(await applyOne(repositoryId, update, sequence))
  }

  return results
}

async function applyOne(repositoryId: number, update: WalRefUpdate, sequence: number): Promise<RefResult> {
  const existing: any = await db
    .selectFrom('git_refs')
    .select(['id', 'sha'])
    .where('repository_id', '=', repositoryId)
    .where('ref', '=', update.ref)
    .executeTakeFirst()
    .catch(() => null)

  const held = existing ? String(existing.sha) : null

  if (isDeletion(update)) {
    if (!existing)
      return { ref: update.ref, outcome: isCreation(update) ? 'applied' : 'conflicted', held }

    /*
     * The compare in compare-and-swap: the delete only applies if the ledger
     * still holds what the push was accepted against. A ref that moved
     * underneath must not be deleted at its new value.
     */
    if (!isCreation(update) && held !== update.before)
      return { ref: update.ref, outcome: 'conflicted', held }

    const removed: any = await db
      .deleteFrom('git_refs')
      .where('id', '=', Number(existing.id))
      .where('sha', '=', held!)
      .execute()
      .catch(() => null)

    return { ref: update.ref, outcome: removed === null ? 'conflicted' : 'applied', held }
  }

  if (!existing) {
    // A creation, and the unique index is what makes this a compare-and-swap:
    // two nodes creating the same ref means one insert fails, and the loser
    // reports a conflict rather than overwriting.
    const created = await db
      .insertInto('git_refs')
      .values({ repository_id: repositoryId, ref: update.ref, sha: update.after, sequence } as any)
      .execute()
      .then(() => true)
      .catch(() => false)

    return { ref: update.ref, outcome: created ? 'applied' : 'conflicted', held }
  }

  if (isCreation(update))
    return { ref: update.ref, outcome: 'conflicted', held }

  if (held !== update.before)
    return { ref: update.ref, outcome: 'conflicted', held }

  /*
   * The swap, guarded by the value it was compared against.
   *
   * The `where sha = before` is not decoration: between the read above and
   * this write, another node may have moved the ref, and without the guard
   * this would overwrite it with a value derived from a stale view.
   */
  const moved = await db
    .updateTable('git_refs')
    .set({ sha: update.after, sequence } as any)
    .where('id', '=', Number(existing.id))
    .where('sha', '=', update.before)
    .execute()
    .then(() => true)
    .catch(() => false)

  return { ref: update.ref, outcome: moved ? 'applied' : 'conflicted', held }
}

/**
 * Seed the ledger from a repository on disk.
 *
 * For every repository that predates this table. The rows land at sequence
 * zero, which is deliberately visible: it says the ledger was believed from
 * disk rather than derived from the log, and a drift audit reading zero knows
 * it is comparing against something that was never linearized.
 */
export async function seedLedger(repositoryId: number, repositoryPath: string): Promise<number> {
  const listed = await runGit(repositoryPath, ['for-each-ref', '--format=%(refname) %(objectname)'], {
    priority: 'background',
  })

  if (!listed.ok)
    return 0

  let seeded = 0

  for (const line of listed.stdout.split('\n')) {
    const [ref, sha] = line.trim().split(/\s+/)

    if (!ref || !sha || !isFullSha(sha))
      continue

    const existing = await db
      .selectFrom('git_refs')
      .select(['id'])
      .where('repository_id', '=', repositoryId)
      .where('ref', '=', ref)
      .executeTakeFirst()
      .catch(() => null)

    if (existing)
      continue

    const created = await db
      .insertInto('git_refs')
      .values({ repository_id: repositoryId, ref, sha, sequence: 0 } as any)
      .execute()
      .then(() => true)
      .catch(() => false)

    if (created)
      seeded += 1
  }

  return seeded
}

export interface Divergence {
  /** In the ledger, missing or different on disk. */
  stale: Array<{ ref: string, ledger: string, disk: string | null }>
  /** On disk and not in the ledger at all. */
  extra: Array<{ ref: string, disk: string }>
}

/**
 * Compare a ledger against what a repository holds.
 *
 * Pure, so the audit's rule can be tested without a repository - and because
 * this decides whether a node is serving stale data, which is the one question
 * the whole sub-phase exists to answer.
 *
 * Refs the ledger does not track are reported as `extra` rather than deleted.
 * A repository legitimately carries refs no push created (`refs/notes`, a
 * mirror's `refs/remotes`, a stash), and a ledger that pruned them would
 * delete somebody's data to tidy an index.
 */
export function divergence(ledger: readonly LedgerEntry[], onDisk: ReadonlyMap<string, string>): Divergence {
  const stale: Divergence['stale'] = []
  const extra: Divergence['extra'] = []
  const tracked = new Set<string>()

  for (const entry of ledger) {
    tracked.add(entry.ref)
    const disk = onDisk.get(entry.ref) ?? null

    if (disk !== entry.sha)
      stale.push({ ref: entry.ref, ledger: entry.sha, disk })
  }

  for (const [ref, sha] of onDisk) {
    if (!tracked.has(ref))
      extra.push({ ref, disk: sha })
  }

  return { stale, extra }
}

/** What a repository's refs are, right now, as a map. */
export async function refsOnDisk(repositoryPath: string): Promise<Map<string, string>> {
  const listed = await runGit(repositoryPath, ['for-each-ref', '--format=%(refname) %(objectname)'], {
    priority: 'background',
  })

  const found = new Map<string, string>()

  if (!listed.ok)
    return found

  for (const line of listed.stdout.split('\n')) {
    const [ref, sha] = line.trim().split(/\s+/)

    if (ref && sha && isFullSha(sha))
      found.set(ref, sha)
  }

  return found
}

/**
 * Write the ledger's view onto disk.
 *
 * The direction that makes disk a cache: refs follow the ledger. Used by
 * materialization after a repository is rebuilt, and never by a push - a push
 * moves the ledger and lets git move its own refs.
 */
export async function writeLedgerToDisk(repositoryPath: string, ledger: readonly LedgerEntry[]): Promise<{ written: number, failed: string[] }> {
  const failed: string[] = []
  let written = 0

  for (const entry of ledger) {
    const result = await runGit(repositoryPath, ['update-ref', entry.ref, entry.sha], { priority: 'background' })

    if (result.ok)
      written += 1
    else
      failed.push(`${entry.ref}: ${result.stderr.trim().split('\n')[0]}`)
  }

  return { written, failed }
}

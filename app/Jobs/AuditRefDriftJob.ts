import { Job } from '@stacksjs/queue'
import { log } from '@stacksjs/logging'
import { db } from '@stacksjs/database'
import { divergence, ledgerFor, refsOnDisk, seedLedger } from '../Actions/Git/refs'
import { walMode } from '../../config/git-wal'

/**
 * Check what this node holds against what the database says, and say so.
 *
 * **It reports rather than repairs, and that is the whole design.** A job that
 * silently reconciled drift would erase the evidence of whatever caused it -
 * and the causes worth knowing about are all serious: a push that moved disk
 * without moving the ledger, a materialization that half-finished, two nodes
 * disagreeing about a ref. Each of those is a bug, and a repair job turns a
 * bug into a mystery that recurs.
 *
 * The exception is a repository with no ledger at all, which is not drift: it
 * predates the table. Those are seeded from disk, once, and the rows land at
 * sequence zero so anybody reading them can see the ledger was believed rather
 * than derived.
 *
 * **Sampled, not exhaustive.** A `for-each-ref` per repository across an
 * instance with ten thousand of them is an hour of git for a question that is
 * almost always answered "no". A rotating sample finds systemic drift quickly
 * and a single stale repository eventually, which is the right trade for
 * something that runs while nobody is watching.
 */
export default new Job({
  name: 'AuditRefDriftJob',
  description: 'Compare repository refs against the ledger and report divergence',
  queue: 'git',
  tries: 1,

  async handle(payload: { sample?: number, repositoryId?: number } = {}) {
    // Nothing to audit against without the log: the ledger is only kept up to
    // date by pushes that are recorded.
    if (walMode() === 'off')
      return { skipped: 'the write-ahead log is off' }

    const only = Number(payload?.repositoryId ?? 0)
    const sample = Math.max(1, Number(payload?.sample ?? 50))

    const rows: any[] = await db
      .selectFrom('repositories')
      .select(['id', 'name', 'owner_type', 'owner_id'])
      .execute()
      .catch(() => [])

    const candidates = only ? rows.filter(row => Number(row.id) === only) : rotate(rows, sample)

    let examined = 0
    let seeded = 0
    const drifted: string[] = []

    for (const row of candidates) {
      const repositoryId = Number(row.id)
      const path = await pathFor(row)

      if (!path)
        continue

      examined += 1

      const ledger = await ledgerFor(repositoryId)

      if (ledger.length === 0) {
        // Not drift: a repository that predates the ledger. Believed from
        // disk once, at sequence zero.
        seeded += await seedLedger(repositoryId, path)

        continue
      }

      const disk = await refsOnDisk(path)
      const found = divergence(ledger, disk)

      if (found.stale.length === 0)
        continue

      /*
       * Named precisely, because "a repository has drifted" is not actionable
       * and "refs/heads/main says X here and Y in the ledger" is. Truncated,
       * because a repository that has drifted on four hundred refs has one
       * problem rather than four hundred.
       */
      const detail = found.stale
        .slice(0, 5)
        .map(entry => `${entry.ref} ledger=${entry.ledger.slice(0, 10)} disk=${entry.disk?.slice(0, 10) ?? 'absent'}`)
        .join(', ')

      drifted.push(`${row.owner_type}:${row.owner_id}/${row.name} (${found.stale.length}): ${detail}`)
    }

    for (const line of drifted)
      log.warn(`[drift] ${line}`)

    if (seeded > 0)
      log.info(`[drift] seeded ${seeded} ledger rows for repositories that predate it`)

    return { examined, seeded, drifted: drifted.length }
  },
})

/**
 * A different slice each run, so every repository is eventually looked at.
 *
 * Keyed on the hour rather than at random: a random sample can miss the same
 * repository indefinitely, and an operator watching a specific one should be
 * able to predict roughly when it is next checked.
 */
function rotate<T>(rows: readonly T[], size: number): T[] {
  if (rows.length <= size)
    return [...rows]

  const start = (Math.floor(Date.now() / 3_600_000) * size) % rows.length
  const slice = rows.slice(start, start + size)

  return slice.length === size ? slice : [...slice, ...rows.slice(0, size - slice.length)]
}

async function pathFor(row: any): Promise<string | null> {
  const table = String(row.owner_type) === 'organization' ? 'organizations' : 'users'
  const owner: any = await db
    .selectFrom(table)
    .select(['handle'])
    .where('id', '=', Number(row.owner_id))
    .executeTakeFirst()
    .catch(() => null)

  if (!owner?.handle)
    return null

  const { repositoryPath } = await import('../Actions/Git/storage')
  const resolved = repositoryPath(String(owner.handle), String(row.name))

  if (!resolved.ok)
    return null

  // Deliberately not `ensureLocal`: an audit that materialized what it audits
  // would always find agreement, which is the one answer it must not be able
  // to manufacture.
  return (await Bun.file(`${resolved.path}/HEAD`).exists()) ? resolved.path! : null
}

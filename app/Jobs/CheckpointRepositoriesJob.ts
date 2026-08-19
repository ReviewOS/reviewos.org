import { Job } from '@stacksjs/queue'
import process from 'node:process'
import { log } from '@stacksjs/logging'
import { db } from '@stacksjs/database'
import { advertiseBundle, latestCheckpoint, pruneCheckpoints, pruneThrough, writeCheckpoint } from '../Actions/Git/checkpoint'
import { walKeepEntries, walMode } from '../../config/git-wal'

/**
 * Keep the write-ahead log from growing forever.
 *
 * Without this the log is a complete history and an unbounded one: every push
 * a repository has ever taken, replayed in order to restore it. A checkpoint
 * is a full bundle of the repository as it stands, after which the entries
 * before it are redundant - so this writes one and prunes the prefix.
 *
 * **Nightly, and only for repositories that have actually moved.** A
 * checkpoint of a repository with no new entries since the last one is the
 * same bundle written twice, which costs the whole repository in bandwidth and
 * storage to learn nothing.
 *
 * Nothing here fails the job for one repository, the same rule as
 * `RepositoryMaintenanceJob`: a repository that could not be checkpointed
 * still works, and the rest of them still want their turn.
 */
export default new Job({
  name: 'CheckpointRepositories',
  description: 'Write a full bundle per repository and prune the log prefix it makes redundant',
  queue: 'git',
  tries: 1,

  async handle(payload: { repositoryId?: number, minimumEntries?: number } = {}) {
    // Off when the log is off. A checkpoint with no log to bound is a full
    // bundle of every repository, nightly, for nothing.
    if (walMode() === 'off')
      return { skipped: 'the write-ahead log is off' }

    const only = Number(payload?.repositoryId ?? 0)
    const minimum = Math.max(1, Number(payload?.minimumEntries ?? 1))
    const keep = walKeepEntries()

    const rows: any[] = await db
      .selectFrom('git_wal_entries')
      .select(['repository_id'])
      .where('status', '=', 'committed')
      .execute()
      .catch(() => [])

    const byRepository = new Map<number, number>()

    for (const row of rows) {
      const id = Number(row.repository_id)
      byRepository.set(id, (byRepository.get(id) ?? 0) + 1)
    }

    let written = 0
    let prunedRows = 0
    let prunedBlobs = 0

    for (const [repositoryId, count] of byRepository) {
      if (only && repositoryId !== only)
        continue

      if (count < minimum)
        continue

      try {
        const newest: any = await db
          .selectFrom('git_wal_entries')
          .select(['sequence'])
          .where('repository_id', '=', repositoryId)
          .where('status', '=', 'committed')
          .orderBy('sequence', 'desc')
          .limit(1)
          .executeTakeFirst()

        const through = Number(newest?.sequence ?? 0)

        if (!through)
          continue

        // Nothing has landed since the last checkpoint: the bundle would be
        // identical and the prune has already happened.
        const existing = await latestCheckpoint(repositoryId)

        if (existing && existing.sequence >= through)
          continue

        const located = await locate(repositoryId)

        if (!located)
          continue

        const { path, owner, name } = located
        const checkpoint = await writeCheckpoint(repositoryId, path, through)

        if (!checkpoint)
          continue

        written += 1

        /*
         * Advertise it, so a clone can take the bulk of its objects from
         * storage rather than from `upload-pack`. Best-effort: a repository
         * whose config could not be written still has a checkpoint, and the
         * only cost is that clients keep cloning the ordinary way.
         */
        const url = bundleUrl(owner, name)

        if (url)
          await advertiseBundle(path, url).catch(() => undefined)

        const pruned = await pruneThrough(repositoryId, through, keep)
        prunedRows += pruned.removedRows
        prunedBlobs += pruned.removedBlobs

        await pruneCheckpoints(repositoryId)
      }
      catch (error) {
        log.warn(`[checkpoint] skipped repository ${repositoryId}: ${error}`)
      }
    }

    if (written > 0)
      log.info(`[checkpoint] wrote ${written} checkpoints, pruned ${prunedRows} entries and ${prunedBlobs} bundles`)

    return { written, prunedRows, prunedBlobs }
  },
})

/**
 * Where clients should fetch this repository's checkpoint.
 *
 * Absolute, because it goes into the repository's own config and is handed to
 * a git client that has no idea what path this process sees. Built from
 * `APP_URL` for the same reason every other external URL here is: the
 * instance's public name is the only one a client can reach.
 */
function bundleUrl(owner: string, name: string): string | null {
  const base = String(process.env.APP_URL ?? '').trim().replace(/\/+$/, '')

  if (base.length === 0)
    return null

  const origin = /^https?:\/\//.test(base) ? base : `https://${base}`

  return `${origin}/${owner}/${name}/bundles/checkpoint`
}

/** Where a repository is on this node, and who owns it. */
async function locate(repositoryId: number): Promise<{ path: string, owner: string, name: string } | null> {
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

  const { ensureLocal } = await import('../Actions/Git/storage')
  const local = await ensureLocal(String(owner.handle), String(row.name))

  return local.ok ? { path: local.path!, owner: String(owner.handle), name: String(row.name) } : null
}

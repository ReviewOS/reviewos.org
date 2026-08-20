import { Job } from '@stacksjs/queue'
import { log } from '@stacksjs/logging'
import { readdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { runGit } from '../Actions/Git/git'
import { REPOSITORY_ROOT } from '../Actions/Git/storage'
import { DELETED_DIRECTORY } from '../Actions/Repo/settings'
import { expiredRetirements, needsPacking, packArguments, RETENTION_DAYS } from '../Actions/Repo/retention'
import { measure, recordSize } from '../Actions/Repo/size'

/**
 * Keep the repositories on disk in a state worth cloning, and let go of the
 * ones nobody came back for.
 *
 * Two jobs in one because they are the same visit to the same directory once a
 * night, and splitting them would mean two schedules to keep in step.
 *
 * **Packing.** A push smaller than `transfer.unpackLimit` arrives as loose
 * objects, so a repository that people actually use accumulates them far faster
 * than a working copy somebody commits to by hand - and every loose object is a
 * separate file a clone has to read. `git gc` is what turns thousands of them
 * into one packfile.
 *
 * **Retention.** Deleting a repository moves it aside with a timestamp rather
 * than unlinking it, which is only a kindness if something eventually removes
 * them; otherwise the disk fills with repositories nobody can see. Thirty days
 * is longer than a holiday, which is the case that matters: somebody deletes
 * the wrong thing on a Friday and finds out when they get back.
 *
 * Nothing here fails the job for one repository. A repository that cannot be
 * packed is a repository that still works, and the rest of them still want
 * their turn.
 */
export default new Job({
  name: 'RepositoryMaintenanceJob',
  description: 'Pack repositories that need it, and remove deletions past the retention window',
  queue: 'git',
  tries: 1,

  async handle(payload: { retentionDays?: number, dryRun?: boolean } = {}) {
    const retentionDays = Number(payload?.retentionDays ?? RETENTION_DAYS)
    const dryRun = Boolean(payload?.dryRun)

    const packed = await packRepositories(dryRun)
    const swept = await sweepDeletions(retentionDays, dryRun)

    return { ok: true, ...packed, ...swept, retentionDays, dryRun }
  },
})

/**
 * Pack every repository that has accumulated enough loose material to be worth
 * it, and record what it weighs afterwards.
 *
 * Measured first rather than running `gc --auto` on everything: `--auto`
 * decides with git's own thresholds, which are tuned for a person's working
 * copy, and running it across every repository on the instance means spawning
 * git once per repository to be told there is nothing to do. One
 * `count-objects` is cheaper and answers the question this job is asking.
 */
async function packRepositories(dryRun: boolean): Promise<{ examined: number, packed: number }> {
  const rows = await db
    .selectFrom('repositories')
    .select(['id', 'disk_path'])
    .execute()
    .catch(() => [])

  let examined = 0
  let packed = 0

  for (const row of rows) {
    const path = resolve(REPOSITORY_ROOT, String(row.disk_path ?? ''))

    try {
      const counts = await measure(path)
      if (!counts)
        continue

      examined += 1

      if (!needsPacking(counts))
        continue

      if (dryRun) {
        packed += 1
        continue
      }

      // Plain `gc`, keeping the default two-week prune grace. The grace period
      // is the coordination with in-flight pushes: a push between quarantine
      // merge and ref update holds objects nothing references yet, and pruning
      // "now" would delete them under it. See `packArguments` in retention.ts.
      const result = await runGit(path, packArguments(), { timeoutMs: 15 * 60_000, priority: 'background' })

      if (!result.ok) {
        log.warn(`[maintenance] could not pack ${row.disk_path}: ${result.stderr}`)
        continue
      }

      packed += 1

      // The size is why anybody looks at this number, and packing is the one
      // thing that moves it downwards.
      await recordSize(Number(row.id), path)
    }
    catch (error) {
      log.warn(`[maintenance] skipped ${row.disk_path}: ${error}`)
    }
  }

  return { examined, packed }
}

/**
 * Remove deleted repositories past the window.
 *
 * A directory whose name this does not recognise is left alone, always. The
 * bytes in here are the last copy of somebody's work, so anything unexpected is
 * a reason for a person to look rather than a reason to delete.
 */
async function sweepDeletions(retentionDays: number, dryRun: boolean): Promise<{ removed: number, kept: number }> {
  let removed = 0
  let kept = 0

  const owners = await readdir(DELETED_DIRECTORY, { withFileTypes: true }).catch(() => [])

  for (const owner of owners) {
    if (!owner.isDirectory())
      continue

    const ownerDirectory = join(DELETED_DIRECTORY, owner.name)
    const entries = await readdir(ownerDirectory).catch(() => [])
    const expired = expiredRetirements(entries, Date.now(), retentionDays)
    const expiring = new Set(expired.map(entry => entry.directory))

    kept += entries.length - expiring.size

    for (const entry of expired) {
      if (dryRun) {
        removed += 1
        continue
      }

      try {
        await rm(join(ownerDirectory, entry.directory), { recursive: true, force: true })
        removed += 1
        log.info(`[maintenance] removed ${owner.name}/${entry.name}, deleted ${retentionDays}+ days ago`)
      }
      catch (error) {
        log.warn(`[maintenance] could not remove ${entry.directory}: ${error}`)
      }
    }
  }

  return { removed, kept }
}

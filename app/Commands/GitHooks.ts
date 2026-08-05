import type { CLI } from '@stacksjs/types'
import process from 'node:process'
import { readdir } from 'node:fs/promises'

// Imported rather than relied on as a global: `db` is a server auto-import, and
// a buddy command does not run through the preloader that injects those.
import { db } from '@stacksjs/database'
import { HOOK_DIRECTORY, hookSecret, hookUrl, installHooks, repositoryPaths, useSharedHooks } from '../Actions/Git/hooks'
import { REPOSITORY_ROOT } from '../Actions/Git/storage'

/**
 * Write the shared hooks and point every repository at them.
 *
 * Needed in three situations, and the first two are the ones that bite:
 *
 * - **After an upgrade.** The scripts are generated from the current
 *   configuration, so a release that changes an endpoint leaves every existing
 *   repository posting to the old one. Running this in a deploy step is the
 *   intended use.
 * - **After the instance URL or port changes.** Same reason.
 * - **On a repository created before hooks existed**, which on this instance is
 *   every repository created before the push pipeline landed.
 *
 * Idempotent, and safe to run while the instance is serving: writing a hook
 * script does not interrupt a push in flight, and the next push picks up the
 * new one.
 *
 * It reports what it could not do rather than stopping at the first failure. A
 * repository whose config is unwritable is a repository somebody has to look
 * at, and the other four hundred should still be repaired in the meantime.
 */
export default function (buddy: CLI): void {
  buddy
    .command('git:hooks', 'Install the shared git hooks and point every repository at them')
    .option('--dry-run', 'Report what would change without writing anything')
    .action(async (options: { dryRun?: boolean }) => {
      const dryRun = options?.dryRun === true

      console.error(`Hook directory: ${HOOK_DIRECTORY}`)
      console.error(`Hooks post to:  ${hookUrl()}`)

      if (!hookSecret()) {
        console.error('')
        console.error('  GIT_HOOK_SECRET is not set, or is shorter than 16 characters.')
        console.error('  The endpoints the hooks post to answer 404 until it is, so pushes')
        console.error('  will land on disk and nothing will be recorded about them.')
        console.error('')
      }

      if (!dryRun) {
        const written = await installHooks()
        if (!written.ok) {
          console.error(`Could not write the hooks: ${written.error}`)
          process.exit(1)
        }
      }

      const repositories = await db
        .selectFrom('repositories')
        .select(['id', 'name', 'disk_path'])
        .execute()

      let pointed = 0
      const failed: string[] = []

      for (const repository of repositories as any[]) {
        // Rows carry both an absolute and a relative `disk_path`, so the
        // resolution is shared rather than assumed here.
        const { absolute: path } = repositoryPaths(String(repository.disk_path ?? ''), REPOSITORY_ROOT)

        // A row whose repository is not on disk is a separate problem, and one
        // this command is not the place to fix.
        const present = await readdir(path).then(() => true).catch(() => false)
        if (!present) {
          failed.push(`${repository.disk_path} (nothing on disk)`)
          continue
        }

        if (dryRun) {
          pointed += 1
          continue
        }

        if (await useSharedHooks(path))
          pointed += 1
        else
          failed.push(String(repository.disk_path))
      }

      console.error(`${dryRun ? 'Would point' : 'Pointed'} ${pointed} of ${repositories.length} repositories at the shared hooks.`)

      for (const one of failed)
        console.error(`  could not: ${one}`)

      process.exit(failed.length > 0 ? 1 : 0)
    })
}

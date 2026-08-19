import type { CLI } from '@stacksjs/types'
import process from 'node:process'

// Imported rather than relied on as a global: `db` is a server auto-import and
// a buddy command does not run through the preloader that injects those.
import { db } from '@stacksjs/database'
import { cachePolicy, collectCaches } from '../Actions/Workflow/cacheCollect'

/**
 * What the dependency cache is holding, and what the next sweep would take.
 *
 * **An operator command, not an API client.** `buddy ci:*` in
 * [`Ci.ts`](./Ci.ts) is deliberately nothing but a client of the public API;
 * this one reads the database directly, because it answers a question about the
 * instance's disk rather than about anybody's repository, and there is no API
 * for "show me every repository's cache" that would be safe to expose.
 *
 * It exists to satisfy the phase 9 rule that the collection policy is **visible
 * before it deletes anything**. The usual way this goes wrong is a cron job
 * with the numbers inlined: nobody can quote the policy, nobody can predict it,
 * and the first time anybody notices is when a cache they relied on is gone.
 * Here the preview and the sweep call the same function, so what this prints is
 * what would happen rather than a second implementation that agrees today.
 */
export default function (cli: CLI) {
  cli
    .command('ci:caches', 'Show what the dependency cache holds and what the next sweep would remove')
    .option('--collect', 'Actually remove them, rather than only saying what would go', { default: false })
    .option('--json', 'Machine-readable output', { default: false })
    .action(async (options: { collect?: boolean, json?: boolean }) => {
      const policy = cachePolicy(process.env as Record<string, string | undefined>)

      const held: any[] = await db
        .selectFrom('workflow_cache_entries')
        .select(['repository_id', 'size_bytes'])
        .execute()
        .catch(() => [])

      const total = held.reduce((sum, row) => sum + Number(row.size_bytes ?? 0), 0)

      /*
       * The dry run happens either way.
       *
       * With `--collect` this is the sweep; without it, it is the same code
       * path with the deletes skipped. One function, so an operator who reads
       * the preview and then runs the sweep gets what they were shown.
       */
      const swept = await collectCaches({ dryRun: !options.collect })

      if (options.json) {
        console.log(JSON.stringify({ policy, entries: held.length, bytes: total, ...swept }, null, 2))

        return
      }

      console.log(`Policy: at most ${gigabytes(policy.maxBytesPerRepository)} per repository, and nothing kept more than ${policy.maxIdleDays} days after its last restore.`)
      console.log(`Holding ${held.length} ${held.length === 1 ? 'snapshot' : 'snapshots'} across ${swept.repositories} ${swept.repositories === 1 ? 'repository' : 'repositories'}, ${gigabytes(total)} in total.`)

      if (swept.removed === 0) {
        console.log('Nothing is past the policy.')

        return
      }

      // Named, not just counted: "three snapshots" tells an operator nothing
      // about whether the one they care about is among them.
      for (const going of swept.removals.slice(0, 20))
        console.log(`  repository ${going.repositoryId}  ${going.scope}  ${gigabytes(going.sizeBytes)}`)

      if (swept.removals.length > 20)
        console.log(`  ...and ${swept.removals.length - 20} more`)

      console.log(options.collect
        ? `Removed ${swept.removed}, freeing ${gigabytes(swept.freed)}.`
        : `Would remove ${swept.removed}, freeing ${gigabytes(swept.freed)}. Run again with --collect to do it.`)
    })
}

/** A size somebody can read, rather than a number of bytes. */
function gigabytes(bytes: number): string {
  const value = Number(bytes ?? 0)

  if (value < 1024)
    return `${value} B`

  if (value < 1024 * 1024)
    return `${(value / 1024).toFixed(1)} KiB`

  if (value < 1024 * 1024 * 1024)
    return `${(value / (1024 * 1024)).toFixed(1)} MiB`

  return `${(value / (1024 * 1024 * 1024)).toFixed(2)} GiB`
}

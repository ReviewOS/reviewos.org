import type { CLI } from '@stacksjs/types'
import type { Connection } from '../Actions/Database/engineMigration'
import process from 'node:process'
import { backfillShardKey } from '../Actions/Database/shardKeyBackfill'

/**
 * Fill `repository_id` on rows written before the column existed.
 *
 * Separate from the migration on purpose: adding the column is instant and
 * filling it reads every row, and an instance with years of workflow logs
 * should choose when that happens. Safe to run on a live instance, safe to
 * interrupt, and safe to run twice - it only touches rows where the value is
 * still null.
 *
 * Rows it cannot fill are reported rather than guessed at: a child whose parent
 * was deleted has no repository, and inventing one would put it on a shard that
 * has nothing else of that repository's.
 */
export default function (cli: CLI) {
  cli
    .command('db:backfill-shard-key', 'Fill repository_id on rows that predate the column')
    .option('--batch <rows>', 'Rows per statement', { default: 5000 })
    .action(async (options: any) => {
      const connection: Connection = {
        adapter: String(process.env.DB_CONNECTION ?? 'mysql') === 'postgres' ? 'postgres' : 'mysql',
        hostname: String(process.env.DB_HOST ?? '127.0.0.1'),
        port: Number(process.env.DB_PORT ?? (process.env.DB_CONNECTION === 'postgres' ? 5432 : 3306)),
        database: String(process.env.DB_DATABASE ?? ''),
        username: String(process.env.DB_USERNAME ?? ''),
        password: String(process.env.DB_PASSWORD ?? ''),
      }

      try {
        const results = await backfillShardKey(connection, Number(options.batch) || 5000)
        const filled = results.reduce((total, one) => total + one.filled, 0)
        const orphaned = results.filter(one => one.orphaned > 0)

        for (const result of results) {
          if (result.filled > 0 || result.orphaned > 0)
            console.error(`${result.table}: filled ${result.filled}${result.orphaned > 0 ? `, ${result.orphaned} without a parent` : ''}`)
        }

        console.error('')
        console.error(`${filled} rows now carry the shard key.`)

        if (orphaned.length > 0)
          console.error(`${orphaned.length} table(s) hold rows whose parent is gone; they stay null and stay in place.`)

        process.exit(0)
      }
      catch (error) {
        console.error(`Backfill failed: ${error instanceof Error ? error.message : String(error)}`)
        process.exit(1)
      }
    })
}

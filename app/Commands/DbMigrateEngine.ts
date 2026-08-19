import type { CLI } from '@stacksjs/types'
import type { Connection } from '../Actions/Database/engineMigration'
import process from 'node:process'
import { describeMigration, migrateEngine } from '../Actions/Database/engineMigration'

/**
 * Move this instance's data from one database engine to the other.
 *
 * The source is whatever `.env` names, because that is the database that is
 * live; the target is given on the command line, because it is the one being
 * built. Nothing is written to the source, ever - an operator reversing this at
 * three in the morning needs the old database untouched rather than rolled
 * back, and "put the old `DB_CONNECTION` back" is the whole rollback.
 *
 * **The downtime procedure is in `docs/self-hosting.md`.** In short: stop the
 * app and the worker, run this, change `DB_CONNECTION`, start them again. The
 * copy is not online - a row written to Postgres while this runs is a row this
 * does not carry - so the stop is the part that matters, not the duration.
 */
export default function (cli: CLI) {
  cli
    .command('db:migrate-engine', 'Copy this instance to another database engine, and verify it')
    .option('--to <adapter>', 'The target engine: mysql or postgres', { default: 'mysql' })
    .option('--host <host>', 'Target host', { default: '127.0.0.1' })
    .option('--port <port>', 'Target port', { default: 0 })
    .option('--database <name>', 'Target database name', { default: '' })
    .option('--username <name>', 'Target user', { default: '' })
    .option('--password <password>', 'Target password', { default: '' })
    .option('--truncate', 'Empty the target tables first, instead of refusing a non-empty one', { default: false })
    .option('--page-size <rows>', 'Rows per statement', { default: 1000 })
    .action(async (options: any) => {
      const adapter = String(options.to ?? 'mysql') === 'postgres' ? 'postgres' : 'mysql'

      const from: Connection = {
        adapter: String(process.env.DB_CONNECTION ?? 'postgres') === 'mysql' ? 'mysql' : 'postgres',
        hostname: String(process.env.DB_HOST ?? '127.0.0.1'),
        port: Number(process.env.DB_PORT ?? (process.env.DB_CONNECTION === 'mysql' ? 3306 : 5432)),
        database: String(process.env.DB_DATABASE ?? ''),
        username: String(process.env.DB_USERNAME ?? ''),
        password: String(process.env.DB_PASSWORD ?? ''),
      }

      const to: Connection = {
        adapter,
        hostname: String(options.host ?? '127.0.0.1'),
        port: Number(options.port) || (adapter === 'mysql' ? 3306 : 5432),
        database: String(options.database ?? '') || from.database,
        username: String(options.username ?? '') || (adapter === 'mysql' ? 'root' : 'postgres'),
        password: String(options.password ?? ''),
      }

      if (from.adapter === to.adapter && from.database === to.database && from.port === to.port) {
        console.error('The source and the target are the same database. Name the target with --database or --port.')
        process.exit(1)
      }

      console.error(`Copying ${from.adapter}://${from.hostname}:${from.port}/${from.database} to ${to.adapter}://${to.hostname}:${to.port}/${to.database}`)
      console.error('The source is only ever read.')
      console.error('')

      try {
        const report = await migrateEngine({
          from,
          to,
          truncate: Boolean(options.truncate),
          pageSize: Number(options.pageSize) || 1000,
          onTable: (table) => {
            // Only the tables that carried something, so a hundred empty ones
            // do not bury the two that failed.
            if (table.source > 0 || !table.ok)
              console.error(`  ${table.ok ? 'ok  ' : 'FAIL'} ${table.table}: ${table.source} rows`)
          },
        })

        console.error('')

        for (const line of describeMigration(report))
          console.error(line)

        if (!report.ok) {
          console.error('')
          console.error('The target is not a faithful copy. Nothing was written to the source; leave DB_CONNECTION as it is.')
          process.exit(1)
        }

        console.error('')
        console.error(`Set DB_CONNECTION=${to.adapter} (and the DB_HOST/DB_PORT/DB_DATABASE to match), then start the app and the worker.`)
        process.exit(0)
      }
      catch (error) {
        console.error(`The copy stopped: ${error instanceof Error ? error.message : String(error)}`)
        console.error('Nothing was written to the source.')
        process.exit(1)
      }
    })
}

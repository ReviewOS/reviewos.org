import type { CLI } from '@stacksjs/types'
import type { Connection } from '../Actions/Database/engineMigration'
import { mkdirSync, writeFileSync } from 'node:fs'
import process from 'node:process'
import {
  HOT_TRANSACTIONS,
  planKeyspaces,
  SHARD_KEY,
  SHARDED_KEYSPACE,
  sequenceTables,
  shardedVSchema,
  UNSHARDED_KEYSPACE,
  unshardedVSchema,
  verifySingleShard,
} from '../Actions/Database/vitess'

/**
 * The Vitess keyspace layout, computed from the schema that exists.
 *
 * Vitess mode is opt-in and for large instances only - a self-hosted forge runs
 * single-node MySQL - but the *decision* about how it would shard is one this
 * schema has to keep being true to, and a decision written in prose drifts the
 * first time somebody adds a model. So it is computed: which tables carry
 * `repository_id`, which are children that would need it denormalized, and
 * which belong in the unsharded keyspace.
 *
 * `--check` answers the question a test asks - does every hot transaction still
 * land on one shard - and exits non-zero when one would not.
 */
export default function (cli: CLI) {
  cli
    .command('db:keyspaces', 'Compute the Vitess keyspace layout from the current schema')
    .option('--out <directory>', 'Write vschema.json and the sequences here', { default: 'database/vitess' })
    .option('--check', 'Only report whether the hot transactions stay single-shard', { default: false })
    .action(async (options: any) => {
      const connection: Connection = {
        adapter: String(process.env.DB_CONNECTION ?? 'mysql') === 'postgres' ? 'postgres' : 'mysql',
        hostname: String(process.env.DB_HOST ?? '127.0.0.1'),
        port: Number(process.env.DB_PORT ?? 3306),
        database: String(process.env.DB_DATABASE ?? 'reviewos'),
        username: String(process.env.DB_USERNAME ?? 'root'),
        password: String(process.env.DB_PASSWORD ?? ''),
      }

      if (connection.adapter !== 'mysql') {
        console.error('This reads a MySQL schema; point DB_CONNECTION at the MySQL instance.')
        process.exit(1)
      }

      try {
        const plan = await planKeyspaces(connection)
        const verdicts = verifySingleShard(plan, HOT_TRANSACTIONS)

        console.error(`${plan.sharded.length} tables carry ${SHARD_KEY} and shard on it.`)
        console.error(`${plan.unsharded.length} tables have no repository and live in ${UNSHARDED_KEYSPACE}.`)

        if (plan.owed.length > 0) {
          console.error('')
          console.error(`${plan.owed.length} tables are children of a sharded table and do not carry ${SHARD_KEY}.`)
          console.error(`Each needs it denormalized from its parent before ${SHARDED_KEYSPACE} is created:`)

          for (const one of plan.owed)
            console.error(`  ${one.table} (from ${one.parent})`)
        }

        console.error('')

        for (const verdict of verdicts) {
          console.error(`${verdict.singleShard ? 'ok  ' : 'NO  '} ${verdict.transaction}`)

          for (const problem of verdict.problems)
            console.error(`       ${problem.table}: ${problem.reason}`)
        }

        if (options.check) {
          const failing = verdicts.filter(one => !one.singleShard)
          process.exit(failing.length > 0 ? 1 : 0)
        }

        const directory = String(options.out ?? 'database/vitess')
        mkdirSync(directory, { recursive: true })

        writeFileSync(`${directory}/${SHARDED_KEYSPACE}.vschema.json`, `${JSON.stringify(shardedVSchema(plan), null, 2)}\n`)
        writeFileSync(`${directory}/${UNSHARDED_KEYSPACE}.vschema.json`, `${JSON.stringify(unshardedVSchema(plan), null, 2)}\n`)
        writeFileSync(`${directory}/sequences.sql`, `${sequenceTables(plan).join('\n\n')}\n`)

        console.error('')
        console.error(`Written to ${directory}: two vschemas and the sequence tables.`)
        console.error(`Apply with: vtctldclient ApplyVSchema --vschema-file ${directory}/${SHARDED_KEYSPACE}.vschema.json ${SHARDED_KEYSPACE}`)
        process.exit(0)
      }
      catch (error) {
        console.error(`Could not read the schema: ${error instanceof Error ? error.message : String(error)}`)
        process.exit(1)
      }
    })
}

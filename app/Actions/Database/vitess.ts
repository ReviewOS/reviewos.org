/**
 * The keyspace layout, derived from the schema rather than written by hand.
 *
 * Vitess routes a query by looking up a column in a *vindex*, and the whole
 * bet of phase 17 is that the column is `repository_id`: nearly every hot
 * table is owned by a repository, so a review submit, a check report and a ref
 * transaction each land on one shard, and one shard is where Vitess runs at
 * full speed and full consistency.
 *
 * That bet is only true of tables that *carry* the column. A table which is a
 * child of a repository-owned row - `review_threads` under a pull request,
 * `workflow_jobs` under a run - has no `repository_id` of its own, and Vitess
 * cannot infer one. Left alone it would land in the unsharded keyspace, and a
 * transaction touching it and its parent would be a two-keyspace transaction:
 * the exact thing the sharding key was chosen to avoid.
 *
 * So this file computes three sets from the live schema, and the sets are the
 * decision:
 *
 * - **sharded**: tables that carry `repository_id` today.
 * - **owed**: tables that reference a sharded table but carry no
 *   `repository_id`. Each one needs the column denormalized onto it before the
 *   keyspace is created. This is stated as a list rather than as a paragraph
 *   because it is a migration somebody has to write, and a list can be checked.
 * - **unsharded**: everything else - accounts, organizations, sessions,
 *   tokens, the queue - which lives in a single unsharded keyspace and is read
 *   by every shard.
 *
 * Nothing here talks to Vitess. It reads a MySQL schema and writes JSON, so it
 * runs on the single-node instance an operator already has, before any of this
 * exists.
 */

import type { Connection } from './engineMigration'
import { connect } from './engineMigration'

/** The column every sharded table routes on. */
export const SHARD_KEY = 'repository_id'

/**
 * The table the shard key names, which shards on its own primary key.
 *
 * `repositories` has no `repository_id` column and does not want one: its `id`
 * *is* the value every other table routes on. Vitess handles that with the same
 * vindex over a different column, and without this the owner of every shard
 * would sit in the unsharded keyspace - so a push, which writes the repository
 * row and the ref ledger together, would cross keyspaces on the one transaction
 * the sharding key was chosen for.
 */
export const OWNER_TABLE = 'repositories'

/** What the sharded keyspace is called. */
export const SHARDED_KEYSPACE = 'reviewos'

/** And the one that is not sharded, which every shard may read. */
export const UNSHARDED_KEYSPACE = 'reviewos_global'

/**
 * Tables that are bookkeeping rather than application data.
 *
 * The migration ledger belongs to whichever database is being migrated, and a
 * sequence table is Vitess's own. Neither is sharded and neither is the
 * application's to place.
 */
export const BOOKKEEPING: readonly string[] = ['migrations', 'migration_locks']

export interface KeyspacePlan {
  /** Tables that carry the shard key today. */
  sharded: string[]
  /**
   * Tables that reference a sharded table and do not carry the shard key.
   *
   * Each needs `repository_id` denormalized onto it, with the parent's value,
   * before the keyspace is created - otherwise the transaction that touches
   * both crosses keyspaces.
   */
  owed: Array<{ table: string, parent: string }>
  /** Everything else: one unsharded keyspace, readable from every shard. */
  unsharded: string[]
}

/** Every base table in the schema. */
async function tables(sql: ReturnType<typeof connect>, database: string): Promise<string[]> {
  const rows = await sql.unsafe(
    `SELECT table_name AS name FROM information_schema.tables WHERE table_schema = ? AND table_type = 'BASE TABLE' ORDER BY table_name`,
    [database],
  ) as Array<{ name: string }>

  return rows.map(row => String(row.name))
}

/** The tables that carry the shard key. */
async function sharded(sql: ReturnType<typeof connect>, database: string): Promise<Set<string>> {
  const rows = await sql.unsafe(
    `SELECT DISTINCT table_name AS name FROM information_schema.columns WHERE table_schema = ? AND column_name = ?`,
    [database, SHARD_KEY],
  ) as Array<{ name: string }>

  return new Set(rows.map(row => String(row.name)))
}

/** Foreign keys, as child to parent. */
async function references(sql: ReturnType<typeof connect>, database: string): Promise<Array<{ child: string, parent: string }>> {
  const rows = await sql.unsafe(
    `SELECT DISTINCT table_name AS child, referenced_table_name AS parent
     FROM information_schema.key_column_usage
     WHERE table_schema = ? AND referenced_table_name IS NOT NULL
     ORDER BY table_name`,
    [database],
  ) as Array<{ child: string, parent: string }>

  return rows.map(row => ({ child: String(row.child), parent: String(row.parent) }))
}

/**
 * What the keyspaces would be, read off the schema that exists.
 *
 * Computed rather than declared so it cannot drift: a model added next week
 * with a `repository_id` is sharded by this the first time anybody asks, and
 * one added without lands in `owed` where somebody has to look at it.
 */
export async function planKeyspaces(connection: Connection): Promise<KeyspacePlan> {
  const sql = connect(connection)

  try {
    const all = await tables(sql, connection.database)
    const keyed = await sharded(sql, connection.database)
    const links = await references(sql, connection.database)

    const owed: KeyspacePlan['owed'] = []
    const seen = new Set<string>()

    for (const link of links) {
      if (keyed.has(link.child) || !keyed.has(link.parent) || seen.has(link.child))
        continue

      seen.add(link.child)
      owed.push({ table: link.child, parent: link.parent })
    }

    const unsharded = all.filter(table =>
      !keyed.has(table) && !seen.has(table) && !BOOKKEEPING.includes(table))

    return {
      // The owner table joins the sharded set: it routes on its own `id`.
      sharded: [...new Set([...[...keyed].filter(table => all.includes(table)), ...(all.includes(OWNER_TABLE) ? [OWNER_TABLE] : [])])].sort(),
      owed: owed.sort((a, b) => a.table.localeCompare(b.table)),
      unsharded: unsharded.filter(table => table !== OWNER_TABLE).sort(),
    }
  }
  finally {
    await sql.close().catch(() => {})
  }
}

export interface VSchema {
  sharded: boolean
  vindexes?: Record<string, { type: string }>
  tables: Record<string, {
    column_vindexes?: Array<{ column: string, name: string }>
    auto_increment?: { column: string, sequence: string }
    type?: string
  }>
}

/**
 * The sharded keyspace's VSchema.
 *
 * `xxhash` rather than `hash`: the older one is defined only over 64-bit
 * integers, and while `repository_id` is one today, a keyspace is not a thing
 * to re-shard because a column type changed. xxhash takes any type and spreads
 * evenly, which is the whole job of the vindex.
 *
 * Every table names a sequence for its primary key, because a sharded keyspace
 * has no auto-increment: two shards handing out `id = 4` is not a conflict
 * either of them can see. The sequences live in the unsharded keyspace, which
 * is what makes them a single source.
 */
export function shardedVSchema(plan: KeyspacePlan): VSchema {
  const tables: VSchema['tables'] = {}

  for (const table of [...plan.sharded, ...plan.owed.map(one => one.table)].sort()) {
    tables[table] = {
      // The owner routes on its own key; everything else on its owner's.
      column_vindexes: [{ column: table === OWNER_TABLE ? 'id' : SHARD_KEY, name: `${SHARD_KEY}_vdx` }],
      auto_increment: { column: 'id', sequence: `${UNSHARDED_KEYSPACE}.${table}_seq` },
    }
  }

  return {
    sharded: true,
    vindexes: { [`${SHARD_KEY}_vdx`]: { type: 'xxhash' } },
    tables,
  }
}

/** The unsharded keyspace's VSchema: every table, and the sequences. */
export function unshardedVSchema(plan: KeyspacePlan): VSchema {
  const tables: VSchema['tables'] = {}

  for (const table of plan.unsharded)
    tables[table] = {}

  for (const table of [...plan.sharded, ...plan.owed.map(one => one.table)].sort())
    tables[`${table}_seq`] = { type: 'sequence' }

  return { sharded: false, tables }
}

/**
 * The DDL for the sequence tables, which are ordinary tables with one row.
 *
 * Vitess reads `next_id` and reserves a block of `increment` values per vtgate,
 * so the counter is touched once per block rather than once per insert. 1000 is
 * upstream's own default and is the trade it names: a larger block means fewer
 * round trips and a bigger gap in the ids after a vtgate restarts, and gaps in
 * an id sequence cost nothing here because nothing in this schema reads an id
 * as a count.
 */
export function sequenceTables(plan: KeyspacePlan): string[] {
  return [...plan.sharded, ...plan.owed.map(one => one.table)].sort().map(table => [
    `CREATE TABLE IF NOT EXISTS \`${table}_seq\` (`,
    '  `id` bigint NOT NULL,',
    '  `next_id` bigint DEFAULT NULL,',
    '  `cache` bigint DEFAULT NULL,',
    '  PRIMARY KEY (`id`)',
    ') COMMENT=\'vitess_sequence\';',
    `INSERT INTO \`${table}_seq\` (id, next_id, cache) VALUES (0, 1, 1000)`,
    '  ON DUPLICATE KEY UPDATE next_id = next_id;',
  ].join('\n'))
}

/**
 * One hot transaction, and every table it writes.
 *
 * Written down rather than inferred from the code: what makes a transaction
 * single-shard is which tables it touches *together*, and that is a fact about
 * a code path rather than about the schema. The test beside this file checks
 * each one against the plan, so a path that grows a table in the unsharded
 * keyspace fails there rather than in production under load.
 */
export interface HotTransaction {
  name: string
  /** Where it lives, so the next person can read the code rather than guess. */
  where: string
  tables: readonly string[]
}

export const HOT_TRANSACTIONS: readonly HotTransaction[] = [
  {
    name: 'a push writes the ref ledger and the WAL',
    where: 'app/Actions/Git/wal.ts (phase 18c)',
    tables: ['git_wal_entries', 'repositories'],
  },
  {
    name: 'a review is submitted',
    where: 'app/Actions/Pull/SubmitReviewAction.ts',
    tables: ['pull_request_reviews', 'review_threads', 'review_drafts', 'pull_requests'],
  },
  {
    name: 'a check is reported',
    where: 'app/Actions/Check/ReportCheckAction.ts',
    tables: ['check_runs', 'check_annotations', 'commit_statuses'],
  },
  {
    name: 'the merge queue claims an entry',
    where: 'app/Actions/Merge/queue.ts',
    tables: ['merge_queue_entries', 'pull_requests'],
  },
  {
    name: 'a workflow run is dispatched',
    where: 'app/Actions/Workflow/dispatch.ts',
    tables: ['workflow_runs', 'workflow_jobs', 'workflow_versions', 'workflows'],
  },
]

export interface ShardVerdict {
  transaction: string
  /** True when every table it writes routes on the same key. */
  singleShard: boolean
  /** The tables that would take it off one shard, with why. */
  problems: Array<{ table: string, reason: string }>
}

/**
 * Whether each hot transaction stays on one shard, given the plan.
 *
 * A table in the sharded keyspace is fine. A table in `owed` is fine *once the
 * column is added*, and is reported as such rather than as a pass, because
 * until then it is in the wrong keyspace. A table in the unsharded keyspace is
 * a genuine cross-keyspace write and is named.
 */
export function verifySingleShard(plan: KeyspacePlan, transactions: readonly HotTransaction[] = HOT_TRANSACTIONS): ShardVerdict[] {
  const sharded = new Set(plan.sharded)
  const owed = new Map(plan.owed.map(one => [one.table, one.parent]))

  return transactions.map((transaction) => {
    const problems: ShardVerdict['problems'] = []

    for (const table of transaction.tables) {
      if (sharded.has(table))
        continue

      if (owed.has(table)) {
        problems.push({
          table,
          reason: `needs ${SHARD_KEY} denormalized from ${owed.get(table)} before the keyspace is created`,
        })
        continue
      }

      problems.push({ table, reason: 'lives in the unsharded keyspace, so this transaction crosses keyspaces' })
    }

    return { transaction: transaction.name, singleShard: problems.length === 0, problems }
  })
}

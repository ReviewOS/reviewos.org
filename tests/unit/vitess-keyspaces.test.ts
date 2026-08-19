// The keyspace layout, and the question it exists to answer.
//
// Vitess mode is opt-in and for large instances only. What is *not* optional is
// that the schema keeps being shardable the way phase 17 said it would be: a
// review submit, a check report and a ref transaction each on one shard. That
// claim is only true of tables that carry `repository_id`, and a model added
// next month carries it or does not.
//
// So the layout is computed from the schema rather than written down, and this
// checks the computation. The verdict on the hot transactions is deliberately
// *not* asserted to be "all single-shard" - four of the five are not, today,
// and the list of columns that would fix them is the deliverable. What is
// asserted is that the analysis says so rather than quietly passing.

import { describe, expect, test } from 'bun:test'
import {
  BOOKKEEPING,
  HOT_TRANSACTIONS,
  OWNER_TABLE,
  SHARD_KEY,
  sequenceTables,
  shardedVSchema,
  UNSHARDED_KEYSPACE,
  unshardedVSchema,
  verifySingleShard,
} from '../../app/Actions/Database/vitess'

/** A plan shaped like the real one, without needing a database to read. */
const plan = {
  sharded: ['pull_requests', 'repositories', 'workflow_runs'],
  owed: [
    { table: 'review_threads', parent: 'pull_requests' },
    { table: 'workflow_jobs', parent: 'workflow_runs' },
  ],
  unsharded: ['organizations', 'sessions', 'users'],
}

describe('the sharded keyspace', () => {
  const vschema = shardedVSchema(plan)

  test('routes every table on the shard key', () => {
    expect(vschema.sharded).toBe(true)
    expect(vschema.vindexes?.[`${SHARD_KEY}_vdx`]?.type).toBe('xxhash')

    for (const table of ['pull_requests', 'workflow_runs'])
      expect(vschema.tables[table]?.column_vindexes?.[0]?.column).toBe(SHARD_KEY)
  })

  test('routes the owner table on its own key, since it has no repository_id', () => {
    // Without this the owner of every shard sits in the unsharded keyspace, and
    // a push - which writes the repository row and the ref ledger together -
    // crosses keyspaces on the one transaction the key was chosen for.
    expect(vschema.tables[OWNER_TABLE]?.column_vindexes?.[0]?.column).toBe('id')
    expect(vschema.tables[OWNER_TABLE]?.column_vindexes?.[0]?.name).toBe(`${SHARD_KEY}_vdx`)
  })

  test('includes the tables that still owe the column, because that is where they will live', () => {
    for (const one of plan.owed)
      expect(vschema.tables[one.table]?.column_vindexes?.[0]?.column).toBe(SHARD_KEY)
  })

  test('gives every table a sequence, because a sharded keyspace has no auto-increment', () => {
    // Two shards handing out `id = 4` is not a conflict either of them can see.
    for (const table of Object.keys(vschema.tables)) {
      expect(vschema.tables[table]?.auto_increment?.column).toBe('id')
      expect(vschema.tables[table]?.auto_increment?.sequence).toBe(`${UNSHARDED_KEYSPACE}.${table}_seq`)
    }
  })
})

describe('the unsharded keyspace', () => {
  const vschema = unshardedVSchema(plan)

  test('holds what has no repository, and every sequence', () => {
    expect(vschema.sharded).toBe(false)

    for (const table of plan.unsharded)
      expect(vschema.tables[table]).toBeDefined()

    // The sequences are what make an id single-sourced, so they cannot live in
    // the keyspace they hand ids to.
    expect(vschema.tables.pull_requests_seq?.type).toBe('sequence')
    expect(vschema.tables.review_threads_seq?.type).toBe('sequence')
  })

  test('does not place the migration ledger, which belongs to whoever is migrating', () => {
    for (const table of BOOKKEEPING)
      expect(vschema.tables[table]).toBeUndefined()
  })
})

describe('the sequence tables', () => {
  const statements = sequenceTables(plan)

  test('carry the comment Vitess looks for', () => {
    // Without `COMMENT='vitess_sequence'` it is an ordinary table and vtgate
    // will not draw ids from it - silently, since nothing is malformed.
    for (const statement of statements)
      expect(statement).toContain(`COMMENT='vitess_sequence'`)
  })

  test('are seeded, and seeding twice does not reset the counter', () => {
    // A second `buddy db:keyspaces` on a live cluster must not hand out ids
    // somebody already has.
    for (const statement of statements)
      expect(statement).toContain('ON DUPLICATE KEY UPDATE next_id = next_id')
  })
})

describe('whether a hot transaction stays on one shard', () => {
  const verdicts = verifySingleShard(plan)

  test('passes one whose tables all carry the key', () => {
    const verdict = verifySingleShard(plan, [
      { name: 'probe', where: 'test', tables: ['pull_requests', 'repositories'] },
    ])[0]

    expect(verdict?.singleShard).toBe(true)
    expect(verdict?.problems).toEqual([])
  })

  test('names the column a child table is missing rather than passing it', () => {
    const verdict = verifySingleShard(plan, [
      { name: 'probe', where: 'test', tables: ['pull_requests', 'review_threads'] },
    ])[0]

    expect(verdict?.singleShard).toBe(false)
    expect(verdict?.problems[0]?.table).toBe('review_threads')
    expect(verdict?.problems[0]?.reason).toContain('denormalized from pull_requests')
  })

  test('calls a table in the unsharded keyspace what it is', () => {
    const verdict = verifySingleShard(plan, [
      { name: 'probe', where: 'test', tables: ['pull_requests', 'users'] },
    ])[0]

    expect(verdict?.singleShard).toBe(false)
    expect(verdict?.problems[0]?.reason).toContain('crosses keyspaces')
  })

  test('covers every hot transaction phase 17 named', () => {
    // The list is the point: a transaction nobody wrote down is one nobody
    // checks, and the first time it is measured is under load.
    const named = HOT_TRANSACTIONS.map(one => one.name)

    expect(named.some(name => name.includes('ref ledger'))).toBe(true)
    expect(named.some(name => name.includes('review'))).toBe(true)
    expect(named.some(name => name.includes('check'))).toBe(true)
    expect(named.some(name => name.includes('merge queue'))).toBe(true)
    expect(verdicts.length).toBe(HOT_TRANSACTIONS.length)

    for (const transaction of HOT_TRANSACTIONS)
      expect(transaction.tables.length).toBeGreaterThan(0)
  })
})

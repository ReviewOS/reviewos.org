// Moving an instance between engines, and the checks that make it provable.
//
// The interesting failure of a database migration is not the one that stops:
// it is the one that finishes, reports success, and has quietly changed a
// boolean or shifted a timestamp by the host's offset. So the copy hashes the
// values on both sides, and this exercises that.
//
// MySQL is reached at DB_MYSQL_PORT (3307 in development, where pantry runs it
// beside Postgres). Without it the round-trip tests skip and the pure ones
// still run: the rules about how a value is canonicalized are the half that
// decides whether the digest means anything.

import type { Connection } from '../../app/Actions/Database/engineMigration'
import { describe, expect, test } from 'bun:test'
import {
  canonicalValue,
  connect,
  foldDigests,
  migrateEngine,
  rowDigest,
} from '../../app/Actions/Database/engineMigration'
import { adminDatabase, connectionFor } from '../helpers/dialect'

// Its own databases, not the ones the rest of the suite is using: this creates
// and drops them, and doing that to the database another test file is mid-way
// through would be its own kind of data loss.
const MYSQL: Connection = { ...connectionFor('mysql'), database: 'reviewos_engine_test' }
const POSTGRES: Connection = { ...connectionFor('postgres'), database: 'reviewos_engine_source' }

/** Whether both engines answer. Neither round trip is worth faking. */
async function reachable(): Promise<boolean> {
  for (const connection of [
    { ...MYSQL, database: adminDatabase('mysql') },
    { ...POSTGRES, database: adminDatabase('postgres') },
  ]) {
    try {
      const sql = connect(connection)
      await sql.unsafe('SELECT 1')
      await sql.close()
    }
    catch {
      return false
    }
  }

  return true
}

const available = await reachable()

describe('the value canonicalizer', () => {
  test('reads a boolean the same way whichever engine returned it', () => {
    // Postgres hands back `true`; MySQL hands back `1` from a tinyint. They are
    // one value, and a digest that disagreed would fail every table.
    expect(canonicalValue(true)).toBe(canonicalValue(1))
    expect(canonicalValue(false)).toBe(canonicalValue(0))
  })

  test('keeps null apart from the empty string', () => {
    // A nullable text column can hold '' on purpose, and a migration that
    // turned one into the other would pass a row count.
    expect(canonicalValue(null)).not.toBe(canonicalValue(''))
  })

  test('does not depend on how a driver parsed a number', () => {
    expect(canonicalValue(1)).toBe(canonicalValue(1.0))
    expect(canonicalValue(1n)).toBe(canonicalValue(1))
  })
})

describe('the table digest', () => {
  const columns = ['id', 'name']

  test('ignores row order, because the engines do not agree on one', () => {
    const a = rowDigest({ id: 1, name: 'one' }, columns)
    const b = rowDigest({ id: 2, name: 'two' }, columns)

    expect(foldDigests([a, b])).toBe(foldDigests([b, a]))
  })

  test('notices a single changed value', () => {
    const before = [rowDigest({ id: 1, name: 'one' }, columns), rowDigest({ id: 2, name: 'two' }, columns)]
    const after = [rowDigest({ id: 1, name: 'one' }, columns), rowDigest({ id: 2, name: 'TWO' }, columns)]

    expect(foldDigests(before)).not.toBe(foldDigests(after))
  })

  test('notices a value that moved between columns', () => {
    // Length-prefixed for this reason: `('ab', 'c')` and `('a', 'bc')` are
    // different rows and a naive concatenation would hash them alike.
    expect(foldDigests([rowDigest({ id: 'ab', name: 'c' }, columns)]))
      .not.toBe(foldDigests([rowDigest({ id: 'a', name: 'bc' }, columns)]))
  })
})

describe.if(available)('copying an instance between engines', () => {
  const table = 'engine_migration_probe'

  async function fixture(): Promise<void> {
    const source = connect({ ...POSTGRES, database: adminDatabase('postgres') })
    await source.unsafe(`DROP DATABASE IF EXISTS ${POSTGRES.database}`)
    await source.unsafe(`CREATE DATABASE ${POSTGRES.database}`)
    await source.close()

    const target = connect({ ...MYSQL, database: adminDatabase('mysql') })
    await target.unsafe(`DROP DATABASE IF EXISTS \`${MYSQL.database}\``)
    await target.unsafe(`CREATE DATABASE \`${MYSQL.database}\` CHARACTER SET utf8mb4`)
    await target.close()

    const pg = connect(POSTGRES)
    await pg.unsafe(`CREATE TABLE "${table}" (
      "id" BIGSERIAL PRIMARY KEY,
      "name" varchar(100) NOT NULL,
      "enabled" boolean NOT NULL DEFAULT false,
      "score" integer,
      "note" text,
      "created_at" timestamp NOT NULL DEFAULT (now() AT TIME ZONE 'utc')
    )`)
    await pg.unsafe(`INSERT INTO "${table}" ("name", "enabled", "score", "note", "created_at") VALUES
      ('first', true, 10, 'a note', '2026-01-02 03:04:05'),
      ('second', false, NULL, '', '2026-02-03 04:05:06'),
      ('third', true, -7, NULL, '2026-03-04 05:06:07')`)
    await pg.close()

    const my = connect(MYSQL)
    await my.unsafe(`CREATE TABLE \`${table}\` (
      \`id\` bigint PRIMARY KEY auto_increment,
      \`name\` varchar(100) NOT NULL,
      \`enabled\` tinyint(1) NOT NULL DEFAULT 0,
      \`score\` integer,
      \`note\` text,
      \`created_at\` datetime NOT NULL DEFAULT (UTC_TIMESTAMP)
    ) DEFAULT CHARSET=utf8mb4`)
    await my.close()
  }

  test('carries every row, and says so only when the values match', async () => {
    await fixture()

    const report = await migrateEngine({ from: POSTGRES, to: MYSQL, truncate: true })
    const probe = report.tables.find(one => one.table === table)

    expect(probe?.source).toBe(3)
    expect(probe?.target).toBe(3)
    expect(probe?.sourceDigest).toBe(probe?.targetDigest ?? '')
    expect(report.ok).toBe(true)
  })

  test('carries a naive timestamp without the host\'s offset', async () => {
    await fixture()
    await migrateEngine({ from: POSTGRES, to: MYSQL, truncate: true })

    const my = connect(MYSQL)
    const rows = await my.unsafe(`SELECT DATE_FORMAT(\`created_at\`, '%Y-%m-%d %H:%i:%s') AS at FROM \`${table}\` ORDER BY \`id\``) as Array<{ at: string }>
    await my.close()

    // Read as text on both sides precisely so this holds: handed the naive
    // string, a driver assumes the host's zone, and a machine seven hours
    // behind UTC would land these seven hours out.
    expect(rows.map(row => String(row.at))).toEqual([
      '2026-01-02 03:04:05',
      '2026-02-03 04:05:06',
      '2026-03-04 05:06:07',
    ])
  })

  test('leaves the next id past what it wrote', async () => {
    await fixture()
    await migrateEngine({ from: POSTGRES, to: MYSQL, truncate: true })

    const my = connect(MYSQL)
    await my.unsafe(`INSERT INTO \`${table}\` (\`name\`) VALUES ('fourth')`)
    const rows = await my.unsafe(`SELECT COUNT(*) AS n FROM \`${table}\``) as Array<{ n: number }>
    await my.close()

    // Without resetting auto_increment the first row the application writes
    // collides with the last row the migration wrote, on a schema that has
    // just been declared correct.
    expect(Number(rows[0]?.n)).toBe(4)
  })

  test('refuses a target that already holds rows unless told to replace them', async () => {
    await fixture()
    await migrateEngine({ from: POSTGRES, to: MYSQL, truncate: true })

    const again = await migrateEngine({ from: POSTGRES, to: MYSQL })
    const probe = again.tables.find(one => one.table === table)

    expect(probe?.ok).toBe(false)
    expect(String(probe?.skipped)).toContain('--truncate')
    expect(again.ok).toBe(false)
  })

  test('reports a mismatch rather than a success when the target is wrong', async () => {
    await fixture()

    // The check has to be able to fail, or it is decoration. A row inserted
    // into the target before the copy makes the counts disagree by one, with
    // every value the copy itself wrote still correct.
    const my = connect(MYSQL)
    await my.unsafe(`INSERT INTO \`${table}\` (\`id\`, \`name\`) VALUES (999, 'not from the source')`)
    await my.close()

    const report = await migrateEngine({ from: POSTGRES, to: MYSQL })
    const probe = report.tables.find(one => one.table === table)

    expect(probe?.ok).toBe(false)
    expect(report.ok).toBe(false)
  })
})

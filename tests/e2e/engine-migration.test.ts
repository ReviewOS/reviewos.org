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

/**
 * How long an engine has to answer the probe.
 *
 * Generous by three orders of magnitude: a healthy engine answers `SELECT 1`
 * in single-digit milliseconds, local or containerised. Nothing legitimate
 * sits between that and thirty seconds, so the budget only ever expires on an
 * engine that was not going to answer.
 *
 * Thirty also happens to match Bun's own `connectionTimeout` default, which
 * is deliberate: the two bounds should not race each other, and whichever
 * fires, 30 seconds is the longest this file makes anyone wait to be told an
 * engine is unreachable.
 */
const PROBE_TIMEOUT_MS = 30_000

/**
 * The probe's own budget expiring, as a type rather than as a message.
 *
 * Told apart by `instanceof` because the alternative is matching on text an
 * engine's driver wrote, and a driver is free to reword its errors in a patch
 * release. This is the one error the probe reports rather than absorbs, so
 * mistaking it either way matters: upward, every absent engine becomes a
 * failure; downward, a wedged one goes back to being a silent skip.
 */
class ProbeExpired extends Error {}

/** What the probe found, which is three states rather than two. */
interface Probe {
  /** Both engines answered, so the round trips can run. */
  available: boolean
  /**
   * The engine that took the connection and then said nothing, if one did.
   *
   * Kept apart from `available: false` because the two mean opposite things.
   * An engine that refuses a connection is absent, which is the ordinary case
   * on a laptop running one engine, and skipping is right. An engine that
   * accepts a connection and never answers is broken, and skipping would
   * report a pass for work nobody did.
   */
  wedged: string | null
}

/**
 * Whether one engine answers, bounded and said out loud.
 *
 * Two things were wrong with the `await sql.unsafe('SELECT 1')` inside a bare
 * `try` that used to be here, and only one of them is the obvious one.
 *
 * The obvious one is the bound, and it is narrower than it looks. Bun's `SQL`
 * defaults `connectionTimeout` to 30 seconds, so a socket that accepts a
 * connection and never finishes the handshake - a service container still
 * starting - is already handled, and this was checked rather than assumed: a
 * listener that accepts and says nothing made the old probe give up in 30.3s.
 * What that setting does not cover is a connection that *is* established and
 * then goes quiet on the query, because Bun's `SQL` has no query timeout to
 * set. Under a module-level `await`, anything unbounded there hangs the file
 * before a single test is registered, where no per-test budget can reach it -
 * the 5s one needs a test to apply to. So the wait is ours to bound, and now
 * it is, rather than resting on a driver default that covers the neighbouring
 * case.
 *
 * The one that was actually costing us is the reporting. Every way of failing
 * to reach an engine used to return the same `false`, and `describe.if` turned
 * that into a skip - so a wedged engine produced a green file with its round
 * trips quietly not run. That is the shape this file's own header warns about
 * two screens up: green where it is read, and the digest is the half that
 * decides whether any of it means anything. An engine that refuses a
 * connection is absent and still skips. One that takes the connection and
 * then will not answer now says so.
 */
async function answers(connection: Connection): Promise<Probe> {
  const sql = connect(connection)

  try {
    await within(
      sql.unsafe('SELECT 1'),
      () => new ProbeExpired(`${connection.adapter} at ${connection.hostname}:${connection.port} accepted a connection and did not answer SELECT 1 within ${PROBE_TIMEOUT_MS / 1000}s`),
    )
  }
  catch (error) {
    // Everything but the budget is absorbed: a refused connection, a database
    // that is not there, an authentication failure. Those all mean the engine
    // is not available to this run, which is what the skip is for.
    await discard(sql)

    return error instanceof ProbeExpired
      ? { available: false, wedged: error.message }
      : { available: false, wedged: null }
  }

  await discard(sql)

  return { available: true, wedged: null }
}

/**
 * Close the connection, and do not wait forever to be allowed to.
 *
 * Bounded for the same reason the query above is, and easy to miss: this is
 * still a module-level `await`, so an unbounded close would move the hang two
 * lines down rather than remove it. An engine that will not acknowledge a
 * close is not worth another thirty seconds, and the socket goes when the
 * process does.
 */
async function discard(sql: ReturnType<typeof connect>): Promise<void> {
  try {
    await within(Promise.resolve(sql.close()), () => new ProbeExpired('the connection would not close'))
  }
  catch {
    // Nothing to do about it and nothing to report: whether the engine
    // answered is already decided by the time this runs.
  }
}

/**
 * Await `work`, or give up on it.
 *
 * `Promise.race` rather than an `AbortSignal` because `sql.unsafe` takes no
 * signal. Race attaches a handler to both sides, so the loser rejecting later
 * is not an unhandled rejection, and the timer is always cleared - a probe
 * that left one armed would hold the process open for thirty seconds after it
 * had its answer.
 */
async function within<T>(work: Promise<T>, expired: () => Error): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined

  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(expired()), PROBE_TIMEOUT_MS)
      }),
    ])
  }
  finally {
    clearTimeout(timer)
  }
}

/** Whether both engines answer. Neither round trip is worth faking. */
async function reachable(): Promise<Probe> {
  for (const connection of [
    { ...MYSQL, database: adminDatabase('mysql') },
    { ...POSTGRES, database: adminDatabase('postgres') },
  ]) {
    const probe = await answers(connection)

    if (!probe.available)
      return probe
  }

  return { available: true, wedged: null }
}

const probe = await reachable()
const available = probe.available

/*
 * A wedged engine is a failing test rather than a throw up here.
 *
 * Throwing at module scope would be louder than the silence it replaces, but
 * it takes the whole file with it - checked: `bun test` reports the throw as
 * one error and runs none of the file's tests, including the canonicalizer
 * ones below that need no engine at all. So the finding gets a test of its own
 * and everything that can still run, runs.
 */
describe.if(probe.wedged !== null)('reaching both engines', () => {
  test('an engine that accepts a connection answers it', () => {
    expect(probe.wedged).toBeNull()
  })
})

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

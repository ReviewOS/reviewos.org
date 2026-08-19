/**
 * Moving an instance from one database engine to another, with proof.
 *
 * Phase 17 makes MySQL the metadata database. Every existing install is on
 * Postgres, and "export it and import it" is not an answer: the two engines
 * disagree about booleans, about how a dump quotes an identifier, and about
 * what a timestamp without a zone means to a client library. A dump-and-restore
 * that lands 99% of the rows looks exactly like one that lands all of them.
 *
 * So this copies through the drivers rather than through `pg_dump`, and it
 * checks its work: every table is counted on both sides and hashed on both
 * sides, and the hash is of the *values*, computed the same way from whatever
 * each driver hands back. A row that arrives with its boolean flipped or its
 * timestamp shifted by the host's offset changes the digest, which a row count
 * would not notice.
 *
 * **It never writes to the source.** The failure mode of a migration tool has
 * to be "nothing happened", and an operator who has to reverse one at three in
 * the morning needs the old database untouched rather than rolled back.
 */

import { SQL } from 'bun'

/** Where a database is, and what speaks to it. */
export interface Connection {
  adapter: 'postgres' | 'mysql'
  hostname: string
  port: number
  database: string
  username: string
  password: string
}

/** One table's before and after. */
export interface TableReport {
  table: string
  /** Rows read from the source. */
  source: number
  /** Rows counted in the target afterwards. */
  target: number
  /** Order-independent hash of every value, from the source and from the target. */
  sourceDigest: string
  targetDigest: string
  ok: boolean
  /** Why it was skipped, when it was. */
  skipped?: string
}

export interface MigrationReport {
  tables: TableReport[]
  /** True only when every table matched on both count and digest. */
  ok: boolean
  rows: number
}

/**
 * One value, as text, the same way on both engines.
 *
 * The drivers do not agree on representation - Postgres hands back `true` where
 * MySQL hands back `1`, one returns a `Date` and the other a string - so a
 * digest computed over raw driver output would differ for rows that are
 * identical. This is the narrow waist: everything becomes text by one rule, and
 * what survives it is the value the application would read.
 *
 * `null` is its own marker rather than an empty string, because a nullable text
 * column can genuinely hold the empty string and the two must not hash alike.
 */
export function canonicalValue(value: unknown): string {
  if (value === null || value === undefined)
    return ' null'

  if (typeof value === 'boolean')
    return value ? '1' : '0'

  if (typeof value === 'bigint')
    return value.toString()

  if (typeof value === 'number') {
    // `1` and `1.0` are one number; formatting them differently would make a
    // digest depend on which driver parsed the column.
    return Number.isInteger(value) ? value.toFixed(0) : String(value)
  }

  if (value instanceof Date)
    return value.toISOString()

  if (value instanceof Uint8Array)
    return Buffer.from(value).toString('base64')

  if (typeof value === 'object')
    return JSON.stringify(value)

  return String(value)
}

/** A row's digest: the columns in a fixed order, length-prefixed so no two rows collide. */
export function rowDigest(row: Record<string, unknown>, columns: readonly string[]): Uint8Array {
  const hasher = new Bun.CryptoHasher('sha256')

  for (const column of columns) {
    const text = canonicalValue(row[column])
    hasher.update(`${text.length}:`)
    hasher.update(text)
  }

  return new Uint8Array(hasher.digest() as ArrayBufferLike)
}

/**
 * A table's digest, folded so row order does not matter.
 *
 * The two engines return rows in whatever order they like, and forcing a sort
 * on both sides would need a total order over columns that may be null - and
 * would make a three-million-row table a sort rather than a scan. XOR is
 * commutative, which is exactly the property wanted here.
 *
 * It is blind to a row duplicated an even number of times, which is why the row
 * count is checked as well: the two together catch what either alone would not.
 */
export function foldDigests(digests: Iterable<Uint8Array>): string {
  const total = new Uint8Array(32)

  for (const digest of digests) {
    for (let index = 0; index < 32; index += 1)
      total[index] = (total[index] ?? 0) ^ (digest[index] ?? 0)
  }

  return Buffer.from(total).toString('hex')
}

/** A single-connection handle. Pooling would scatter `SET` statements across sessions. */
export function connect(connection: Connection): SQL {
  return new SQL({
    adapter: connection.adapter,
    hostname: connection.hostname,
    port: connection.port,
    database: connection.database,
    username: connection.username,
    password: connection.password,
    max: 1,
  })
}

/** The tables an engine holds. */
export async function tablesOf(sql: SQL, connection: Connection): Promise<string[]> {
  const rows = connection.adapter === 'postgres'
    ? await sql.unsafe(`SELECT table_name AS name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`)
    : await sql.unsafe(`SELECT table_name AS name FROM information_schema.tables WHERE table_schema = ? AND table_type = 'BASE TABLE' ORDER BY table_name`, [connection.database])

  return (rows as Array<{ name: string }>).map(row => String(row.name))
}

export interface ColumnShape {
  name: string
  /**
   * Whether this column holds a naive timestamp.
   *
   * Read as text on both sides rather than as a `Date`, and this is not
   * fastidiousness: a driver handed `2026-08-19 02:15:38` with no zone assumes
   * the *host's* zone, so a value read on a machine seven hours behind UTC and
   * written back through another driver lands seven hours out. Text passes
   * through both engines unchanged.
   */
  temporal: boolean
  /**
   * Whether this column counts.
   *
   * Paging asks for rows after the last one it saw, and the seed value has to
   * have the column's type: `WHERE "id" > -1` against a `varchar` key is
   * "operator does not exist: character varying > integer" on Postgres, which
   * is where this was found - a handful of tables key on a string.
   */
  numeric: boolean
}

/** A table's columns, in a fixed order, with the ones that need care marked. */
export async function columnsOf(sql: SQL, connection: Connection, table: string): Promise<ColumnShape[]> {
  const rows = connection.adapter === 'postgres'
    ? await sql.unsafe(`SELECT column_name AS name, data_type AS type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`, [table])
    : await sql.unsafe(`SELECT column_name AS name, data_type AS type FROM information_schema.columns WHERE table_schema = ? AND table_name = ? ORDER BY ordinal_position`, [connection.database, table])

  return (rows as Array<{ name: string, type: string }>).map(row => ({
    name: String(row.name),
    temporal: /timestamp|datetime|^date$|^time/i.test(String(row.type)),
    numeric: /int|numeric|decimal|real|double|serial|float/i.test(String(row.type)),
  }))
}

/** How an engine quotes an identifier. */
function quoter(connection: Connection): (name: string) => string {
  return connection.adapter === 'postgres'
    ? (name: string) => `"${name.replace(/"/g, '""')}"`
    : (name: string) => `\`${name.replace(/`/g, '``')}\``
}

/** A `SELECT` list that reads timestamps as text, so no driver has to guess a zone. */
export function selectList(connection: Connection, columns: readonly ColumnShape[]): string {
  const quote = quoter(connection)

  return columns.map((column) => {
    if (!column.temporal)
      return quote(column.name)

    return connection.adapter === 'postgres'
      ? `to_char(${quote(column.name)}, 'YYYY-MM-DD HH24:MI:SS') AS ${quote(column.name)}`
      : `DATE_FORMAT(${quote(column.name)}, '%Y-%m-%d %H:%i:%s') AS ${quote(column.name)}`
  }).join(', ')
}

/** How many rows a table holds. */
export async function countRows(sql: SQL, connection: Connection, table: string): Promise<number> {
  const rows = await sql.unsafe(`SELECT COUNT(*) AS n FROM ${quoter(connection)(table)}`)

  return Number((rows as Array<{ n: unknown }>)[0]?.n ?? 0)
}

/**
 * Read a table in pages, handing each page to `receive`.
 *
 * Paged by primary key where there is one, because `LIMIT/OFFSET` over a table
 * being read is not a stable window, and a copy that silently repeats or skips
 * a page is the failure this whole file exists to make impossible. A table with
 * no `id` is read whole: in this schema those are join tables, and a join table
 * large enough to matter would have a key.
 */
export async function readTable(
  sql: SQL,
  connection: Connection,
  table: string,
  columns: readonly ColumnShape[],
  receive: (rows: Array<Record<string, unknown>>) => Promise<void> | void,
  pageSize = 1000,
): Promise<number> {
  const quote = quoter(connection)
  const list = selectList(connection, columns)
  const key = columns.find(column => column.name === 'id')

  if (!key) {
    const rows = await sql.unsafe(`SELECT ${list} FROM ${quote(table)}`) as Array<Record<string, unknown>>
    await receive(rows)
    return rows.length
  }

  const placeholder = connection.adapter === 'postgres' ? '$1' : '?'
  // The seed has to have the key's type; a string key compares against '' and
  // sorts after it, exactly as a number compares against -1.
  let after: string | number = key.numeric ? -1 : ''
  let total = 0

  for (;;) {
    const rows = await sql.unsafe(
      `SELECT ${list} FROM ${quote(table)} WHERE ${quote('id')} > ${placeholder} ORDER BY ${quote('id')} ASC LIMIT ${pageSize}`,
      [after],
    ) as Array<Record<string, unknown>>

    if (rows.length === 0)
      break

    await receive(rows)
    total += rows.length

    const last = rows[rows.length - 1]?.id
    after = key.numeric ? Number(last) : String(last)
  }

  return total
}

/**
 * How many placeholders one statement may carry.
 *
 * MySQL's protocol allows 65535 parameters and its default `max_allowed_packet`
 * is 64MB, but a statement anywhere near either limit is where this stopped
 * being a copy and became "Malformed communication packet - got packets out of
 * order" on a wide table: 1000 rows of 50 columns is 50000 placeholders, and
 * the driver gave up mid-stream rather than at a boundary. Two thousand is
 * comfortably inside every limit and costs nothing measurable in round trips.
 */
export const MAX_PLACEHOLDERS = 2000

/** Insert a page, in as few statements as the parameter limit allows. */
export async function insertRows(
  sql: SQL,
  connection: Connection,
  table: string,
  columns: readonly ColumnShape[],
  rows: ReadonlyArray<Record<string, unknown>>,
): Promise<void> {
  if (rows.length === 0 || columns.length === 0)
    return

  const quote = quoter(connection)
  const names = columns.map(column => quote(column.name)).join(', ')
  const perStatement = Math.max(1, Math.floor(MAX_PLACEHOLDERS / columns.length))

  for (let start = 0; start < rows.length; start += perStatement) {
    const batch = rows.slice(start, start + perStatement)
    const values: unknown[] = []
    const tuples: string[] = []

    for (const row of batch) {
      const marks = columns.map((column) => {
        values.push(row[column.name] ?? null)
        return connection.adapter === 'postgres' ? `$${values.length}` : '?'
      })

      tuples.push(`(${marks.join(', ')})`)
    }

    await sql.unsafe(`INSERT INTO ${quote(table)} (${names}) VALUES ${tuples.join(', ')}`, values)
  }
}

/**
 * The auto-increment, set past the rows just loaded.
 *
 * A copy writes explicit ids, and neither engine moves its counter when it is
 * told the id - so without this the first row the application inserts after a
 * migration collides with the last row the migration wrote, on a schema that
 * has just been declared correct.
 */
export async function resetAutoIncrement(sql: SQL, connection: Connection, table: string): Promise<void> {
  try {
    if (connection.adapter === 'mysql') {
      const rows = await sql.unsafe(`SELECT COALESCE(MAX(\`id\`), 0) + 1 AS next FROM \`${table}\``) as Array<{ next: unknown }>
      const next = Math.max(1, Number(rows[0]?.next ?? 1))

      // Not parameterizable: ALTER takes a literal.
      await sql.unsafe(`ALTER TABLE \`${table}\` AUTO_INCREMENT = ${next}`)
      return
    }

    await sql.unsafe(`SELECT setval(pg_get_serial_sequence('"${table}"', 'id'), GREATEST((SELECT COALESCE(MAX("id"), 0) FROM "${table}"), 1))`)
  }
  catch {
    // A table with no `id`, or none with a sequence behind it. Nothing to reset.
  }
}

export interface MigrateOptions {
  from: Connection
  to: Connection
  /** Empty the target's tables first. Without it, a non-empty target is refused. */
  truncate?: boolean
  /** Rows per statement. */
  pageSize?: number
  /** Called with each table as it finishes, for a progress line. */
  onTable?: (report: TableReport) => void
  /** Tables to leave alone. The migration ledger is the default: the target has its own. */
  skip?: readonly string[]
}

/** Tables whose contents belong to the target rather than to the source. */
export const DEFAULT_SKIP: readonly string[] = ['migrations', 'migration_locks']

/**
 * Copy every table the two databases share, then prove it landed.
 *
 * Tables the target does not have are reported rather than silently dropped: a
 * schema the corpus has not created yet is an operator's problem to see, and
 * guessing at it here would hide a half-migrated schema.
 */
export async function migrateEngine(options: MigrateOptions): Promise<MigrationReport> {
  const skip = new Set([...(options.skip ?? DEFAULT_SKIP)])
  const source = connect(options.from)
  const target = connect(options.to)

  try {
    if (options.to.adapter === 'mysql') {
      // The load is not in foreign-key order and does not need to be: what
      // arrived is counted and hashed at the end of every table.
      await target.unsafe('SET FOREIGN_KEY_CHECKS=0')
      await target.unsafe('SET UNIQUE_CHECKS=0')
    }
    else {
      await target.unsafe(`SET session_replication_role = 'replica'`)
    }

    const sourceTables = await tablesOf(source, options.from)
    const targetTables = new Set(await tablesOf(target, options.to))

    const tables: TableReport[] = []
    let rows = 0

    for (const table of sourceTables) {
      if (skip.has(table)) {
        tables.push({ table, source: 0, target: 0, sourceDigest: '', targetDigest: '', ok: true, skipped: 'not this migration\'s to move' })
        continue
      }

      if (!targetTables.has(table)) {
        tables.push({
          table,
          source: await countRows(source, options.from, table),
          target: 0,
          sourceDigest: '',
          targetDigest: '',
          ok: false,
          skipped: 'the target has no such table',
        })
        continue
      }

      const sourceColumns = await columnsOf(source, options.from, table)
      const targetColumns = await columnsOf(target, options.to, table)
      const shared = sourceColumns.filter(column => targetColumns.some(one => one.name === column.name))
      const names = shared.map(column => column.name)

      if (options.truncate) {
        await target.unsafe(options.to.adapter === 'mysql'
          ? `DELETE FROM \`${table}\``
          : `TRUNCATE TABLE "${table}" CASCADE`)
      }
      else if (await countRows(target, options.to, table) > 0) {
        tables.push({
          table,
          source: 0,
          target: 0,
          sourceDigest: '',
          targetDigest: '',
          ok: false,
          skipped: 'the target table already holds rows; pass --truncate to replace them',
        })
        continue
      }

      const sourceHashes: Uint8Array[] = []
      let copied = 0

      await readTable(source, options.from, table, shared, async (page) => {
        for (const row of page)
          sourceHashes.push(rowDigest(row, names))

        await insertRows(target, options.to, table, shared, page)
        copied += page.length
      }, options.pageSize ?? 1000)

      await resetAutoIncrement(target, options.to, table)

      /*
       * Read back through the target's own driver rather than trusting the
       * insert's row count. The point is to catch a value that changed on the
       * way in - a boolean, a timestamp, a number that lost its scale - and
       * only the round trip can see that.
       */
      const targetHashes: Uint8Array[] = []
      const landed = await readTable(target, options.to, table, shared, (page) => {
        for (const row of page)
          targetHashes.push(rowDigest(row, names))
      }, options.pageSize ?? 1000)

      const report: TableReport = {
        table,
        source: copied,
        target: landed,
        sourceDigest: foldDigests(sourceHashes),
        targetDigest: foldDigests(targetHashes),
        ok: false,
      }

      report.ok = report.source === report.target && report.sourceDigest === report.targetDigest
      rows += copied
      tables.push(report)
      options.onTable?.(report)
    }

    return { tables, rows, ok: tables.every(table => table.ok) }
  }
  finally {
    if (options.to.adapter === 'mysql') {
      await target.unsafe('SET FOREIGN_KEY_CHECKS=1').catch(() => {})
      await target.unsafe('SET UNIQUE_CHECKS=1').catch(() => {})
    }
    else {
      await target.unsafe(`SET session_replication_role = 'origin'`).catch(() => {})
    }

    await source.close().catch(() => {})
    await target.close().catch(() => {})
  }
}

/** The report, as an operator reads it. */
export function describeMigration(report: MigrationReport): string[] {
  const lines: string[] = []
  const moved = report.tables.filter(table => !table.skipped)
  const failed = report.tables.filter(table => !table.ok)

  lines.push(`${moved.length} tables, ${report.rows} rows.`)

  for (const table of failed) {
    lines.push(table.skipped
      ? `  ${table.table}: ${table.skipped}`
      : `  ${table.table}: ${table.source} rows out, ${table.target} in${table.sourceDigest === table.targetDigest ? '' : ', and the values do not match'}`)
  }

  if (report.ok)
    lines.push('Every table matched on both count and checksum.')

  return lines
}

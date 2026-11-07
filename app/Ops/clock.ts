import { db, utcDefaultSql } from '@stacksjs/database'
import { currentDialect, speaksMysql } from '../Actions/Support/sql'

export interface ClockDatabase { unsafe: (sql: string) => { execute: () => Promise<unknown> } }

/** Inspect legacy defaults only. Existing timestamp values are never rewritten. */
export async function sessionClockDefaults(connection: ClockDatabase = db, dialect = currentDialect()): Promise<Array<{ table: string, column: string }>> {
  if (dialect === 'sqlite') return []
  // Catalog introspection is not available through the model query API.
  const rows = await connection.unsafe(`SELECT table_name, column_name FROM information_schema.columns
    WHERE table_schema = ${speaksMysql(dialect) ? 'DATABASE()' : 'current_schema()'}
    AND (data_type LIKE 'timestamp%' OR data_type = 'datetime')
    AND column_default IS NOT NULL AND LOWER(column_default) NOT LIKE '%utc%'
    AND (LOWER(column_default) LIKE '%current_timestamp%' OR LOWER(column_default) = 'now()')
    ORDER BY table_name, column_name`).execute()
  return (Array.isArray(rows) ? rows : []).map(row => ({ table: String(row.table_name ?? row.TABLE_NAME), column: String(row.column_name ?? row.COLUMN_NAME) }))
}

/** Use the framework's identifier validation and UTC DDL generator for legacy schema drift. */
export async function repairClockDefaults(options: { apply?: boolean, connection?: ClockDatabase, dialect?: string } = {}) {
  const connection = options.connection ?? db
  const dialect = options.dialect ?? currentDialect()
  const targets = await sessionClockDefaults(connection, dialect)
  const statements = targets.map(target => utcDefaultSql(target, dialect))
  if (options.apply) {
    for (const sql of statements) await connection.unsafe(sql).execute()
    if ((await sessionClockDefaults(connection, dialect)).length) throw new Error('Timestamp defaults remain unpinned; retry the repair after reviewing the schema')
  }
  return { targets, statements, applied: options.apply ? statements.length : 0 }
}

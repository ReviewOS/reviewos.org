import { SQL } from 'bun'
import { expect, test } from 'bun:test'
import { withDisposableDatabase, disposablePostgresUrl } from '@stacksjs/testing/disposable-database'
import { repairClockDefaults, sessionClockDefaults } from '../../app/Ops/clock'

const local = new URL('postgres://127.0.0.1/postgres')
local.hostname = process.env.DB_HOST || '127.0.0.1'; local.port = process.env.DB_PORT || '5432'
local.username = process.env.DB_USERNAME || 'postgres'; local.password = process.env.DB_PASSWORD || ''
const url = process.env.REVIEWOS_TEST_POSTGRES_URL || disposablePostgresUrl() || (['postgres', 'postgresql'].includes(process.env.DB_CONNECTION || '') ? local.href : undefined)

test.skipIf(!url)('legacy UTC repair changes defaults only and is safe to repeat', async () => {
  await withDisposableDatabase('postgres', async (database) => {
    const sql = new SQL({ url: database.url!, max: 1 })
    const connection = { unsafe: (query: string) => ({ execute: async () => await sql.unsafe(query) }) }
    try {
      await sql.unsafe("SET TIME ZONE 'Pacific/Honolulu'")
      await sql.unsafe("CREATE TABLE clock_fixture (id integer, created_at timestamp DEFAULT CURRENT_TIMESTAMP, updated_at timestamp)")
      await sql.unsafe("CREATE TABLE pinned_fixture (created_at timestamp DEFAULT (now() AT TIME ZONE 'utc'))")
      await sql.unsafe("INSERT INTO clock_fixture (id,created_at) VALUES (1,'2001-02-03 04:05:06')")
      const preview = await repairClockDefaults({ connection, dialect: 'postgres' })
      expect(preview.applied).toBe(0); expect(preview.targets).toEqual([{ table: 'clock_fixture', column: 'created_at' }])
      expect(await sessionClockDefaults(connection, 'postgres')).toHaveLength(1)
      expect((await repairClockDefaults({ connection, dialect: 'postgres', apply: true })).applied).toBe(1)
      await sql.unsafe('INSERT INTO clock_fixture (id) VALUES (2)')
      const rows = await sql.unsafe("SELECT id, to_char(created_at,'YYYY-MM-DD HH24:MI:SS') AS value, abs(extract(epoch FROM ((created_at AT TIME ZONE 'UTC')-now()))) AS skew, updated_at FROM clock_fixture ORDER BY id")
      expect(rows[0].value).toBe('2001-02-03 04:05:06'); expect(Number(rows[1].skew)).toBeLessThan(2)
      expect(rows[1].updated_at).toBeNull()
      expect((await repairClockDefaults({ connection, dialect: 'postgres', apply: true })).applied).toBe(0)
    } finally { await sql.close() }
  }, { url, prefix: 'reviewos_clock_fixture' })
})

// Query logging is off in production unless somebody turns it on.
//
// config/database.ts said `DB_QUERY_LOGGING_ENABLED ?? true`, so production
// logged every statement: 39 GB of query_logs by 2026-10-31, a full root disk
// and a Postgres PANIC on a server other apps share. The deploy rewrites the
// release .env, so the default in source is the only setting that lasts.

import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '../..')

async function enabledWith(env: Record<string, string>): Promise<unknown> {
  const child = Bun.spawn([process.execPath, '-e', `const { default: c } = await import(${JSON.stringify(join(ROOT, 'config/database.ts'))}); console.log(JSON.stringify(c.queryLogging.enabled))`], {
    cwd: ROOT,
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  if (code !== 0)
    throw new Error(err)
  return JSON.parse(out.trim().split('\n').at(-1)!)
}

describe('query logging', () => {
  test('is off in production by default', async () => {
    expect(await enabledWith({ APP_ENV: 'production' })).toBe(false)
  })

  test('is on outside production, where the dashboard is useful', async () => {
    expect(await enabledWith({ APP_ENV: 'local' })).toBe(true)
  })

  test('and an explicit setting wins either way', async () => {
    expect(await enabledWith({ APP_ENV: 'production', DB_QUERY_LOGGING_ENABLED: 'true' })).toBe(true)
    expect(await enabledWith({ APP_ENV: 'local', DB_QUERY_LOGGING_ENABLED: 'false' })).toBe(false)
  })
}, 30_000)

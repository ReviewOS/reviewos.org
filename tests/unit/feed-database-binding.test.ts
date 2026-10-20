import { expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'

// The app preloader supplies db to ordinary requests. SSG imports the same
// reader without that preloader, so test its dependency in a fresh process.
// The adapter fixture performs no real database access or service startup.
test('the feed reader owns its database binding without application globals', async () => {
  const program = `
    const assert = require('node:assert/strict')
    const { mock } = require('bun:test')
    assert.equal(typeof globalThis.db, 'undefined')
    let reads = 0
    const query = {
      innerJoin() { return this },
      select() { return this },
      where() { return this },
      orderBy() { return this },
      limit() { return this },
      async execute() { return [] },
    }
    mock.module('@stacksjs/database', () => ({
      db: { selectFrom() { reads++; return query } },
    }))
    const { discoverFeed } = await import('./app/Actions/Feed/read.ts')
    assert.deepEqual(await discoverFeed(), { entries: [], cursor: null })
    assert.equal(reads, 1)
    assert.equal(typeof globalThis.db, 'undefined')
    console.log('feed database dependency resolved without globals')
  `
  const child = Bun.spawn([process.execPath, '--no-env-file', '--config=/dev/null', '-e', program], {
    cwd: fileURLToPath(new URL('../..', import.meta.url)),
    env: { PATH: process.env.PATH },
    stdout: 'pipe',
    stderr: 'pipe',
    signal: AbortSignal.timeout(5_000),
  })
  const [output, error, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  expect({ code, error }).toEqual({ code: 0, error: '' })
  expect(output.trim()).toBe('feed database dependency resolved without globals')
}, 10_000)

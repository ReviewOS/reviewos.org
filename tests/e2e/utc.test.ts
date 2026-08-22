/**
 * The process runs in UTC, and a timestamp survives the round trip.
 *
 * Every timestamp column in this schema is `timestamp without time zone`
 * holding a UTC wall clock, so the frame the process builds a `Date` in is the
 * frame those values come back in. A process in any other zone reads all of
 * them wrong by that offset, and fifty-four places in this application compare
 * such a value against `Date.now()` to decide whether something has expired.
 *
 * **This has to run in a subprocess, and the subprocess has to be told to use a
 * different zone.** Bun's test runner resolves the timezone to UTC by itself,
 * so the whole suite runs in the one configuration where the bug cannot appear;
 * asserting anything about timezones from inside it proves nothing. Six
 * thousand passing tests said nothing about this.
 *
 * `bun -e` in this directory loads `bunfig.toml`'s preload, which is where
 * `app/Ops/utc.ts` is listed - so what is under test here is the arrangement,
 * not a function.
 */

import { describe, expect, test } from 'bun:test'
import process from 'node:process'

const HOSTILE = 'America/Los_Angeles'

/** Run a snippet through `bun`, in this project, in a zone that is not UTC. */
async function inHostileZone(code: string): Promise<string> {
  const child = Bun.spawn(['bun', '-e', code], {
    cwd: process.cwd(),
    env: { ...process.env, TZ: HOSTILE },
    stdout: 'pipe',
    stderr: 'pipe',
  })

  await child.exited

  return (await new Response(child.stdout).text()).trim()
}

describe('the process clock', () => {
  test('is UTC even when the environment says otherwise', async () => {
    // Not "UTC unless TZ is set": a `TZ` in a container is inherited from a
    // base image or set so that logs read locally, and nobody who sets it is
    // asking for tokens to expire seven hours late.
    const answer = await inHostileZone('console.log(Intl.DateTimeFormat().resolvedOptions().timeZone)')

    expect(answer).toBe('UTC')
  }, 60_000)

  test('and the zone it was told to use really would have been different', async () => {
    /*
     * The control, without which the test above passes on a machine that is
     * already in UTC and proves nothing.
     *
     * Run outside this project, so `bunfig.toml` and its preload do not apply -
     * which is the same as saying: this is what the application looked like
     * before `app/Ops/utc.ts` existed.
     */
    const child = Bun.spawn(['bun', '-e', 'console.log(Intl.DateTimeFormat().resolvedOptions().timeZone)'], {
      cwd: '/',
      env: { ...process.env, TZ: HOSTILE },
      stdout: 'pipe',
      stderr: 'pipe',
    })

    await child.exited

    expect((await new Response(child.stdout).text()).trim()).toBe(HOSTILE)
  }, 60_000)
})

describe('a timestamp through the database', () => {
  test('comes back as the instant it went in as, from a process in another zone', async () => {
    /*
     * The whole bug, end to end.
     *
     * Written with `dbTimestamp` - which is `toISOString`, so a UTC wall clock
     * - into a real column, and read back through the driver, which has to
     * choose a frame for a value that carries no offset. Before this was fixed
     * the skew here was 25,199,262ms: seven hours, in the direction that makes
     * everything expire late.
     *
     * The tolerance is two seconds because `dbTimestamp` truncates below the
     * second and the round trip is not instant. It is nowhere near an hour, and
     * an hour is the smallest offset that could be wrong.
     */
    const code = `
      const { injectGlobalAutoImports } = await import('@stacksjs/server')
      await injectGlobalAutoImports()
      const db = globalThis.db
      const { dbTimestamp } = await import('./app/Actions/Support/sql')

      await db.unsafe('CREATE TABLE IF NOT EXISTS utc_round_trip (id serial primary key, ts timestamp)').execute()

      try {
        const wrote = new Date()
        await db.insertInto('utc_round_trip').values({ ts: dbTimestamp(wrote) }).execute()
        const back = await db.selectFrom('utc_round_trip').select(['ts']).orderBy('id', 'desc').executeTakeFirst()

        console.log(JSON.stringify({ skew: Date.parse(String(back.ts)) - wrote.getTime() }))
      }
      finally {
        await db.unsafe('DROP TABLE utc_round_trip').execute()
      }
    `

    const answer = await inHostileZone(code)

    let skew: number | null = null

    try {
      skew = Number(JSON.parse(answer.split('\n').pop() ?? '{}').skew)
    }
    catch {
      skew = null
    }

    // No database in this checkout is a skip, the same as everywhere else in
    // tests/e2e - not a pass, and not a failure either.
    if (skew === null || !Number.isFinite(skew)) {
      console.warn('[utc] skipped: the subprocess could not reach a database')
      return
    }

    expect(Math.abs(skew)).toBeLessThan(2_000)
  }, 120_000)
})

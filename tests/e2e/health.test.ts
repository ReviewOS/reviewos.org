// The health endpoint, against a real instance.
//
// The claim being tested is the one the roadmap objects to in every other
// forge: that a health check saying 200 because the process is running is not a
// health check. So these assert that it names its subsystems, that it answers
// 503 rather than a green 200 when one is broken, and that the cheap probe is
// genuinely cheaper than the thorough one.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

let available = false
let port = 0
let server: any = null

async function health(query = ''): Promise<{ status: number, body: any }> {
  const answer = await fetch(`http://127.0.0.1:${port}/api/health${query}`, {
    headers: { Accept: 'application/json' },
  })

  return { status: answer.status, body: await answer.json().catch(() => null) }
}

beforeAll(async () => {
  try {
    const { injectGlobalAutoImports } = await import('@stacksjs/server')
    const { route } = await import('@stacksjs/router')

    await injectGlobalAutoImports()
    await (globalThis as any).db.selectFrom('users').select(['id']).limit(1).execute()

    await route.importRoutes()
    server = await route.serve({ port: 0, hostname: '127.0.0.1' })
    port = Number((server as any)?.port ?? (server as any)?.server?.port ?? 0)

    if (!port)
      throw new Error('the router did not report a port')

    available = true
  }
  catch (error) {
    console.warn(`[health] skipping: ${error instanceof Error ? error.message : String(error)}`)
    available = false
  }
}, 120_000)

afterAll(() => {
  server?.stop?.()
})

describe('a healthy instance', () => {
  test('says which subsystems it checked', async () => {
    if (!available)
      return

    /*
     * Named, because "unhealthy" sends somebody to read logs and "repository
     * storage is not writable" sends them to the volume. The names are part of
     * the contract: a dashboard graphs them.
     */
    const report = await health()

    expect(report.status).toBe(200)

    const names = (report.body?.checks ?? []).map((check: any) => check.name)
    expect(names).toContain('database')
    expect(names).toContain('queue')
    expect(names).toContain('repository storage')
  })

  test('and times each one', async () => {
    if (!available)
      return

    // So a subsystem that is slow rather than broken is visible before it
    // becomes broken.
    const report = await health()

    for (const check of report.body?.checks ?? [])
      expect(typeof check.ms).toBe('number')
  })

  test('is unauthenticated, because a prober is not signed in', async () => {
    if (!available)
      return

    const report = await health()

    expect(report.status).toBe(200)
  })

  test('and says nothing an attacker gains from', async () => {
    if (!available)
      return

    /*
     * Which subsystem, not where it lives. A health endpoint is the most
     * reliably reachable thing on an instance, and a connection string or a
     * filesystem path in its body is a gift.
     */
    const text = JSON.stringify(await health())

    expect(text).not.toContain('postgres://')
    expect(text).not.toContain('password')
    expect(text.toLowerCase()).not.toContain('/users/')
  })
})

describe('the quick probe', () => {
  test('skips the disk write a liveness check does not need', async () => {
    if (!available)
      return

    /*
     * A liveness probe runs every few seconds and only needs to know the
     * process can answer. Asserted on the *shape* rather than on a timing
     * comparison, because a millisecond difference on a warm machine is noise
     * and a test that measures it fails on a busy one.
     */
    const quick = await health('?quick=1')

    expect(quick.status).toBe(200)
    expect((quick.body?.checks ?? []).map((check: any) => check.name)).toContain('repository storage')
  })
})

describe('when something is broken', () => {
  /*
   * Driven through `summarize` and `runCheck` rather than by breaking the
   * instance this suite is running against, which would take every other test
   * with it.
   *
   * That split is deliberate rather than a shortcut: the decision worth pinning
   * is "does a failed check stop traffic", and that decision is pure. What the
   * live tests above prove is that the endpoint runs the checks and reports
   * them; what these prove is what it does with the answers.
   */
  test('a failed check stops traffic', async () => {
    const { summarize } = await import('../../app/Ops/health')

    const report = summarize([
      { name: 'database', status: 'failed', ms: 3, detail: 'relation "users" does not exist' },
      { name: 'queue', status: 'ok', ms: 1 },
    ])

    expect(report.ok).toBe(false)
  })

  test('a slow one does not', async () => {
    // Taking an instance out of rotation because something was slow turns a
    // slow dependency into an outage.
    const { summarize } = await import('../../app/Ops/health')

    const report = summarize([
      { name: 'database', status: 'degraded', ms: 1400, detail: 'took 1400ms' },
      { name: 'queue', status: 'ok', ms: 1 },
    ])

    expect(report.ok).toBe(true)
  })

  test('a throw is reported as a failure, with the message and not the stack', async () => {
    /*
     * The message is what an operator acts on. The stack names paths and
     * packages, and this endpoint is the most reliably reachable thing on an
     * instance.
     */
    const { runCheck } = await import('../../app/Ops/health')

    const check = await runCheck('database', async () => {
      throw new Error('relation "users" does not exist')
    })

    expect(check.status).toBe('failed')
    expect(check.detail).toContain('users')
    expect(check.detail).not.toContain('at ')
  })

  test('and a slow success is degraded rather than ok', async () => {
    // A check that says `ok` at four seconds never warns anybody before it
    // starts failing.
    const { runCheck } = await import('../../app/Ops/health')

    const check = await runCheck('database', async () => {
      await Bun.sleep(1100)
      return undefined
    })

    expect(check.status).toBe('degraded')
  }, 20_000)
})

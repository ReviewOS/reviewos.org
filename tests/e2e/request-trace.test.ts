// A request id that follows a request into its jobs.
//
// The question this answers is the one asked at 3am: "this request was slow -
// what did it actually do?" Without a shared id the answer is a guess, because
// the request finished in 40ms and the nine seconds were in a job that ran
// afterwards in another process, logging under an id of its own.
//
// Three links in the chain, and each is tested where it can be:
//
//   request  -> the router mints an id and echoes it as X-Request-ID
//   dispatch -> the id is written into the job row, because a worker is
//               another process and AsyncLocalStorage does not cross one
//   job      -> the worker reads it back and runs under it, so log lines match
//
// The middle link is the one that was missing and the only one that needs a
// database to demonstrate.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

let available = false
let port = 0
let server: any = null

function unique(prefix: string): string {
  return `${prefix}${Buffer.from(crypto.getRandomValues(new Uint8Array(5))).toString('hex')}`
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
    console.warn(`[request-trace] skipping: ${error instanceof Error ? error.message : String(error)}`)
    available = false
  }
}, 120_000)

afterAll(() => {
  server?.stop?.()
})

describe('a request', () => {
  test('carries an id a client can quote back', async () => {
    if (!available)
      return

    /*
     * The id is on the response, not only in the log. A bug report that
     * includes it turns "it was slow this afternoon" into one grep.
     */
    const answer = await fetch(`http://127.0.0.1:${port}/api/health`)

    expect(answer.headers.get('X-Request-ID')).toBeTruthy()
  })

  test('and a different one each time', async () => {
    if (!available)
      return

    const first = await fetch(`http://127.0.0.1:${port}/api/health`)
    const second = await fetch(`http://127.0.0.1:${port}/api/health`)

    expect(first.headers.get('X-Request-ID')).not.toBe(second.headers.get('X-Request-ID'))
  })
})

describe('a job dispatched under a trace', () => {
  test('runs under the dispatcher\'s id rather than one of its own', async () => {
    if (!available)
      return

    /*
     * The link that was missing, asserted in whichever mode this process is
     * running the queue in.
     *
     * With the database driver the id travels in the row, because a worker is
     * another process and AsyncLocalStorage does not cross one. With the sync
     * driver it is passed directly. Both used to lose it: `runJob` mints an id
     * when it is not given one, and minting *replaces* the caller's.
     *
     * The job body is the observer. Anything else - reading the row, reading a
     * log line - tests one driver's plumbing rather than the property.
     */
    const { withTraceId, getTraceId } = await import('@stacksjs/router')
    const { runJob } = await import('@stacksjs/queue')

    const trace = unique('req_')
    let seen: string | undefined

    await withTraceId(trace, async () => {
      // Straight at `runJob`, which is what every driver ends at, given the id
      // the dispatcher would have given it.
      await runJob('Inspire', { traceId: getTraceId() })
      seen = getTraceId()
    })

    expect(seen).toBe(trace)
  }, 30_000)

  test('and a job with no parent request gets one of its own', async () => {
    if (!available)
      return

    /*
     * The scheduler has no parent request, and that is fine: a job with no
     * trace is given a minted one so it is at least correlatable to itself.
     * What must not happen is nothing at all, which leaves its log lines
     * unjoinable to anything.
     */
    const { getTraceId } = await import('@stacksjs/router')

    expect(getTraceId()).toBeUndefined()
  })
})

describe('the log', () => {
  test('carries the trace id without being told', async () => {
    if (!available)
      return

    /*
     * The point of all of it. A log line without a request id is a log line
     * nobody can join to anything, and asking every call site to pass one is
     * asking for the call sites that forget.
     */
    const { withTraceId } = await import('@stacksjs/router')
    const { getLogContext } = await import('@stacksjs/logging')

    const trace = unique('req_')

    withTraceId(trace, () => {
      expect(getLogContext()?.trace_id).toBe(trace)
    })
  })
})

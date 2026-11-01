import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runLoop, runOnce } from '../../app/Actions/Runner/localExecutor'

/**
 * An instance that is briefly unreachable - a deploy restarting its gateway -
 * is something a runner waits out, not something that ends it or its job.
 */

const job = (id: number, steps: any[]) => ({
  id, token: `outage-${id}`, key: 'outage', checkout: { skip: true },
  repository_full_name: 'acme/widgets',
  run: { id: 1, number: 1, event: 'push', ref: 'refs/heads/main', head_sha: 'abc' },
  steps,
})

test('the loop keeps running through a claim that cannot connect, then takes the work', async () => {
  const root = mkdtempSync(join(tmpdir(), 'reviewos-outage-loop-'))
  // A port nobody listens on yet: the first claims are refused connections.
  const probe = Bun.serve({ port: 0, fetch: () => new Response('') })
  const port = probe.port!
  probe.stop(true)

  const said: string[] = []
  let server: ReturnType<typeof Bun.serve> | undefined
  let offered = false
  const opening = Bun.sleep(400).then(() => {
    server = Bun.serve({ hostname: '127.0.0.1', port, async fetch(request) {
      const path = new URL(request.url).pathname
      if (path === '/api/runner/claim') {
        if (offered) return Response.json({})
        offered = true
        return Response.json({ job: job(9501, [{ run: 'echo after the outage' }]) })
      }
      return Response.json({ ok: true, held: true })
    } })
  })

  try {
    const outcomes = await runLoop({ baseUrl: `http://127.0.0.1:${port}`, token: 'runner', workspaceRoot: root, tools: false, idleMs: 50, maxJobs: 1, minimumFreeDiskMb: 0, maximumLoadPerCpu: 0, say: line => said.push(line) })

    expect(outcomes.map(one => one.state)).toEqual(['succeeded'])
    // Said once for the outage, and once when it ended - not once per retry.
    expect(said.filter(line => line.startsWith('The instance could not be reached'))).toHaveLength(1)
    expect(said).toContain('The instance answered again; accepting work')
  }
  finally {
    await opening
    server?.stop(true)
    rmSync(root, { recursive: true, force: true })
  }
}, 30_000)

test('a conclusion that meets a restarting gateway is delivered once it is back, and never turned into a failure', async () => {
  const root = mkdtempSync(join(tmpdir(), 'reviewos-outage-report-'))
  const reports: any[] = []
  let claimed = false
  let refused = 0
  const server = Bun.serve({ port: 0, async fetch(request) {
    const path = new URL(request.url).pathname
    const body: any = await request.json().catch(() => ({}))
    if (path === '/api/runner/claim') {
      if (claimed) return Response.json({})
      claimed = true
      return Response.json({ job: job(9502, [{ run: 'echo done' }]) })
    }
    if (path === '/api/runner/report') {
      // What a gateway in the middle of a deploy answers.
      if (refused++ < 3) return new Response('Bad Gateway', { status: 502 })
      reports.push(body)
    }
    return Response.json({ ok: true, held: true })
  } })

  try {
    const outcome = await runOnce({ baseUrl: `http://127.0.0.1:${server.port}`, token: 'runner', workspaceRoot: root, tools: false, minimumFreeDiskMb: 0, maximumLoadPerCpu: 0 })

    expect(outcome?.state).toBe('succeeded')
    expect(refused).toBe(4)
    expect(reports.map(one => one.state)).toEqual(['succeeded'])
  }
  finally {
    server.stop(true)
    rmSync(root, { recursive: true, force: true })
  }
}, 30_000)

test('a refused conclusion is not retried', async () => {
  const root = mkdtempSync(join(tmpdir(), 'reviewos-outage-refused-'))
  let claimed = false
  let reports = 0
  const said: string[] = []
  const server = Bun.serve({ port: 0, async fetch(request) {
    const path = new URL(request.url).pathname
    if (path === '/api/runner/claim') {
      if (claimed) return Response.json({})
      claimed = true
      return Response.json({ job: job(9503, [{ run: 'true' }]) })
    }
    if (path === '/api/runner/report') {
      reports++
      return Response.json({ error: 'this lease has expired' }, { status: 409 })
    }
    return Response.json({ ok: true, held: true })
  } })

  try {
    const outcome = await runOnce({ baseUrl: `http://127.0.0.1:${server.port}`, token: 'runner', workspaceRoot: root, tools: false, minimumFreeDiskMb: 0, maximumLoadPerCpu: 0, say: line => said.push(line) })

    expect(outcome?.state).toBe('succeeded')
    expect(reports).toBe(1)
    expect(said.join('\n')).toContain('the instance did not take the conclusion (HTTP 409 this lease has expired)')
  }
  finally {
    server.stop(true)
    rmSync(root, { recursive: true, force: true })
  }
}, 30_000)

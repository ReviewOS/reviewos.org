import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runOnce } from '../../app/Actions/Runner/localExecutor'
import { RunnerLease } from '../../app/Actions/Runner/lease'

const leases: RunnerLease[] = []
afterEach(() => leases.splice(0).forEach(lease => lease.dispose()))

test('a refused credential stops ownership immediately, while transport failures retain only the existing lease', async () => {
  for (const status of [400, 401, 403, 404, 409, 410]) {
    const lease = new RunnerLease()
    leases.push(lease)
    lease.refuse(status, 'no longer yours')
    expect(lease.signal.aborted).toBe(true)
    lease.renew()
    expect(lease.signal.aborted).toBe(true)
  }
  const lease = new RunnerLease(20)
  leases.push(lease)
  for (const status of [undefined, 408, 429, 500, 503]) {
    lease.refuse(status, 'retry')
    expect(lease.signal.aborted).toBe(false)
  }
  await Bun.sleep(40)
  expect(lease.signal.aborted).toBe(true)
})

test('a late heartbeat cannot reactivate a concluded lease', async () => {
  const lease = new RunnerLease(10)
  lease.dispose()
  lease.renew()
  lease.refuse(409, 'the job already finished')
  await Bun.sleep(30)
  expect(lease.signal.aborted).toBe(false)
})

test('an initially revoked lease executes no repository commands', async () => {
  const root = mkdtempSync(join(tmpdir(), 'reviewos-initial-refusal-'))
  const server = Bun.serve({ port: 0, async fetch(request) {
    const path = new URL(request.url).pathname
    if (path === '/api/runner/claim') return Response.json({ job: {
      id: 9155, token: 'initially-revoked', key: 'revoked', checkout: { skip: true },
      repository_full_name: 'acme/widgets',
      run: { id: 1, number: 1, event: 'push', ref: 'refs/heads/main', head_sha: 'abc' },
      steps: [{ run: 'touch should-never-run' }],
    } })
    if (path === '/api/runner/heartbeat') return Response.json({ error: 'revoked' }, { status: 401 })
    return Response.json({ ok: true })
  } })
  try {
    const outcome = await runOnce({ baseUrl: `http://127.0.0.1:${server.port}`, token: 'runner', workspaceRoot: root, tools: false })
    expect(outcome?.state).toBe('cancelled')
    expect(existsSync(join(root, 'job-9155', 'should-never-run'))).toBe(false)
  }
  finally {
    server.stop(true)
    rmSync(root, { recursive: true, force: true })
  }
})

for (const channel of ['heartbeat', 'logs']) test(`revocation through ${channel} stops an active process tree and never dispatches the next always step`, async () => {
  const root = mkdtempSync(join(tmpdir(), 'reviewos-revoked-lease-'))
  let claimed = false
  let beats = 0
  const reports: any[] = []
  const server = Bun.serve({ port: 0, async fetch(request) {
    const path = new URL(request.url).pathname
    const body: any = await request.json().catch(() => ({}))
    if (path === '/api/runner/claim') {
      if (claimed) return Response.json({})
      claimed = true
      return Response.json({ job: {
        id: 9154, token: 'revoked-job-token', key: 'revoked', checkout: { skip: true },
        repository_full_name: 'acme/widgets',
        run: { id: 1, number: 1, event: 'push', ref: 'refs/heads/main', head_sha: 'abc' },
        steps: [
          { name: 'Long operation', timeout_minutes: 0.5, run: 'sleep 120 & echo $! > child.pid; printf "LEASE-ACTIVE\\n"; wait' },
          { name: 'Must not execute', if: 'always()', run: 'touch revoked-work-ran' },
        ],
      } })
    }
    if (channel === 'heartbeat' && path === '/api/runner/heartbeat' && ++beats > 1)
      return Response.json({ error: 'This job is no longer yours' }, { status: 409 })
    if (channel === 'logs' && path === '/api/runner/logs' && String(body.content).split('\n').includes('LEASE-ACTIVE'))
      return Response.json({ error: 'This job is no longer yours' }, { status: 401 })
    if (path === '/api/runner/report') reports.push(body)
    return Response.json({ ok: true, held: true })
  } })
  const unrelated = Bun.spawn(['sleep', '120'], { stdout: 'ignore', stderr: 'ignore' })
  try {
    const outcome = await runOnce({ baseUrl: `http://127.0.0.1:${server.port}`, token: 'runner', workspaceRoot: root, tools: false })
    expect(outcome?.state).toBe('cancelled')
    expect(existsSync(join(root, 'job-9154', 'revoked-work-ran'))).toBe(false)
    expect(reports.at(-1)?.state).toBe('cancelled')
    const child = Number(readFileSync(join(root, 'job-9154', 'child.pid'), 'utf8').trim())
    expect(() => process.kill(child, 0)).toThrow()
    expect(unrelated.exitCode).toBe(null)
  }
  finally {
    unrelated.kill()
    await unrelated.exited
    server.stop(true)
    rmSync(root, { recursive: true, force: true })
  }
}, 45_000)

// Existing runner HTTP seam: observe admission on the wire using the real
// workspace filesystem. This cannot prove a controller leaves leases untouched;
// that belongs to the real-controller runner-local suite.
import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runOnce, takeStopRequest } from '../../app/Actions/Runner/localExecutor'
import { negotiate } from '../../app/Actions/Runner/protocol'

test('host load holds job admission while stop requests and recovery remain live', async () => {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, '../fixtures/runner-host-load.fixture.ts')], {
    stdout: 'pipe', stderr: 'pipe', signal: AbortSignal.timeout(10_000),
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ])
  if (code !== 0) throw new Error(stderr)
  const result = JSON.parse(stdout.trim().split('\n').at(-1)!)
  expect(result.polls).toEqual([{ accept_work: false, hold_reason: expect.stringContaining('load') }, {}])
  expect(result.stop).toBe('graceful')
  expect(result.messages[0]).toContain('load')
  expect(result.messages.at(-1)).toContain('capacity restored')
  expect(result.decisions).toEqual({
    atLimit: true, invalidLoad: false, invalidCpus: false, unreadable: false,
    unsupported: false, disabled: true, defaultDisabled: true,
    'invalidPolicy:': false, 'invalidPolicy:invalid': false,
    'invalidPolicy:-1': false, 'invalidPolicy:Infinity': false,
  })
}, 15_000)

test('insufficient workspace space holds work but still receives a graceful stop', async () => {
  const root = mkdtempSync(join(tmpdir(), 'reviewos-capacity-'))
  const polls: Array<{ protocol: string | null, body: any }> = []
  const messages: string[] = []
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      expect(new URL(request.url).pathname).toBe('/api/runner/claim')
      polls.push({ protocol: request.headers.get('X-Runner-Protocol'), body: await request.json() })
      return Response.json({ job: null, runner_id: 5, stop: 'graceful' })
    },
  })
  try {
    const outcome = await runOnce({
      baseUrl: `http://127.0.0.1:${server.port}`,
      token: 'capacity-fixture',
      workspaceRoot: root,
      // An impossible floor exercises real statfs without filling the disk.
      minimumFreeDiskMb: 1_000_000_000,
      say: line => messages.push(line),
    })
    expect(outcome).toBeNull()
    expect(polls).toEqual([{ protocol: '2', body: { accept_work: false, hold_reason: expect.stringContaining('MiB required') } }])
    expect(takeStopRequest()).toBe('graceful')
    expect(messages.join('\n')).toContain('disk')
  }
  finally {
    takeStopRequest()
    server.stop(true)
    rmSync(root, { recursive: true, force: true })
  }
})

test('unmeasurable workspace space holds work and an older controller refuses the new contract', async () => {
  const root = mkdtempSync(join(tmpdir(), 'reviewos-capacity-old-'))
  const polls: any[] = []
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const decision = negotiate(request.headers.get('X-Runner-Protocol') ?? '', { minimum: 1, current: 1 })
    polls.push(await request.json())
    expect(decision.ok).toBe(false)
    return Response.json({ error: decision.reason }, { status: 426 })
  } })
  try {
    await expect(runOnce({
      baseUrl: `http://127.0.0.1:${server.port}`, token: 'capacity-fixture',
      workspaceRoot: join(root, 'missing'), minimumFreeDiskMb: 1,
    })).rejects.toThrow('upgrade the server')
    expect(polls).toEqual([{ accept_work: false, hold_reason: expect.stringContaining('Cannot verify available workspace disk space') }])
  }
  finally {
    server.stop(true)
    rmSync(root, { recursive: true, force: true })
  }
})

test('resumes normal polling after capacity returns without logging every held poll', async () => {
  const root = mkdtempSync(join(tmpdir(), 'reviewos-capacity-resume-'))
  const polls: any[] = []
  const messages: string[] = []
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    polls.push(await request.json())
    return Response.json({ job: null, runner_id: 5 })
  } })
  const options = {
    baseUrl: `http://127.0.0.1:${server.port}`, token: 'capacity-fixture',
    workspaceRoot: root, minimumFreeDiskMb: 1_000_000_000,
    say: (line: string) => messages.push(line),
  }
  try {
    await runOnce(options)
    await runOnce(options)
    expect(messages).toHaveLength(1)
    options.minimumFreeDiskMb = 1
    await runOnce(options)
    expect(polls).toEqual([{ accept_work: false, hold_reason: expect.stringContaining('disk space') }, { accept_work: false, hold_reason: expect.stringContaining('disk space') }, {}])
    expect(messages.at(-1)).toContain('restored')
  }
  finally {
    server.stop(true)
    rmSync(root, { recursive: true, force: true })
  }
})

test.each([Number.NaN, Number.POSITIVE_INFINITY, -1, 0.5, Number.MAX_SAFE_INTEGER])('invalid capacity floor %s cannot enable work', async (minimumFreeDiskMb) => {
  const polls: unknown[] = []
  const messages: string[] = []
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    polls.push(await request.json())
    return Response.json({ job: null, runner_id: 5 })
  } })
  try {
    expect(await runOnce({
      baseUrl: `http://127.0.0.1:${server.port}`, token: 'capacity-fixture', minimumFreeDiskMb,
      say: line => messages.push(line),
    })).toBeNull()
    expect(polls).toEqual([{ accept_work: false, hold_reason: expect.stringContaining('setting') }])
    expect(messages.join('\n')).toContain('setting')
  }
  finally { server.stop(true) }
})

test('SIGUSR2 finishes what the runner holds and stops it before the next claim', async () => {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, '../fixtures/runner-drain-signal.fixture.ts')], {
    stdout: 'pipe', stderr: 'pipe', signal: AbortSignal.timeout(10_000),
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ])
  if (code !== 0) throw new Error(stderr)
  const result = JSON.parse(stdout.trim().split('\n').at(-1)!)
  // One poll, then the signal: the loop leaves instead of claiming again.
  expect(result.claims).toBe(1)
  expect(result.messages.join('\n')).toContain('SIGUSR2')
  expect(result.messages.join('\n')).toContain('stopping before the next claim')
}, 15_000)

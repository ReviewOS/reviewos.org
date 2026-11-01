import { expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'

/**
 * A runner stopped mid-job stops the job's processes before it exits.
 *
 * `launchctl kickstart -k` restarted the Mac runner while HQ job 7011 ran
 * (2026-11-01). The old handler signalled the steps' process groups and exited
 * at once, so the PostgreSQL a setup step had started in a session of its own
 * kept running in the job's workspace, and the next attempt of the same job
 * ran beside it. And a stopped runner reaches no verdict about the work: it
 * reports nothing, and the instance requeues the job when the lease lapses.
 */

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  }
  catch {
    return false
  }
}

test('SIGTERM during a job stops its daemons, reports nothing, and leaves no attempt record', async () => {
  const root = mkdtempSync(join(tmpdir(), 'reviewos-stop-signal-'))
  const workspaceRoot = join(root, 'workspaces')
  const ledgerRoot = join(root, 'ledger')
  const reports: any[] = []
  const logs: string[] = []
  let claimed = false

  const server = Bun.serve({ port: 0, async fetch(request) {
    const path = new URL(request.url).pathname
    const body: any = await request.json().catch(() => ({}))
    if (path === '/api/runner/claim') {
      if (claimed) return Response.json({})
      claimed = true
      return Response.json({ job: {
        id: 9401, token: 'stop-signal-job', key: 'stop', checkout: { skip: true },
        repository_full_name: 'acme/widgets',
        run: { id: 1, number: 1, event: 'push', ref: 'refs/heads/main', head_sha: 'abc' },
        steps: [
          // The daemon: bun, so macOS shows its environment; detached, so it
          // leads a session of its own and no signal to a step's group reaches it.
          { name: 'Start a private database', run: `${process.execPath} -e "const d = Bun.spawn([process.execPath, '-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: ['ignore', 'ignore', 'ignore'] }); d.unref(); await Bun.write('daemon.pid', String(d.pid))"` },
          { name: 'Exercise the app', run: 'sleep 300 & echo $! > step.pid; printf "STEP-RUNNING\\n"; wait' },
        ],
      } })
    }
    if (path === '/api/runner/logs') logs.push(String(body.content ?? ''))
    if (path === '/api/runner/report') reports.push(body)
    return Response.json({ ok: true, held: true })
  } })

  const child = Bun.spawn([process.execPath, join(import.meta.dir, '../fixtures/runner-stop-signal.fixture.ts'), `http://127.0.0.1:${server.port}`, workspaceRoot, ledgerRoot], { stdout: 'pipe', stderr: 'pipe' })

  try {
    const workspace = join(workspaceRoot, 'job-9401')
    for (let tries = 0; tries < 200 && !(logs.join('').includes('STEP-RUNNING') && existsSync(join(workspace, 'step.pid'))); tries++)
      await Bun.sleep(50)

    const daemon = Number(readFileSync(join(workspace, 'daemon.pid'), 'utf8').trim())
    const step = Number(readFileSync(join(workspace, 'step.pid'), 'utf8').trim())
    expect(alive(daemon)).toBe(true)
    expect(alive(step)).toBe(true)
    expect(readdirSync(ledgerRoot)).toEqual(['9401.json'])

    child.kill('SIGTERM')
    const code = await child.exited
    const output = await new Response(child.stdout).text()

    expect(code).toBe(143)
    expect(output).toContain('job 9401 abandoned')
    expect(output).not.toContain('runOnce returned')

    for (let tries = 0; tries < 40 && (alive(daemon) || alive(step)); tries++)
      await Bun.sleep(50)
    expect(alive(daemon)).toBe(false)
    expect(alive(step)).toBe(false)

    // No verdict: neither cancelled nor failed. The instance requeues it.
    expect(reports).toEqual([])
    expect(logs.join('')).toContain('returns to the queue when its lease lapses')

    // Everything was verified stopped, so the next runner has nothing to reap.
    expect(readdirSync(ledgerRoot)).toEqual([])
  }
  finally {
    if (child.exitCode === null) child.kill('SIGKILL')
    server.stop(true)
    rmSync(root, { recursive: true, force: true })
  }
}, 60_000)

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { runOnce } from '../../app/Actions/Runner/localExecutor'
import { cleanUpOrphans, recordGroup, survivors, trackingIdFor } from '../../app/Actions/Runner/orphans'

/**
 * A job's leftover processes, put away when the job ends.
 *
 * Run through `runOnce` against a stub control plane rather than by calling the
 * cleanup directly: the property that matters is that a *job* which backgrounds
 * something leaves nothing behind, and that is a claim about the whole path - the
 * tracking id reaching the step, the step's process group being remembered, and
 * the end of the job finding both.
 */

let server: ReturnType<typeof Bun.serve>
let workspaceRoot = ''
let logs: string[] = []
let reports: any[] = []
let next: any = null

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)

    return true
  }
  catch {
    return false
  }
}

beforeAll(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'reviewos-orphans-'))

  server = Bun.serve({
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname
      const body = await request.json().catch(() => ({}))

      if (path === '/api/runner/claim') {
        const job = next
        next = null

        return Response.json(job ? { job } : {})
      }

      if (path === '/api/runner/logs')
        logs.push(String((body as any)?.content ?? ''))

      if (path === '/api/runner/report')
        reports.push(body)

      return Response.json({ ok: true, held: true })
    },
  })
})

afterAll(() => {
  server.stop(true)
  rmSync(workspaceRoot, { recursive: true, force: true })
})

/** One job, with these `run:` steps, claimed and run to the end. */
async function runJob(id: number, steps: string[]) {
  logs = []
  reports = []
  next = {
    id,
    token: `job-token-${id}`,
    key: 'orphans',
    checkout: { skip: true },
    steps: steps.map((run, index) => ({ name: `step ${index + 1}`, run })),
    run: { id: 1, number: 1, event: 'push', ref: 'refs/heads/main', head_sha: 'abc' },
    repository_full_name: 'acme/widgets',
  }

  return await runOnce({ baseUrl: `http://127.0.0.1:${server.port}`, token: 'runner', workspaceRoot, tools: false })
}

describe('a job that backgrounds a process', () => {
  test('leaves nothing running once it ends', async () => {
    const outcome = await runJob(9001, [
      // Output not redirected, on purpose: the step must still end when its
      // shell does, rather than waiting on a pipe the sleep holds open.
      'sleep 300 & echo $! > sleep.pid',
      'kill -0 "$(cat sleep.pid)"',
    ])

    expect(outcome?.state).toBe('succeeded')

    const pid = Number(readFileSync(join(workspaceRoot, 'job-9001', 'sleep.pid'), 'utf8').trim())

    expect(pid).toBeGreaterThan(1)
    expect(isAlive(pid)).toBe(false)

    // One line for the process, in the job's own log.
    expect(logs.join('')).toContain(`Cleaning up orphan process: ${pid} (sleep)`)
  }, 30_000)

  test('a process that ignores SIGTERM is killed anyway', async () => {
    const outcome = await runJob(9002, [
      'sh -c \'trap "" TERM; while :; do sleep 1; done\' >/dev/null 2>&1 & echo $! > stubborn.pid',
    ])

    expect(outcome?.state).toBe('succeeded')

    const pid = Number(readFileSync(join(workspaceRoot, 'job-9002', 'stubborn.pid'), 'utf8').trim())

    // SIGKILL is not instant to observe, but it is quick.
    for (let tries = 0; tries < 20 && isAlive(pid); tries++)
      await Bun.sleep(50)

    expect(isAlive(pid)).toBe(false)
    expect(logs.join('')).toContain('killed after ignoring SIGTERM')
  }, 30_000)

  test('and a failed job is cleaned up too', async () => {
    const outcome = await runJob(9003, [
      'sleep 300 >/dev/null 2>&1 & echo $! > sleep.pid',
      'exit 3',
    ])

    expect(outcome?.state).toBe('failed')

    const pid = Number(readFileSync(join(workspaceRoot, 'job-9003', 'sleep.pid'), 'utf8').trim())

    expect(isAlive(pid)).toBe(false)
  }, 30_000)
})

describe('what is never touched', () => {
  test('a process the job did not start, even one running the same program', async () => {
    const bystander = Bun.spawn(['sleep', '300'], { stdout: 'ignore', stderr: 'ignore' })

    try {
      await runJob(9004, ['sleep 300 >/dev/null 2>&1 &'])

      expect(isAlive(bystander.pid)).toBe(true)
      expect(isAlive(process.pid)).toBe(true)
    }
    finally {
      bystander.kill()
    }
  }, 30_000)

  test('nothing is found for a job that left nothing', async () => {
    const id = trackingIdFor(1)

    expect(survivors(id)).toEqual([])
    expect(await cleanUpOrphans(id, () => {})).toEqual([])
  })

  test('the runner is never a survivor, whatever group it is in', async () => {
    const id = trackingIdFor(2)
    const own = Number(Bun.spawnSync(['ps', '-o', 'pgid=', '-p', String(process.pid)]).stdout.toString().trim())

    // Even if the runner's own group were somehow recorded, it is excluded.
    recordGroup(id, own)

    expect(survivors(id).map(row => row.pid)).not.toContain(process.pid)
  })

  test('a step can opt a process out, the way it would on Actions', async () => {
    const outcome = await runJob(9005, [
      // A new group and no tracking id: what a daemon meant to outlive the
      // job looks like, and what `RUNNER_TRACKING_ID=""` asks for on Actions.
      'RUNNER_TRACKING_ID="" setsid sleep 300 >/dev/null 2>&1 < /dev/null & echo $! > kept.pid || true',
    ])

    expect(outcome?.state).toBe('succeeded')

    const file = join(workspaceRoot, 'job-9005', 'kept.pid')

    // `setsid` is not on every system; where it is not, there is nothing to assert.
    if (existsSync('/usr/bin/setsid') || existsSync('/bin/setsid')) {
      const pid = Number(readFileSync(file, 'utf8').trim())

      expect(isAlive(pid)).toBe(true)
      process.kill(pid, 'SIGKILL')
    }
  }, 30_000)
})

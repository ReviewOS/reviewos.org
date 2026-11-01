import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { AttemptLedger, attemptProcesses, isJobWorkspace, ownerIsGone, processStartedAt, reapAbandonedAttempts } from '../../app/Actions/Runner/attempts'
import { attemptLedgerFor, runOnce } from '../../app/Actions/Runner/localExecutor'
import { trackingIdFor } from '../../app/Actions/Runner/orphans'

/**
 * What a runner that was killed mid-job leaves behind, put away by the next one.
 *
 * The shape of HQ job 7011 on 2026-11-01: the runner was restarted while a job
 * ran, a PostgreSQL that job's setup step had started as a daemon kept running
 * in the job's workspace, and the next attempt of the same job ran beside it.
 */

const spawned: Array<ReturnType<typeof Bun.spawn>> = []
const roots: string[] = []

afterEach(() => {
  for (const child of spawned.splice(0)) {
    try { child.kill('SIGKILL') }
    catch {}
  }
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  }
  catch {
    return false
  }
}

async function gone(pid: number): Promise<boolean> {
  for (let tries = 0; tries < 40 && alive(pid); tries++)
    await Bun.sleep(50)
  return !alive(pid)
}

function root(): string {
  const directory = mkdtempSync(join(tmpdir(), 'reviewos-attempts-'))
  roots.push(directory)
  return directory
}

/** A daemon the way a setup step leaves one: its own session, the job's environment, elsewhere on disk. */
function daemon(trackingId: string): ReturnType<typeof Bun.spawn> {
  const child = Bun.spawn([process.execPath, '-e', 'setInterval(() => {}, 1000)'], {
    cwd: tmpdir(),
    env: { ...process.env, RUNNER_TRACKING_ID: trackingId },
    stdout: 'ignore',
    stderr: 'ignore',
    detached: true,
  })
  spawned.push(child)
  return child
}

/** A system binary whose environment macOS will not show, sitting in a workspace. */
function sleeper(cwd: string): ReturnType<typeof Bun.spawn> {
  const child = Bun.spawn(['sleep', '300'], { cwd, stdout: 'ignore', stderr: 'ignore', detached: true })
  spawned.push(child)
  return child
}

/** Wait for `ps` to show a new process's environment, which can lag its start by a moment. */
async function visible(trackingId: string, pid: number, workspace: string): Promise<void> {
  const record = { jobId: 1, trackingId, workspace, pid: 999_999, pidStartedAt: '', startedAt: '' }
  for (let tries = 0; tries < 40; tries++) {
    if (attemptProcesses(record).some(row => row.pid === pid))
      return
    await Bun.sleep(50)
  }
}

describe('an attempt whose runner is gone', () => {
  test('has everything it started stopped, by tracking id and by workspace, and nothing else', async () => {
    const base = root()
    const ledger = new AttemptLedger(join(base, 'ledger'))
    const workspace = join(base, 'reviewos-job-7011-G88h4i')
    mkdirSync(workspace)

    const trackingId = trackingIdFor(7011)
    const postgres = daemon(trackingId)
    const shell = sleeper(workspace)
    const bystander = sleeper(tmpdir())
    const unrelated = daemon(trackingIdFor(9999))

    ledger.begin({ jobId: 7011, trackingId, workspace })
    // The runner that wrote it was restarted: another process id now.
    const file = join(ledger.directory, '7011.json')
    const record = JSON.parse(await Bun.file(file).text())
    await Bun.write(file, JSON.stringify({ ...record, pid: 999_999, pidStartedAt: 'long ago' }))

    await visible(trackingId, postgres.pid, workspace)
    await visible(trackingId, shell.pid, workspace)

    const said: string[] = []
    const result = await reapAbandonedAttempts(ledger, line => said.push(line), 1000)

    expect(result.reaped).toBe(1)
    expect(result.surviving).toEqual([])
    expect(await gone(postgres.pid)).toBe(true)
    expect(await gone(shell.pid)).toBe(true)
    expect(alive(bystander.pid)).toBe(true)
    expect(alive(unrelated.pid)).toBe(true)
    expect(alive(process.pid)).toBe(true)
    expect(said.join('\n')).toContain('abandoned attempt of job 7011')

    // The record goes once nothing is left, which is what lets the workspace be retired.
    expect(existsSync(file)).toBe(false)
  }, 30_000)

  test('a record whose runner is still running is not touched', async () => {
    const base = root()
    const ledger = new AttemptLedger(join(base, 'ledger'))
    const workspace = join(base, 'reviewos-job-42-live')
    mkdirSync(workspace)

    const owner = sleeper(tmpdir())
    const working = sleeper(workspace)
    const trackingId = trackingIdFor(42)

    ledger.begin({ jobId: 42, trackingId, workspace })
    const file = join(ledger.directory, '42.json')
    const record = JSON.parse(await Bun.file(file).text())
    const started = processStartedAt(owner.pid)
    expect(started).not.toBeNull()
    await Bun.write(file, JSON.stringify({ ...record, pid: owner.pid, pidStartedAt: started }))

    expect(ownerIsGone(ledger.read(42)!)).toBe(false)

    const result = await reapAbandonedAttempts(ledger, () => {}, 500)

    expect(result.reaped).toBe(0)
    expect(alive(working.pid)).toBe(true)
    expect(existsSync(file)).toBe(true)
  }, 30_000)

  test('a reused process id is not mistaken for the runner that wrote the record', async () => {
    const owner = sleeper(tmpdir())
    const record = { jobId: 5, trackingId: trackingIdFor(5), workspace: '/nonexistent/job-5', pid: owner.pid, pidStartedAt: 'Thu Jan  1 00:00:00 1970', startedAt: '' }

    expect(ownerIsGone(record)).toBe(true)
  })

  test('a later attempt of the same job keeps its own record', () => {
    const ledger = new AttemptLedger(join(root(), 'ledger'))
    const first = ledger.begin({ jobId: 8, trackingId: trackingIdFor(8), workspace: '/tmp/reviewos-job-8-first' })
    const second = ledger.begin({ jobId: 8, trackingId: trackingIdFor(8), workspace: '/tmp/reviewos-job-8-second' })

    ledger.end(first)
    expect(ledger.read(8)?.trackingId).toBe(second.trackingId)

    ledger.end(second)
    expect(ledger.read(8)).toBeNull()
  })
})

describe('what counts as a job workspace', () => {
  // A damaged record naming `/` would otherwise make every process on the
  // machine look like the abandoned job's.
  test('only the directories a runner makes for a job', () => {
    expect(isJobWorkspace('/var/folders/cv/T/reviewos-job-7011-G88h4i')).toBe(true)
    expect(isJobWorkspace('/srv/runner/workspaces/job-7011')).toBe(true)
    for (const path of ['/', '/Users/chris', '/tmp', 'job-7011', '/tmp/postgres', '/job-1'])
      expect({ path, ok: isJobWorkspace(path) }).toEqual({ path, ok: false })
    expect(() => new AttemptLedger(join(root(), 'ledger')).begin({ jobId: 1, trackingId: trackingIdFor(1), workspace: '/Users/chris' })).toThrow('Not a job workspace')
  })
})

describe('where the records live', () => {
  // Known before the first claim, which is when a restarted runner has to
  // look: the instance only says which runner this is in its answer.
  test('does not wait for the instance to say which runner this is', () => {
    const ledger = attemptLedgerFor({ baseUrl: 'https://reviewos.example/', token: 'runner', workspaceJournalRoot: '/srv/reviewos/workspace-journals' })
    const same = attemptLedgerFor({ baseUrl: 'https://reviewos.example', token: 'rotated', runnerId: 2, workspaceJournalRoot: '/srv/reviewos/workspace-journals' })
    const other = attemptLedgerFor({ baseUrl: 'https://other.example', token: 'runner', workspaceJournalRoot: '/srv/reviewos/workspace-journals' })

    expect(ledger?.directory.startsWith('/srv/reviewos/job-attempts/')).toBe(true)
    expect(same?.directory).toBe(ledger?.directory)
    expect(other?.directory).not.toBe(ledger?.directory)
  })
})

describe('the next claim', () => {
  test('waits until an abandoned attempt has been put away, then takes work', async () => {
    const base = root()
    const workspaceRoot = join(base, 'workspaces')
    const ledgerRoot = join(base, 'ledger')
    const workspace = join(workspaceRoot, 'job-7011')
    mkdirSync(workspace, { recursive: true })

    const trackingId = trackingIdFor(7011)
    const postgres = daemon(trackingId)
    const ledger = new AttemptLedger(ledgerRoot)
    ledger.begin({ jobId: 7011, trackingId, workspace })
    const file = join(ledgerRoot, '7011.json')
    await Bun.write(file, JSON.stringify({ ...JSON.parse(await Bun.file(file).text()), pid: 999_999 }))
    await visible(trackingId, postgres.pid, workspace)

    let claimedWhileAlive: boolean | null = null
    const claims: any[] = []
    const server = Bun.serve({ port: 0, async fetch(request) {
      if (new URL(request.url).pathname === '/api/runner/claim') {
        claims.push(await request.json().catch(() => ({})))
        claimedWhileAlive = alive(postgres.pid)
        return Response.json({})
      }
      return Response.json({ ok: true })
    } })

    try {
      const outcome = await runOnce({ baseUrl: `http://127.0.0.1:${server.port}`, token: 'runner', workspaceRoot, attemptLedgerRoot: ledgerRoot, tools: false, minimumFreeDiskMb: 0, maximumLoadPerCpu: 0 })

      expect(outcome).toBeNull()
      expect(claimedWhileAlive).toBe(false)
      expect(claims[0]?.accept_work).toBeUndefined()
      expect(existsSync(file)).toBe(false)
    }
    finally {
      server.stop(true)
    }
  }, 30_000)

  test('a finished job leaves no record behind', async () => {
    const base = root()
    const ledgerRoot = join(base, 'ledger')
    let claimed = false
    const server = Bun.serve({ port: 0, async fetch(request) {
      if (new URL(request.url).pathname === '/api/runner/claim') {
        if (claimed) return Response.json({})
        claimed = true
        return Response.json({ job: {
          id: 9301, token: 'ledger-job', key: 'ledger', checkout: { skip: true },
          repository_full_name: 'acme/widgets',
          run: { id: 1, number: 1, event: 'push', ref: 'refs/heads/main', head_sha: 'abc' },
          steps: [{ run: 'sleep 300 >/dev/null 2>&1 & true' }],
        } })
      }
      return Response.json({ ok: true, held: true })
    } })

    try {
      const outcome = await runOnce({ baseUrl: `http://127.0.0.1:${server.port}`, token: 'runner', workspaceRoot: join(base, 'workspaces'), attemptLedgerRoot: ledgerRoot, tools: false, minimumFreeDiskMb: 0, maximumLoadPerCpu: 0 })

      expect(outcome?.state).toBe('succeeded')
      expect(new AttemptLedger(ledgerRoot).list()).toEqual([])
    }
    finally {
      server.stop(true)
    }
  }, 30_000)
})

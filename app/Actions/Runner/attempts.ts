/**
 * The job attempts this machine has started, written down until they end.
 *
 * A runner that is killed - `launchctl kickstart -k`, SIGKILL after a stop
 * timed out, a crash, a reboot that left launchd's children - forgets the job
 * it was running, and the instance only learns of it when the lease lapses.
 * Then it requeues the job, which is right. What was wrong is what stayed on
 * this machine: on 2026-11-01 the first attempt of HQ job 7011 kept its
 * PostgreSQL running in workspace `G88h4i` after the runner restarted, the
 * second attempt ran beside it, and the workspace could never be retired
 * because something was still using it.
 *
 * So each attempt leaves a record here when it starts - which job, its tracking
 * id, its workspace, and which runner process owns it - and removes it only
 * once every process it started is verified gone. A record whose owner is no
 * longer running is an abandoned attempt, and `reapAbandonedAttempts` stops
 * what it left before this machine takes any more work.
 *
 * How a process is known to be the attempt's, without guessing:
 *
 * - **Its environment carries the attempt's tracking id.** Random per attempt
 *   and handed only to its own steps (see `orphans.ts`).
 * - **Its working directory is inside the attempt's workspace**, for the
 *   processes whose environment the system will not show (macOS hides it for
 *   system binaries such as `/bin/sh`). The workspace is a directory this
 *   runner created with a random name for that one attempt.
 */

import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, isAbsolute, join } from 'node:path'
import process from 'node:process'
import type { ProcessRow } from './orphans'
import { listProcesses, survivors, terminateProcesses, workingDirectories } from './orphans'

export interface AttemptRecord {
  jobId: number
  trackingId: string
  workspace: string
  /** The runner process that owns the attempt. */
  pid: number
  /** When that process started, so a reused process id is not mistaken for it. */
  pidStartedAt: string
  startedAt: string
}

/** When a process started, as the system reports it, or null when it is not running. */
export function processStartedAt(pid: number): string | null {
  if (!Number.isSafeInteger(pid) || pid <= 0)
    return null

  const result = Bun.spawnSync(['ps', '-o', 'lstart=', '-p', String(pid)], { stdout: 'pipe', stderr: 'ignore', env: { ...process.env, LC_ALL: 'C' } })
  const text = result.stdout.toString().trim()

  return result.exitCode === 0 && text ? text : null
}

let ownStart: string | null | undefined

function ownStartedAt(): string {
  ownStart ??= processStartedAt(process.pid)

  return ownStart ?? ''
}

/**
 * Whether a path is one this runner makes for a job: absolute, and named
 * `job-<id>` (inside a configured workspace root) or `reviewos-job-<id>-...`
 * (a journaled temporary one). Anything else - a damaged record naming `/` or
 * a home directory - would make every process under it look like the job's.
 */
export function isJobWorkspace(path: string): boolean {
  return isAbsolute(path) && /^(?:reviewos-)?job-\d+(?:-[\w-]+)?$/.test(basename(path)) && path.split('/').filter(Boolean).length >= 2
}

/** A directory of attempt records, private to the runner identity that owns it. */
export class AttemptLedger {
  constructor(readonly directory: string) {}

  private file(jobId: number): string {
    return join(this.directory, `${jobId}.json`)
  }

  /** Write the record for an attempt about to run. */
  begin(input: { jobId: number, trackingId: string, workspace: string }): AttemptRecord {
    if (!isJobWorkspace(input.workspace))
      throw new Error(`Not a job workspace: ${input.workspace}`)

    mkdirSync(this.directory, { recursive: true, mode: 0o700 })

    const record: AttemptRecord = {
      jobId: input.jobId,
      trackingId: input.trackingId,
      workspace: input.workspace,
      pid: process.pid,
      pidStartedAt: ownStartedAt(),
      startedAt: new Date().toISOString(),
    }

    const file = this.file(record.jobId)
    writeFileSync(`${file}.tmp`, JSON.stringify(record), { mode: 0o600 })
    renameSync(`${file}.tmp`, file)

    return record
  }

  /** The attempt ended and nothing it started is left. */
  end(record: Pick<AttemptRecord, 'jobId' | 'trackingId'>): void {
    const current = this.read(record.jobId)

    // A later attempt of the same job owns the file now; leave it alone.
    if (current && current.trackingId !== record.trackingId)
      return

    rmSync(this.file(record.jobId), { force: true })
  }

  read(jobId: number): AttemptRecord | null {
    try {
      const file = this.file(jobId)
      const stat = lstatSync(file)

      if (!stat.isFile() || stat.size > 8192)
        return null

      const value = JSON.parse(readFileSync(file, 'utf8'))

      if (!Number.isSafeInteger(value?.jobId) || typeof value?.trackingId !== 'string' || !value.trackingId.startsWith('reviewos_')
        || typeof value?.workspace !== 'string' || !isJobWorkspace(value.workspace) || !Number.isSafeInteger(value?.pid))
        return null

      return value as AttemptRecord
    }
    catch {
      return null
    }
  }

  list(): AttemptRecord[] {
    if (!existsSync(this.directory))
      return []

    return readdirSync(this.directory)
      .filter(name => /^\d+\.json$/.test(name))
      .map(name => this.read(Number(name.slice(0, -5))))
      .filter((record): record is AttemptRecord => record !== null)
  }
}

/**
 * Whether the runner process that owns this attempt is gone.
 *
 * Its own records count as abandoned too: the executor runs one job at a time
 * and only reaps between jobs, so a record this process still holds is one
 * whose cleanup could not be verified when the job ended.
 */
export function ownerIsGone(record: AttemptRecord): boolean {
  if (record.pid === process.pid)
    return true

  const started = processStartedAt(record.pid)

  return started === null || started !== record.pidStartedAt
}

function beneath(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`)
}

/** Every spelling of a workspace path the system may report: as made, and resolved. */
function spellings(workspace: string): string[] {
  const names = new Set([workspace])

  try {
    names.add(realpathSync(workspace))
  }
  catch {
    // Removed already; its processes may still report the old path.
  }

  // macOS reports /var/folders as /private/var/folders once resolved.
  for (const name of [...names]) {
    if (name.startsWith('/var/') || name.startsWith('/tmp/'))
      names.add(`/private${name}`)
  }

  return [...names]
}

/** What is still running from one attempt: by its tracking id, or by working directory. */
export function attemptProcesses(
  record: AttemptRecord,
  rows: readonly ProcessRow[] = listProcesses(),
  directories: Map<number, string> = workingDirectories(),
): ProcessRow[] {
  const roots = spellings(record.workspace)
  const found = new Map<number, ProcessRow>()

  for (const row of survivors(record.trackingId, rows))
    found.set(row.pid, row)

  for (const row of rows) {
    if (row.pid === process.pid || row.pid <= 1 || found.has(row.pid))
      continue

    const directory = directories.get(row.pid)

    if (directory && roots.some(root => beneath(directory, root)))
      found.set(row.pid, row)
  }

  return [...found.values()]
}

export interface ReapResult {
  /** Attempts whose processes are all gone now, and whose records were removed. */
  reaped: number
  /** Processes stopped on the way. */
  stopped: number
  /** Attempts with processes still running after SIGKILL. */
  surviving: AttemptRecord[]
}

/**
 * Stop whatever abandoned attempts left running, before this machine takes work.
 *
 * Each record whose owner is gone is looked up; everything that belongs to it
 * is stopped (SIGTERM, then SIGKILL); a record with nothing left is removed,
 * which is what lets the workspace be retired. A record whose processes
 * survive is kept and named, and the caller holds new work rather than start
 * another attempt beside them.
 */
export async function reapAbandonedAttempts(
  ledger: AttemptLedger | null,
  say: (line: string) => void = () => {},
  graceMs = 5000,
): Promise<ReapResult> {
  const result: ReapResult = { reaped: 0, stopped: 0, surviving: [] }
  const abandoned = ledger?.list().filter(ownerIsGone) ?? []

  if (!ledger || abandoned.length === 0)
    return result

  for (const record of abandoned) {
    // More than one pass, because a process can fork while it is being
    // stopped - a PostgreSQL postmaster's children, for one.
    let clear = false

    for (let round = 0; round < 3 && !clear; round++) {
      const found = attemptProcesses(record)

      if (found.length === 0) {
        clear = true
        break
      }

      for (const row of found)
        say(`Stopping process ${row.pid} (${row.name}) left by an abandoned attempt of job ${record.jobId}`)

      result.stopped += found.length
      await terminateProcesses(found, graceMs)
    }

    if (!clear && attemptProcesses(record).length > 0) {
      result.surviving.push(record)
      continue
    }

    ledger.end(record)
    result.reaped++
  }

  return result
}

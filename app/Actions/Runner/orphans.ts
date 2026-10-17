/**
 * Processes a job left behind, and putting them away when it ends.
 *
 * A step that writes `./buddy dev:api > api.log 2>&1 &` starts a server and
 * exits, and the server outlives it - which is the point, because the next step
 * runs the tests against it. It also outlives the *job*, and then the next job
 * on this runner finds port 3011 taken and fails for a reason that has nothing
 * to do with its own commit. Actions answers this with "Cleaning up orphan
 * processes" at the end of every job, and so does this.
 *
 * Two ways of knowing a process is the job's, because each misses something:
 *
 * - **Its process group.** Every step starts as the leader of a group of its
 *   own, and a shell's background jobs stay in it. That holds on every system,
 *   including macOS, where the environment of a system binary like `sleep` is
 *   hidden from `ps`.
 * - **`RUNNER_TRACKING_ID` in its environment**, which is Actions' own
 *   mechanism and the variable has Actions' name. It follows a process that
 *   left the group - a daemon that called `setsid` - because environments are
 *   inherited. A step that wants something to outlive the job clears the
 *   variable, exactly as it would on Actions.
 *
 * **It never touches a process the job did not start.** The tracking id is
 * random per job and only ever handed to the job's own steps, and a group id is
 * only remembered while the group still has members, so a number the system
 * later reuses for something unrelated is not one this module still believes
 * in. The runner itself is excluded by name, whatever matches.
 */

import { readFileSync } from 'node:fs'
import process from 'node:process'

/** The variable Actions uses for the same purpose, kept so workflows can opt out the same way. */
export const TRACKING_VARIABLE = 'RUNNER_TRACKING_ID'

/** Process groups started per tracking id. */
const groups = new Map<string, Set<number>>()

/** A tracking id for one job: unguessable, so nothing else can be carrying it. */
export function trackingIdFor(jobId: unknown): string {
  return `reviewos_${String(jobId ?? 'job').replace(/\W+/g, '')}_${crypto.randomUUID().replace(/-/g, '')}`
}

/**
 * Remember a step's process group.
 *
 * Keyed by the tracking id in the step's own environment, so every way a job
 * runs a process - a step, a composite action's step, a hook - is covered by
 * the one place they all go through, without threading the job down to it.
 */
export function recordGroup(trackingId: string | undefined, pgid: number | undefined): void {
  if (!trackingId || !pgid || pgid <= 1)
    return

  const known = groups.get(trackingId) ?? new Set<number>()

  known.add(pgid)
  groups.set(trackingId, known)
}

/**
 * Forget a group that has no members left.
 *
 * Called when a step ends. A group whose every process has exited cannot gain
 * a member again, and its number may later be reused by something that is not
 * this job's - so a group with nobody left in it is dropped rather than
 * remembered until the job ends.
 */
export function pruneGroup(trackingId: string | undefined, pgid: number | undefined, rows: readonly ProcessRow[] = listProcesses()): void {
  if (!trackingId || !pgid)
    return

  if (!rows.some(row => row.pgid === pgid))
    groups.get(trackingId)?.delete(pgid)
}

export interface ProcessRow {
  pid: number
  pgid: number
  /** The program, for the log line. */
  name: string
  /** The environment, where the system will say it. Null where it will not. */
  environment: string | null
}

/** Every process on the machine this user can see, with what this module needs to know. */
export function listProcesses(): ProcessRow[] {
  const rows = new Map<number, ProcessRow>()

  try {
    const result = Bun.spawnSync(['ps', '-A', '-o', 'pid=,pgid=,comm='], { stdout: 'pipe', stderr: 'ignore' })
    if (result.exitCode !== 0) throw new Error('Process enumeration failed')
    const table = result.stdout.toString()

    for (const line of table.split('\n')) {
      const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)

      if (match)
        rows.set(Number(match[1]), { pid: Number(match[1]), pgid: Number(match[2]), name: match[3]!.trim(), environment: null })
    }
  }
  catch {
    throw new Error('The runner could not enumerate processes safely')
  }

  if (process.platform === 'linux') {
    for (const row of rows.values()) {
      try {
        row.environment = readFileSync(`/proc/${row.pid}/environ`, 'latin1').replace(/\0/g, '\n')
      }
      catch {
        // Somebody else's process, or one that has already gone.
      }
    }
  }
  else {
    /*
     * macOS prints a process's environment after its arguments with `-E`, for
     * this user's processes and not for system binaries. Read as text and
     * matched on the whole `NAME=value` below, so an argument that merely
     * mentions the variable cannot match a different job's id.
     */
    try {
      const table = Bun.spawnSync(['ps', '-A', '-E', '-ww', '-o', 'pid=,command='], { stdout: 'pipe', stderr: 'ignore' }).stdout.toString()

      for (const line of table.split('\n')) {
        const match = /^\s*(\d+)\s+(.*)$/.exec(line)
        const row = match ? rows.get(Number(match[1])) : undefined

        if (row)
          row.environment = match![2]!.replace(/ (?=[A-Z_][A-Z0-9_]*=)/g, '\n')
      }
    }
    catch {
      // Without environments the process groups still find what a step left.
    }
  }

  return [...rows.values()]
}

/** What is still alive from this job, never including the runner itself. */
export function survivors(trackingId: string, rows: readonly ProcessRow[] = listProcesses()): ProcessRow[] {
  const known = groups.get(trackingId) ?? new Set<number>()
  const marker = `${TRACKING_VARIABLE}=${trackingId}`

  return rows.filter((row) => {
    if (row.pid === process.pid || row.pid <= 1)
      return false

    if (known.has(row.pgid))
      return true

    return row.environment !== null && row.environment.split('\n').some(entry => entry.trim() === marker)
  })
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)

    return true
  }
  catch (error) {
    // EPERM is a process that exists and belongs to somebody else - which,
    // having matched this job's id, it does not - so only ESRCH means gone.
    return (error as NodeJS.ErrnoException)?.code !== 'ESRCH'
  }
}

/** A failed stop is still live; check both discovered descendants and recorded processes. */
export function remainingJobProcesses(trackingId: string, known: readonly ProcessRow[]): ProcessRow[] {
  const remaining = new Map<number, ProcessRow>()
  for (const row of [...survivors(trackingId), ...known]) {
    if (alive(row.pid)) remaining.set(row.pid, row)
  }
  return [...remaining.values()]
}

/**
 * Terminate whatever this job left running: SIGTERM, a grace period, then
 * SIGKILL for anything that ignored it.
 *
 * One line per process, because "the job ended and something was killed" is
 * worth knowing when the something was a server a later step expected to find.
 * Scanned more than once, because a process can fork while it is being asked
 * to stop. Returns what was found, for the caller and the tests.
 */
export async function cleanUpOrphans(
  trackingId: string | undefined,
  say: (line: string) => void | Promise<void>,
  graceMs = 5000,
): Promise<ProcessRow[]> {
  if (!trackingId)
    return []

  const found: ProcessRow[] = []

  for (let round = 0; round < 3; round++) {
    const remaining = survivors(trackingId).filter(row => !found.some(one => one.pid === row.pid))

    if (remaining.length === 0)
      break

    for (const row of remaining) {
      found.push(row)

      try {
        process.kill(row.pid, 'SIGTERM')
      }
      catch {
        // Gone already, which is the outcome being asked for.
      }
    }

    const until = Date.now() + graceMs

    while (Date.now() < until && remaining.some(row => alive(row.pid)))
      await Bun.sleep(100)

    for (const row of remaining) {
      if (!alive(row.pid)) {
        await say(`Cleaning up orphan process: ${row.pid} (${row.name}) stopped`)
        continue
      }

      try {
        process.kill(row.pid, 'SIGKILL')
      }
      catch {
        // Exited between the check and the signal.
      }

      // Signal delivery and parent reaping are asynchronous on both platforms.
      // Confirm disappearance within a bound before recording successful cleanup.
      const killDeadline = Date.now() + 1000
      while (Date.now() < killDeadline && alive(row.pid))
        await Bun.sleep(25)

      await say(alive(row.pid)
        ? `Orphan process ${row.pid} (${row.name}) is still present after SIGKILL; preserving its workspace`
        : `Cleaning up orphan process: ${row.pid} (${row.name}) killed after ignoring SIGTERM for ${Math.round(graceMs / 1000)}s`)
    }
  }

  groups.delete(trackingId)

  return found
}

let handlersInstalled = false

/**
 * Stop the job's processes when the runner itself is stopped.
 *
 * Needed because each step now leads a process group of its own: a Ctrl-C at
 * the runner's terminal reaches the runner's group and no longer the steps',
 * so without this a stopped runner would leave its job's processes running.
 * Installed once, by the runner, rather than when this module loads.
 */
export function installStopHandlers(): void {
  if (handlersInstalled)
    return

  handlersInstalled = true

  for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]] as const) {
    process.on(signal, () => {
      killAllTracked()
      process.exit(code)
    })
  }
}

/** Every job's tracked groups, for a runner that is itself being stopped. */
export function killAllTracked(): void {
  for (const known of groups.values()) {
    for (const pgid of known) {
      try {
        process.kill(-pgid, 'SIGTERM')
      }
      catch {
        // An empty group.
      }
    }
  }
}

/**
 * Starting a workflow run and following it, from a terminal.
 *
 * `workflow_dispatch` was only reachable from the run list's button or by
 * hand-writing the API call, so a release that a person cuts on purpose - a
 * platform kit, a deploy of one commit - went through GitHub Actions instead,
 * and stopped there the day the account's minutes ran out. These commands are
 * the same three endpoints the interface uses: dispatch, show, and list.
 *
 * Like the rest of the CLI, everything here is HTTP to the public API and
 * nothing exits the process.
 */

import process from 'node:process'
import type { Connection } from './api'
import { call, report } from './api'
import { standing } from './context'
import { tokenFor } from './keychain'

export interface Target { instance: string, owner: string, repository: string }

export interface TargetOptions {
  /** `owner/name` on this instance, for a checkout whose remote is somewhere else. */
  repo?: string
  instance?: string
}

export interface WatchOptions extends TargetOptions {
  intervalMs?: number
  /** Give up after this long; the run keeps going on the server. */
  timeoutMs?: number
  sleep?: (ms: number) => Promise<void>
}

export interface RunOptions extends WatchOptions {
  ref?: string
  /** `key=value` pairs, as typed after `--input`. */
  inputs?: string[]
  watch?: boolean
}


export interface LogsOptions extends TargetOptions {
  /** Only this job, by its name or its id in the workflow file. */
  job?: string
  /** Every job, where the default is the ones that did not succeed. */
  all?: boolean
  /** Only the last this-many lines of each job. */
  tail?: number
  /** An earlier attempt's output, where a re-run kept it. */
  attempt?: number
}

export interface ListRunsOptions extends TargetOptions {
  state?: string
  branch?: string
  limit?: number
}

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled'])

/**
 * Which repository a command acts on.
 *
 * A mirror's checkout points at its upstream - `github.com/stacksjs/hq.training`
 * - while the runs live at `reviewos.org/stacks/hq.training`, so neither the
 * host nor the owner in the remote is the one to ask. `--repo owner/name` (or
 * REVIEWOS_REPOSITORY) names it here, and the instance then comes from
 * `--instance`, REVIEWOS_URL, or the remote, in that order.
 */
export async function resolveTarget(
  options: TargetOptions = {},
  environment: Record<string, string | undefined> = process.env,
): Promise<Target | { error: string }> {
  const named = String(options.repo ?? environment.REVIEWOS_REPOSITORY ?? '').trim()
  const explicitInstance = String(options.instance ?? environment.REVIEWOS_URL ?? '').trim().replace(/\/$/, '')
  const here = await standing('origin', environment)

  if (named) {
    const parts = named.split('/').filter(Boolean)
    if (parts.length !== 2)
      return { error: `--repo takes owner/name, not "${named}"` }

    const instance = explicitInstance || here?.instance
    if (!instance)
      return { error: 'Which instance? Pass --instance or set REVIEWOS_URL.' }

    return { instance, owner: parts[0]!, repository: parts[1]! }
  }

  if (!here)
    return { error: 'Not in a git checkout with a remote this recognises. Pass --repo owner/name, or set REVIEWOS_URL.' }

  return { instance: explicitInstance || here.instance, owner: here.owner, repository: here.repository }
}

/** `key=value` pairs into the object the dispatch endpoint takes. */
export function parseInputs(pairs: string[] = []): Record<string, string> | { error: string } {
  const inputs: Record<string, string> = {}

  for (const pair of pairs) {
    const at = pair.indexOf('=')
    if (at < 1)
      return { error: `--input takes key=value, not "${pair}"` }

    inputs[pair.slice(0, at)] = pair.slice(at + 1)
  }

  return inputs
}

export function runUrl(target: Target, number: number | string): string {
  return `${target.instance}/${target.owner}/${target.repository}/run/${number}`
}

/**
 * One line for each job that did not succeed: why a queued one is waiting, and
 * what a failed or cancelled one stopped on (the instance's own `error` for
 * the job, such as "Run the unit suites exited 1").
 */
export function describeJobs(jobs: any[] = []): string[] {
  return jobs
    .filter(job => !['succeeded', 'skipped'].includes(String(job.state)))
    .map((job) => {
      const why = job.waiting?.summary ?? job.waiting?.kind ?? job.error
      return `  ${String(job.name ?? job.job_id ?? 'job')}: ${String(job.state)}${why ? ` (${String(why)})` : ''}`
    })
}

/**
 * What `watch` says about a run in its current state.
 *
 * A run that failed or was cancelled names the jobs that did not succeed and
 * what each stopped on. It used to print the state and a link, so the answer
 * to "what failed?" was always a browser away, and a script following a
 * release could not put it in its own output.
 */
export function describeRun(number: string, run: any, jobs: any[] = run?.jobs ?? []): string[] {
  const state = String(run?.state ?? 'unknown')
  return [`#${number} ${state}${run?.reason && TERMINAL.has(state) && state !== 'succeeded' ? `: ${String(run.reason)}` : ''}`, ...(state === 'succeeded' ? [] : describeJobs(jobs))]
}

async function connect(options: TargetOptions): Promise<{ target: Target, connection: Connection } | number> {
  const target = await resolveTarget(options)
  if ('error' in target) {
    console.error(target.error)

    return 1
  }

  return { target, connection: { instance: target.instance, token: await tokenFor(target.instance) } }
}

/** Start a run of a workflow that accepts `workflow_dispatch`, and optionally wait for it. */
export async function runWorkflow(workflow: string, options: RunOptions = {}): Promise<number> {
  const inputs = parseInputs(options.inputs)
  if ('error' in inputs) {
    console.error(inputs.error)

    return 1
  }

  const connected = await connect(options)
  if (typeof connected === 'number')
    return connected

  const { target, connection } = connected
  const started = await call(connection, 'POST', '/api/repos/workflows/dispatch', {
    body: {
      owner: target.owner,
      repo: target.repository,
      workflow,
      ref: options.ref,
      inputs: Object.keys(inputs).length > 0 ? inputs : undefined,
    },
  })

  if (!started.ok)
    return report(started)

  const number = started.data?.workflow_run?.number
  console.log(`Started run #${number} of ${workflow} (${String(started.data?.workflow_run?.state ?? 'queued')})`)
  console.log(runUrl(target, number))

  return options.watch ? await watchRun(String(number), options) : 0
}

/**
 * Follow a run until it finishes, printing each change of state.
 *
 * Exits 0 for a run that succeeded and 1 for one that failed or was cancelled,
 * so a script can chain on it. A queued job says why it is still queued, which
 * is the question somebody watching a run that has not started is asking.
 */
export async function watchRun(number: string, options: WatchOptions = {}): Promise<number> {
  const connected = await connect(options)
  if (typeof connected === 'number')
    return connected

  const { target, connection } = connected
  const interval = options.intervalMs ?? 5_000
  const deadline = Date.now() + (options.timeoutMs ?? 60 * 60_000)
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)))
  let said = ''

  while (true) {
    const shown = await call(connection, 'GET', '/api/repos/workflow-runs/show', {
      query: { owner: target.owner, repo: target.repository, number },
    })

    if (!shown.ok)
      return report(shown)

    const run = shown.data?.workflow_run ?? {}
    const state = String(run.state ?? 'unknown')
    const text = describeRun(number, run, run.jobs ?? shown.data?.jobs).join('\n')

    if (text !== said) {
      console.log(text)
      said = text
    }

    if (TERMINAL.has(state)) {
      console.log(runUrl(target, number))

      return state === 'succeeded' ? 0 : 1
    }

    if (Date.now() >= deadline) {
      console.error(`Stopped watching #${number}; it is still ${state}. ${runUrl(target, number)}`)

      return 1
    }

    await sleep(interval)
  }
}

/**
 * Which of a run's jobs `logs` prints.
 *
 * A named job is that job, by its name or its id in the workflow file,
 * whatever case it was typed in. Otherwise the jobs that failed, because "what
 * failed?" is why somebody asks for the log of a red run; a run with no failed
 * job (still running, cancelled before it started, or green) prints them all,
 * as `all` does.
 */
export function jobsToRead(jobs: any[] = [], options: Pick<LogsOptions, 'job' | 'all'> = {}): any[] | { error: string } {
  const wanted = String(options.job ?? '').trim().toLowerCase()
  if (wanted) {
    const named = jobs.filter(job => [job.name, job.job_id].some(value => String(value ?? '').toLowerCase() === wanted))
    if (named.length > 0)
      return named

    return { error: `No job "${options.job}" in this run. It has: ${jobs.map(job => String(job.name ?? job.job_id)).join(', ') || 'none'}` }
  }

  const failed = jobs.filter(job => String(job.state) === 'failed')

  return options.all || failed.length === 0 ? jobs : failed
}

/** The last `tail` lines of a job's output, or all of it. A trailing newline is not a line. */
export function lastLines(text: string, tail?: number): string {
  const body = text.replace(/\n$/, '')
  if (!tail || tail < 1)
    return body

  return body.split('\n').slice(-tail).join('\n')
}

/**
 * A run's job output, in a terminal.
 *
 * `watch` says which job failed and on which step; what the step printed was
 * a browser away, on a page that needs a sign-in there, so a script, an agent
 * or somebody on a machine without that sign-in could see that a suite failed
 * and never which test. This reads the same log endpoint the run page does,
 * a page at a time until the cursor stops moving, and prints the text as it
 * was written. Exits 0 when it printed something or the jobs had no output.
 */
export async function runLogs(number: string, options: LogsOptions = {}): Promise<number> {
  const connected = await connect(options)
  if (typeof connected === 'number')
    return connected

  const { target, connection } = connected
  const shown = await call(connection, 'GET', '/api/repos/workflow-runs/show', {
    query: { owner: target.owner, repo: target.repository, number },
  })

  if (!shown.ok)
    return report(shown)

  const run = shown.data?.workflow_run ?? {}
  const chosen = jobsToRead(run.jobs ?? shown.data?.jobs ?? [], options)
  if ('error' in chosen) {
    console.error(chosen.error)

    return 1
  }

  if (chosen.length === 0) {
    console.log(`#${number} has no jobs yet (${String(run.state ?? 'unknown')}).`)

    return 0
  }

  for (const job of chosen) {
    console.log(`━━━ ${String(job.name ?? job.job_id ?? 'job')}: ${String(job.state)}${job.error ? ` (${String(job.error)})` : ''} ━━━`)

    let text = ''
    let cursor = 0
    // Bounded: a log is thousands of chunks at most, and a cursor that never
    // settles would otherwise keep a terminal reading for ever.
    for (let page = 0; page < 5_000; page++) {
      const read = await call(connection, 'GET', '/api/repos/workflow-runs/log', {
        query: { owner: target.owner, repo: target.repository, job: job.id, after: cursor, attempt: options.attempt },
      })

      if (!read.ok)
        return report(read)

      const chunks: any[] = read.data?.chunks ?? []
      for (const chunk of chunks)
        text += String(chunk.content ?? '')

      const next = Number(read.data?.cursor ?? cursor)
      if (chunks.length === 0 || next <= cursor)
        break

      cursor = next
    }

    console.log(text ? lastLines(text, options.tail) : '(no output)')
  }

  console.log(runUrl(target, number))

  return 0
}

/** The repository's recent runs, newest first. */
export async function listRuns(options: ListRunsOptions = {}): Promise<number> {
  const connected = await connect(options)
  if (typeof connected === 'number')
    return connected

  const { target, connection } = connected
  const listed = await call(connection, 'GET', '/api/repos/workflow-runs', {
    query: {
      owner: target.owner,
      repo: target.repository,
      state: options.state,
      branch: options.branch,
      per_page: options.limit ?? 20,
    },
  })

  if (!listed.ok)
    return report(listed)

  const rows: any[] = listed.data?.workflow_runs ?? []

  if (rows.length === 0) {
    console.log('No runs.')

    return 0
  }

  for (const row of rows) {
    const sha = String(row.head_sha ?? '').slice(0, 9)
    const ref = String(row.ref ?? '').replace(/^refs\/(heads|tags)\//, '')
    console.log(`#${String(row.number).padEnd(6)} ${String(row.state).padEnd(10)} ${String(row.event).padEnd(18)} ${ref}${sha ? `  ${sha}` : ''}${row.reason ? `  ${row.reason}` : ''}`)
  }

  return 0
}

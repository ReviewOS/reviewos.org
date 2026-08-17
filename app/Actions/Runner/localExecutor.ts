/**
 * The local runner: this host executing this instance's jobs.
 *
 * Off unless somebody starts it. That is the whole of the safety argument and
 * it is deliberately not a configuration flag buried in a file - by [the threat
 * model](../../../docs/ci-threat-model.md) this instance does not execute
 * repository code unless an operator has provided somewhere for it to happen,
 * and `./buddy runner:local` is an operator saying "here".
 *
 * **This is not a security boundary.** A step runs as the user who started the
 * runner, on the host the control plane is on, with that user's filesystem and
 * network. It is the right shape for a single-tenant install - one team, one
 * box, code they wrote - and the wrong shape for anything else. Fork pull
 * requests are refused outright rather than left to a flag, because "untrusted
 * code on the control plane's host" is the one combination that turns a CI
 * feature into somebody else's shell.
 *
 * It speaks the same HTTP protocol as any other runner. Reaching into the
 * database from here would make it a second, privileged kind of runner whose
 * behaviour drifts from the one everybody else uses - and the protocol's rules
 * about leases, late reports and replayed credentials are exactly what should
 * be exercised most, not bypassed.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'

export interface LocalRunnerOptions {
  /** Where this instance is, for the runner protocol. */
  baseUrl: string
  /** The runner's registration credential. */
  token: string
  /** How long to wait between empty claims, in milliseconds. */
  idleMs?: number
  /** Stop after this many jobs. Zero means keep going. */
  maxJobs?: number
  /** Where to check code out. A temporary directory per job by default. */
  workspaceRoot?: string
  /**
   * Where this instance keeps its bare repositories.
   *
   * A same-host runner clones from disk rather than over HTTP: no network, no
   * credential, and nothing to leak. It is the one shortcut this runner takes
   * that a remote one cannot, and it is the reason it is worth having.
   */
  reposRoot?: string
  /** Called with each line the runner wants to say, so a command can print it. */
  say?: (line: string) => void
}

export interface JobOutcome {
  jobId: number
  state: 'succeeded' | 'failed' | 'cancelled'
  reason: string
}

/** A step's result, in the shape the log stream wants to describe it. */
interface StepResult {
  ok: boolean
  exitCode: number
}

/**
 * How long a single step may run before the runner gives up on it.
 *
 * A step that hangs holds the job's lease open forever, and a lease that never
 * expires is a job nobody else will ever be handed. Two hours is longer than
 * any sane step and shorter than "until somebody notices".
 */
const STEP_TIMEOUT_MS = 2 * 60 * 60 * 1000

/** Claim one job and run it, or answer null when there was nothing to take. */
export async function runOnce(options: LocalRunnerOptions): Promise<JobOutcome | null> {
  const say = options.say ?? (() => {})
  const claim = await post(options.baseUrl, '/api/runner/claim', options.token, {})

  if (!claim.ok || !claim.body?.job)
    return null

  const job = claim.body.job
  const jobToken = String(job.token ?? '')

  /*
   * A fork's pull request is refused here, not filtered at the claim.
   *
   * The claim endpoint hands out work by labels and scope; deciding what a
   * *host* runner is willing to execute is the runner's own judgement, and
   * saying no loudly is better than never asking. Reported as failed rather
   * than dropped, so the run reaches a terminal state instead of holding a
   * pull request's checks open forever.
   */
  if (job.run?.trusted === false) {
    const reason = 'The local runner does not execute untrusted runs. A fork\'s pull request needs an isolated runner.'

    say(`refusing job ${job.id}: ${reason}`)
    await append(options.baseUrl, jobToken, 1, `${reason}\n`, 'stderr')
    await report(options.baseUrl, jobToken, 'failed', reason)

    return { jobId: Number(job.id), state: 'failed', reason }
  }

  const workspace = options.workspaceRoot
    ? join(options.workspaceRoot, `job-${job.id}`)
    : mkdtempSync(join(tmpdir(), `reviewos-job-${job.id}-`))

  if (options.workspaceRoot)
    mkdirSync(workspace, { recursive: true })

  let sequence = 1
  const send = async (text: string, stream: 'stdout' | 'stderr' = 'stdout'): Promise<void> => {
    await append(options.baseUrl, jobToken, sequence++, text, stream)
  }

  try {
    await send(`Running job ${job.key} of run ${job.run?.number} on this host.\n`)
    await send(`::group::Workspace\n${workspace}\n::endgroup::\n`)

    /*
     * The checkout, done by the runner rather than by a step.
     *
     * Actions leaves this to `actions/checkout`, and this runner does not
     * resolve actions - so a workflow copied from GitHub would run its steps
     * against an empty directory and fail in a way that reads like a broken
     * product. Checking out first is the difference between "your workflow
     * ran" and "your workflow ran in an empty room".
     */
    const checkout = await checkoutCode({
      reposRoot: options.reposRoot ?? 'storage/repos',
      fullName: String(job.repository_full_name ?? ''),
      sha: String(job.run?.head_sha ?? ''),
      workspace,
      onOutput: (text, stream) => send(text, stream),
    })

    if (!checkout.ok) {
      await report(options.baseUrl, jobToken, 'failed', checkout.reason)
      say(`job ${job.id} failed: ${checkout.reason}`)

      return { jobId: Number(job.id), state: 'failed', reason: checkout.reason }
    }

    const steps: any[] = Array.isArray(job.steps) ? job.steps : []
    let failed: string | null = null

    for (const [index, step] of steps.entries()) {
      const name = String(step.name ?? step.run ?? step.uses ?? `step ${index + 1}`)

      /*
       * `uses:` is not executed. Resolving an action means fetching and running
       * somebody else's code, which needs the action resolution and caching
       * that phase 15 has not built - and guessing at it would run the wrong
       * thing rather than nothing.
       */
      if (step.uses) {
        await send(`::group::${name}\nSkipped: this runner does not resolve actions yet (\`uses: ${step.uses}\`).\n::endgroup::\n`)
        continue
      }

      if (!step.run) {
        await send(`::group::${name}\nNothing to run.\n::endgroup::\n`)
        continue
      }

      await send(`::group::${name}\n`)

      const result = await runStep({
        command: String(step.run),
        cwd: step.working_directory ? join(workspace, String(step.working_directory)) : workspace,
        environment: environmentFor(job, workspace),
        onOutput: (text, stream) => send(text, stream),
      })

      await send('::endgroup::\n')

      if (!result.ok) {
        failed = `${name} exited ${result.exitCode}`
        await send(`${failed}\n`, 'stderr')
        break
      }
    }

    const state = failed ? 'failed' : 'succeeded'

    await report(options.baseUrl, jobToken, state, failed ?? '')
    say(`job ${job.id} ${state}`)

    return { jobId: Number(job.id), state, reason: failed ?? 'every step succeeded' }
  }
  catch (error) {
    /*
     * Anything unexpected is still a finished job.
     *
     * A runner that dies mid-job leaves it running until the lease lapses, and
     * the sweep that reclaims it cannot know whether the work happened. Saying
     * "this failed, here is why" is both honest and terminal.
     */
    const reason = error instanceof Error ? error.message : String(error)

    await report(options.baseUrl, jobToken, 'failed', reason).catch(() => {})
    say(`job ${job.id} failed: ${reason}`)

    return { jobId: Number(job.id), state: 'failed', reason }
  }
  finally {
    if (!options.workspaceRoot)
      rmSync(workspace, { recursive: true, force: true })
  }
}

/**
 * Claim jobs until there are none, or until `maxJobs` have run.
 *
 * One at a time on purpose. A single-tenant box running four jobs in parallel
 * is a box where the fifth thing anybody does is slow, and a runner that
 * quietly eats a machine is worse than one that takes a queue in order.
 */
export async function runLoop(options: LocalRunnerOptions): Promise<JobOutcome[]> {
  const outcomes: JobOutcome[] = []
  const idle = options.idleMs ?? 5000
  const limit = options.maxJobs ?? 0

  for (;;) {
    const outcome = await runOnce(options)

    if (outcome) {
      outcomes.push(outcome)

      if (limit > 0 && outcomes.length >= limit)
        return outcomes

      continue
    }

    if (limit > 0)
      return outcomes

    await new Promise(resolve => setTimeout(resolve, idle))
  }
}

/**
 * The environment a step runs with.
 *
 * The default set Actions defines, so a workflow written for it finds what it
 * expects. Deliberately *not* the whole of this process's environment: the
 * control plane's own variables include the database credentials, and handing
 * those to a repository's script would make the runner a way to read every
 * repository on the instance.
 */
export function environmentFor(job: any, workspace: string): Record<string, string> {
  const run = job?.run ?? {}

  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: process.env.HOME ?? workspace,
    LANG: process.env.LANG ?? 'en_US.UTF-8',
    CI: 'true',
    GITHUB_ACTIONS: 'true',
    REVIEWOS: 'true',
    GITHUB_WORKSPACE: workspace,
    GITHUB_REPOSITORY: String(job?.repository ?? ''),
    GITHUB_SHA: String(run.head_sha ?? ''),
    GITHUB_REF: String(run.ref ?? ''),
    GITHUB_EVENT_NAME: String(run.event ?? ''),
    GITHUB_RUN_ID: String(run.id ?? ''),
    GITHUB_RUN_NUMBER: String(run.number ?? ''),
    GITHUB_JOB: String(job?.key ?? ''),
  }
}

/**
 * Put the run's commit in the workspace.
 *
 * Cloned from the bare repository on disk with `--no-hardlinks`, because a
 * hardlinked clone shares object files with the repository everybody pushes
 * to - and a step that runs `git gc` or writes into `.git` would then be
 * writing into the instance's own copy.
 */
async function checkoutCode(input: {
  reposRoot: string
  fullName: string
  sha: string
  workspace: string
  onOutput: (text: string, stream: 'stdout' | 'stderr') => Promise<void>
}): Promise<{ ok: boolean, reason: string }> {
  if (!input.fullName || !input.sha)
    return { ok: false, reason: 'this job does not say which commit to check out' }

  /*
   * Absolute, always. The clone runs with the workspace as its working
   * directory, so a relative repository root resolves against the workspace
   * rather than against the instance - and the failure reads as "no repository
   * on this host", which sends somebody looking in the wrong place.
   */
  const bare = resolve(input.reposRoot, `${input.fullName}.git`)

  if (!existsSync(bare))
    return { ok: false, reason: `no repository on this host at ${bare}` }

  await input.onOutput(`::group::Checkout\n${input.fullName} at ${input.sha.slice(0, 8)}\n`, 'stdout')

  const clone = await runStep({
    command: `git clone --no-hardlinks --quiet '${bare}' . && git checkout --quiet '${input.sha}'`,
    cwd: input.workspace,
    environment: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: input.workspace, GIT_TERMINAL_PROMPT: '0' },
    onOutput: input.onOutput,
  })

  await input.onOutput('::endgroup::\n', 'stdout')

  return clone.ok
    ? { ok: true, reason: 'checked out' }
    : { ok: false, reason: `the checkout failed (git exited ${clone.exitCode})` }
}

/** Run one command, streaming its output as it arrives. */
async function runStep(input: {
  command: string
  cwd: string
  environment: Record<string, string>
  onOutput: (text: string, stream: 'stdout' | 'stderr') => Promise<void>
}): Promise<StepResult> {
  const child = Bun.spawn(['/bin/sh', '-c', input.command], {
    cwd: input.cwd,
    env: input.environment,
    stdout: 'pipe',
    stderr: 'pipe',
    // No stdin. A step that waits for input on a runner nobody is watching is
    // a step that waits forever.
    stdin: 'ignore',
  })

  const pump = async (stream: ReadableStream<Uint8Array> | null, name: 'stdout' | 'stderr'): Promise<void> => {
    if (!stream)
      return

    const decoder = new TextDecoder()

    for await (const chunk of stream as any)
      await input.onOutput(decoder.decode(chunk), name)
  }

  const timeout = setTimeout(() => child.kill(), STEP_TIMEOUT_MS)

  try {
    await Promise.all([pump(child.stdout as any, 'stdout'), pump(child.stderr as any, 'stderr')])

    const exitCode = await child.exited

    return { ok: exitCode === 0, exitCode }
  }
  finally {
    clearTimeout(timeout)
  }
}

/* ------------------------------------------------------- the wire, verbatim */

async function post(baseUrl: string, path: string, token: string, body: unknown): Promise<{ ok: boolean, body: any }> {
  const answer = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      // The protocol version, which the server checks before the credential.
      'X-Runner-Protocol': '1',
    },
    body: JSON.stringify(body ?? {}),
  })

  const text = await answer.text()

  try {
    return { ok: answer.ok, body: text ? JSON.parse(text) : null }
  }
  catch {
    return { ok: false, body: { error: text.slice(0, 200) } }
  }
}

async function append(baseUrl: string, jobToken: string, sequence: number, content: string, stream: 'stdout' | 'stderr'): Promise<void> {
  await post(baseUrl, '/api/runner/logs', jobToken, { sequence, content, stream })
}

async function report(baseUrl: string, jobToken: string, state: string, error: string): Promise<void> {
  await post(baseUrl, '/api/runner/report', jobToken, { state, error })
}

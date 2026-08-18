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

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { fetchAction } from './actionCache'
import { checkPolicy, defaultPolicy, parseActionRef } from './actionRef'
import type { ActionDefinition } from './actionFile'
import { inputEnvironment, missingInputs, parseActionFile } from './actionFile'
import { CommandReader } from './commands'
import type { ServiceRequest } from './services'
import { resolveServices, serviceEnvironment, waitForPort } from './services'
import { interpolate, shouldRun } from '../Workflow/expression'

export interface LocalRunnerOptions {
  /** Where this instance is, for the runner protocol. */
  baseUrl: string
  /** The runner's registration credential. */
  token: string
  /** How long to wait between empty claims, in milliseconds. */
  idleMs?: number
  /** Stop after this many jobs. Zero means keep going. */
  maxJobs?: number
  /**
   * Stop after this long with nothing to do, in milliseconds. Zero waits
   * forever.
   *
   * What makes an autoscaling group safe to write: a machine that shuts itself
   * down when the queue is empty costs nothing between builds, and the
   * alternative - a scaler that decides when to kill a runner - has to guess
   * whether the runner is mid-job. This one knows.
   */
  idleTimeoutMs?: number
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
  /**
   * Where actions may come from.
   *
   * The closed default - local actions and nothing else - because an action is
   * code from somewhere else that a repository's workflow runs on this
   * instance's runners. Turning that on is an operator's decision, and it is
   * one they should have to make.
   */
  policy?: ReturnType<typeof defaultPolicy>
  /** Where fetched actions are kept, one directory per commit. */
  actionCacheRoot?: string
  /** Where a host's repositories actually live, for a mirror or an air-gapped instance. */
  actionOrigins?: Record<string, string>
  /**
   * A credential for cloning over HTTP, for a runner that is not on the
   * instance's own machine.
   *
   * An access token, sent as basic auth the way `git` sends one. Public
   * repositories need none; a private one needs a token whose bearer may read
   * it, which is an operator's decision rather than something a runner can
   * mint for itself.
   */
  cloneToken?: string
  /**
   * Whether to provide the job's toolchain from pantry.
   *
   * On by default and harmless when pantry is not installed: a repository with
   * no dependency file gets nothing, and a machine with no `pantry` binary is
   * told so once in the log and carries on with what it has.
   *
   * This is the answer to `container: node:20` for the case that is really
   * "give me node 20", which is most of them. It is **not** isolation and this
   * runner does not pretend otherwise - isolation is a separate machine.
   */
  tools?: boolean
  /** Called with each line the runner wants to say, so a command can print it. */
  say?: (line: string) => void
}

export interface JobOutcome {
  jobId: number
  state: 'succeeded' | 'failed' | 'cancelled'
  reason: string
}

/**
 * Whether the instance asked this machine to stop, on the last poll.
 *
 * Module state rather than a return value because `runOnce` answers with a job
 * outcome and null already means "nothing to do" - and a third meaning for null
 * would be read wrong by every caller that has one today.
 */
let stopRequested: string | null = null

/** What the instance last asked this runner to do, and clears it. */
export function takeStopRequest(): string | null {
  const stop = stopRequested

  stopRequested = null

  return stop
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

/**
 * The job timeout when the workflow does not set one.
 *
 * Actions' six hours, on purpose. It is far longer than any job should take and
 * that is the point of a default: it exists so that nothing runs *forever*, not
 * to express an opinion about how long this job should be. A workflow with a
 * view says `timeout-minutes:` and gets it.
 */
const DEFAULT_JOB_TIMEOUT_MINUTES = 360

/** Claim one job and run it, or answer null when there was nothing to take. */
export async function runOnce(options: LocalRunnerOptions): Promise<JobOutcome | null> {
  const say = options.say ?? (() => {})
  const claim = await post(options.baseUrl, '/api/runner/claim', options.token, {})

  if (!claim.ok || !claim.body?.job) {
    // The answer to "have you got work" carries the answer to "should I still
    // be here", because a poll is the only moment the instance can say so.
    if (claim.body?.stop)
      stopRequested = String(claim.body.stop)

    return null
  }

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

  /*
   * Every byte a step prints goes through the command reader before it goes
   * anywhere else.
   *
   * That ordering is the point: `::add-mask::` has to hide a value in the same
   * chunk that introduced it, and an annotation has to be collected before the
   * text is shipped. Doing it server-side instead would mean the secret
   * crossing the wire first, which is a masking feature that does not mask.
   */
  const reader = new CommandReader()

  maskDeliveredSecrets(reader, job)

  const annotations: any[] = []
  const summary: string[] = []

  let pending = ''

  const send = async (text: string, stream: 'stdout' | 'stderr' = 'stdout'): Promise<void> => {
    pending += text

    const lines = pending.split('\n')
    pending = lines.pop() ?? ''

    const kept: string[] = []

    for (const line of lines) {
      const result = reader.read(line)

      if (result.annotation)
        annotations.push(result.annotation)

      if (result.line !== null)
        kept.push(result.line)
    }

    if (kept.length > 0)
      await append(options.baseUrl, jobToken, sequence++, `${kept.join('\n')}\n`, stream)
  }

  /** Anything left in the buffer when a step ends, which is a line without its newline. */
  const flush = async (stream: 'stdout' | 'stderr' = 'stdout'): Promise<void> => {
    if (!pending)
      return

    const result = reader.read(pending)

    pending = ''

    if (result.annotation)
      annotations.push(result.annotation)

    if (result.line !== null)
      await append(options.baseUrl, jobToken, sequence++, `${result.line}\n`, stream)
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
      /*
       * Where to clone from when the bare repository is not on this machine,
       * which is every runner that is not the instance's own host.
       */
      baseUrl: options.baseUrl,
      cloneToken: options.cloneToken,
      onOutput: (text, stream) => send(text, stream),
    })

    if (!checkout.ok) {
      await report(options.baseUrl, jobToken, 'failed', checkout.reason)
      say(`job ${job.id} failed: ${checkout.reason}`)

      return { jobId: Number(job.id), state: 'failed', reason: checkout.reason }
    }

  /*
   * The event payload, on disk, before the first step and after the checkout.
   *
   * `GITHUB_EVENT_PATH` points at this. Half the ecosystem reads the payload
   * rather than the environment - `event.pull_request.base.ref` is how the
   * changed-files actions work - and an action that finds nothing there does
   * nothing and says nothing.
   *
   * Inside the workspace's own runner directory, alongside the step files,
   * which means it goes when the workspace goes. A payload left in the host's
   * temp directory outlives the job that owned it.
   *
   * **After the checkout**, which is not a detail: the clone wants an empty
   * directory and refuses one that already holds anything, so writing this
   * first turned every job into "destination path '.' already exists".
   */
  const runnerDirectory = join(workspace, '.reviewos-runner')

  mkdirSync(join(runnerDirectory, 'temp'), { recursive: true })
  mkdirSync(join(runnerDirectory, 'tools'), { recursive: true })

  const eventPath = join(runnerDirectory, 'event.json')

  writeFileSync(eventPath, JSON.stringify(job.event ?? {}, null, 2))

  // Read back by `environmentFor`, which is the one place that decides what a
  // step can see.
  job.event_path = eventPath

    /*
     * The toolchain the repository asked for, before the first step.
     *
     * A checkout with a `deps.yaml` or `dependencies.yaml` names the versions
     * it needs, and pantry installs them and says where they went. That is the
     * honest alternative to a container image for the case that is really
     * "give me node 22": no image to bake, no registry, and a machine that
     * needs a different version tomorrow installs it rather than being rebuilt.
     */
    const toolchain = options.tools === false ? '' : await provideTools(workspace, text => send(text))

    /*
     * `services:` - a database beside the job, started with pantry.
     *
     * Before the toolchain would also work; after it is deliberate, because a
     * repository whose dependency file pins the database version wants pantry
     * to have read that file first.
     *
     * A service this runner cannot serve **fails the job here**, before a step
     * has run. Carrying on produces a connection refused three minutes later,
     * in a log nobody reads to the bottom, and the person debugging it has no
     * reason to suspect the `services:` line at all.
     */
    const started = await startServices(job, text => send(text))

    if (!started.ok) {
      await report(options.baseUrl, jobToken, 'failed', started.reason)
      say(`job ${job.id} failed: ${started.reason}`)

      return { jobId: Number(job.id), state: 'failed', reason: started.reason }
    }

    const serviceEnv = started.environment

    /*
     * The upload command, written into the workspace as a script on PATH.
     *
     * A job generating steps needs one line it can run - `reviewos-upload
     * steps.yml` - rather than a curl invocation with a credential in it. The
     * credential stays in the script, outside the checkout, so a step that
     * prints its own environment does not print it.
     */
    const uploadPath = writeUploadCommand(workspace, options.baseUrl, jobToken)

    if (uploadPath)
      writeSplitCommand(uploadPath, options.baseUrl, jobToken)

    const steps: any[] = Array.isArray(job.steps) ? job.steps : []
    let failed: string | null = null
    /*
     * What the failing step exited with, carried to the report so
     * `retry: { exit-status: [137] }` can mean something. Null when the job
     * failed for a reason that is not an exit status at all.
     */
    let failedStatus: number | null = null

    /*
     * When this job runs out of time.
     *
     * Checked between steps rather than enforced with one timer over the whole
     * job: killing a step mid-write leaves a workspace nobody can explain, and
     * the honest report - "this step is where the time went" - needs the step
     * boundary anyway. A single step that hangs past the deadline is still
     * caught, by `STEP_TIMEOUT_MS` inside `runStep`.
     */
    const minutes = Number(job.timeout_minutes ?? DEFAULT_JOB_TIMEOUT_MINUTES)
    const deadline = Date.now() + (Number.isFinite(minutes) && minutes > 0 ? minutes : DEFAULT_JOB_TIMEOUT_MINUTES) * 60_000

    /*
     * What one step tells the next.
     *
     * `GITHUB_ENV` and `GITHUB_PATH` are files a step appends to, read after it
     * exits and applied to every step after it. A step exporting a variable in
     * its own shell cannot affect the next one - each is its own process - and
     * this file is the whole reason Actions can pretend otherwise.
     */
    const carried: Record<string, string> = {}
    let extraPath = ''

    /*
     * What the steps so far have produced, in the shape an expression reads.
     *
     * This is the whole reason step-level `if:` had to wait for the runner: a
     * condition like `steps.build.outputs.changed == 'true'` cannot be answered
     * before the step called `build` has run, so it cannot be answered at
     * dispatch at all.
     */
    const stepContext: Record<string, { outputs: Record<string, string>, outcome: string, conclusion: string }> = {}
    let jobFailed = false

    for (const [index, step] of steps.entries()) {
      const name = String(step.name ?? step.run ?? step.uses ?? `step ${index + 1}`)

      if (Date.now() >= deadline) {
        /*
         * Out of time, said here rather than left to the lease.
         *
         * The control plane would eventually notice - a job past its deadline
         * is swept - but "the runner stopped talking" is what that looks like
         * from the outside, and it sends somebody to check their
         * infrastructure when the answer is a step that hangs. The runner knows
         * which step it was about to run, so it says so.
         */
        failed = `this job hit its ${minutes}-minute timeout before \`${name}\``
        jobFailed = true
        await send(`${failed}\n`, 'stderr')
        break
      }

      /*
       * The step's own condition, evaluated here rather than at dispatch.
       *
       * `job.status` is what makes `if: always()` and `if: failure()` work, and
       * it is the reason a step can run after an earlier one failed - which is
       * how anybody uploads logs from a broken build.
       */
      const context = expressionContext(job, workspace, {
        status: jobFailed ? 'failure' : 'success',
        steps: stepContext,
        env: { ...environmentFor(job, workspace), ...serviceEnv, ...carried },
      })

      const decision = shouldRun(step.if, context)

      if (!decision.run) {
        await send(`::group::${name}\nSkipped: ${decision.reason}\n::endgroup::\n`)

        if (step.id) {
          stepContext[String(step.id)] = { outputs: {}, outcome: 'skipped', conclusion: 'skipped' }
        }

        continue
      }

      if (step.uses) {
        await send(`::group::${name}\n`)

        const result = await runAction({
          uses: String(step.uses),
          with: step.with ?? {},
          workspace,
          job,
          policy: options.policy ?? defaultPolicy(),
          cacheRoot: options.actionCacheRoot ?? 'storage/framework/runtime/actions',
          origins: options.actionOrigins,
          environment: { ...environmentFor(job, workspace), ...serviceEnv, ...carried },
          onOutput: (text, stream) => send(text, stream),
        })

        await flush()
        await send('::endgroup::\n')

        if (!result.ok) {
          /*
           * `continue-on-error` decided here rather than at the end.
           *
           * A step that says the job survives its failure is a step whose
           * failure is expected, and treating it as fatal turns an optional
           * lint into a broken pipeline. The message still goes to the log,
           * because "expected to fail" is not "not worth mentioning".
           */
          if (step.continue_on_error) {
            await send(`${name} failed, and the step says the job continues: ${result.reason}\n`, 'stderr')
            continue
          }

          failed = `${name}: ${result.reason}`
          await send(`${failed}\n`, 'stderr')
          break
        }

        continue
      }

      if (!step.run) {
        await send(`::group::${name}\nNothing to run.\n::endgroup::\n`)
        continue
      }

      await send(`::group::${name}\n`)

      const files = stepFiles(workspace, index)
      const environment = {
        ...environmentFor(job, workspace),
        ...serviceEnv,
        ...carried,
        ...files.environment,
      }

      /*
       * The repository's own toolchain goes on first, so `GITHUB_PATH` from a
       * step still wins: a step that installed something and put it on the
       * path is making a decision about *this run*, and a version the
       * repository pinned should not override it.
       */
      if (toolchain)
        environment.PATH = `${toolchain}:${environment.PATH}`

      // The upload command, ahead of the toolchain so a repository cannot
      // shadow it with a binary of its own name.
      if (uploadPath)
        environment.PATH = `${uploadPath}:${environment.PATH}`

      if (extraPath)
        environment.PATH = `${extraPath}:${environment.PATH}`

      const result = await runStep({
        /*
         * The expressions in a `run:` are filled in before the shell sees it.
         *
         * That is what Actions does and the reason a workflow can say
         * `echo "${{ steps.build.outputs.artifact }}"` at all - without it the
         * shell is handed the literal braces and answers "bad substitution",
         * which is what this did until a test ran a real workflow.
         *
         * It is also the well-known injection shape: a value spliced into a
         * shell command is a value that can end the command and start another,
         * and Actions has the same property by design. What keeps it honest is
         * that the value comes from this run's own steps and event, quoting is
         * the workflow author's job exactly as it is on Actions, and anything
         * this cannot resolve is left as written rather than becoming an empty
         * string that silently changes what the command means.
         */
        command: interpolate(String(step.run), context),
        cwd: step.working_directory ? join(workspace, interpolate(String(step.working_directory), context)) : workspace,
        // A step's own `env:` is the narrowest level, so it wins - the same
        // precedence `Workflow/env.ts` describes for the levels above it - and
        // its values are expressions too.
        environment: { ...environment, ...interpolateValues(step.env ?? {}, context) },
        /*
         * The step's own timeout, when it has one.
         *
         * Narrower than the job's and the more useful of the two: a job
         * allowed sixty minutes that hangs in a thirty-second health check
         * spends fifty-nine of them proving nothing. Falls back to the
         * runner's own ceiling, which exists so that nothing hangs forever.
         */
        timeoutMs: Number.isFinite(Number(step.timeout_minutes)) && Number(step.timeout_minutes) > 0
          ? Number(step.timeout_minutes) * 60_000
          : undefined,
        onOutput: (text, stream) => send(text, stream),
      })

      await flush()

      // What the step wrote to its files, applied to the ones after it.
      const written = readStepFiles(files)

      Object.assign(carried, written.environment)

      /*
       * The step's outputs and its outcome, for the steps after it.
       *
       * `outcome` is what happened; `conclusion` is what it counts as, which
       * differ exactly when `continue-on-error` turned a failure into a
       * non-failure - and a later step reading one when it meant the other is
       * the bug this distinction exists to prevent.
       */
      if (step.id) {
        stepContext[String(step.id)] = {
          outputs: written.outputs,
          outcome: result.ok ? 'success' : 'failure',
          conclusion: result.ok || step.continue_on_error ? 'success' : 'failure',
        }
      }

      if (written.path)
        extraPath = extraPath ? `${written.path}:${extraPath}` : written.path

      if (written.summary)
        summary.push(written.summary)

      for (const value of written.masks)
        reader.addMask(value)

      await send('::endgroup::\n')

      if (!result.ok) {
        if (step.continue_on_error) {
          await send(`${name} exited ${result.exitCode}, and the step says the job continues\n`, 'stderr')
          continue
        }

        failed = `${name} exited ${result.exitCode}`
        failedStatus = result.exitCode
        jobFailed = true
        await send(`${failed}\n`, 'stderr')

        /*
         * The loop does not stop here any more.
         *
         * A step with `if: always()` or `if: failure()` exists to run after a
         * failure - uploading logs, posting a comment, tearing down a
         * deployment - and breaking out would skip exactly the steps written
         * for this moment. The job still fails; what changes is that the file
         * gets to say what happens next.
         */
        continue
      }
    }

    await flush()

    /*
     * The job's outputs, resolved now that the steps have run.
     *
     * `outputs: { name: '${{ steps.build.outputs.name }}' }` is an expression
     * over the step context, which is why it is resolved here and not at parse
     * time - and why an expression this cannot resolve is left as written
     * rather than becoming an empty string somebody has to explain.
     */
    const declaredOutputs = (job.outputs && typeof job.outputs === 'object') ? job.outputs : {}
    const resolvedOutputs: Record<string, string> = {}

    for (const [name, expression] of Object.entries(declaredOutputs as Record<string, unknown>)) {
      resolvedOutputs[name] = interpolate(
        String(expression ?? ''),
        expressionContext(job, workspace, {
          status: failed ? 'failure' : 'success',
          steps: stepContext,
          env: { ...environmentFor(job, workspace), ...serviceEnv, ...carried },
        }),
      )
    }

    const state = failed ? 'failed' : 'succeeded'

    /*
     * Annotations and the summary go before the conclusion, on purpose.
     *
     * Reporting the conclusion is what makes a run terminal, and a check that
     * arrives after its run has finished is a check nobody was waiting for.
     * This way the diff has the annotations by the time the run says it failed.
     */
    if (annotations.length > 0 || summary.length > 0) {
      await post(options.baseUrl, '/api/runner/annotations', jobToken, {
        annotations: annotations.slice(0, 200).map(annotation => ({
          level: annotation.level,
          message: annotation.message,
          path: annotation.path,
          start_line: annotation.startLine,
          end_line: annotation.endLine,
          title: annotation.title,
        })),
        summary: summary.join('\n').slice(0, 60_000),
      })
    }

    await report(options.baseUrl, jobToken, state, failed ?? '', resolvedOutputs, failedStatus)
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
  const idleTimeout = options.idleTimeoutMs ?? 0

  let idleSince = Date.now()

  for (;;) {
    const outcome = await runOnce(options)

    if (outcome) {
      outcomes.push(outcome)
      idleSince = Date.now()

      if (limit > 0 && outcomes.length >= limit)
        return outcomes

      continue
    }

    if (limit > 0)
      return outcomes

    /*
     * An operator asked this machine to stop. Answered by leaving the loop
     * rather than by killing anything: `runOnce` returns when the job it was
     * running has finished, so a graceful stop is graceful by construction.
     */
    const stop = takeStopRequest()

    if (stop) {
      options.say?.(`the instance asked this runner to stop (${stop})`)

      return outcomes
    }

    /*
     * Measured from the last job rather than from the last poll, so a runner
     * that has been busy does not shut down the moment the queue empties for
     * one cycle.
     */
    if (idleTimeout > 0 && Date.now() - idleSince >= idleTimeout)
      return outcomes

    await new Promise(resolve => setTimeout(resolve, idle))
  }
}

/**
 * The contexts an expression can read.
 *
 * One function rather than an object literal per call site, because a `run:`
 * that interpolates `${{ github.actor }}` and a job output that interpolates
 * the same thing must see the same value - two literals drift, and the drift
 * shows up as a value that is right in one place and empty in the other.
 *
 * `github` is the ecosystem's name and `reviewos` is the same object under
 * this forge's, the way the environment variables are aliased: a workflow
 * should be able to say where it is running without naming somebody else's
 * product, and one written for Actions should not have to be edited.
 */
function expressionContext(
  job: any,
  workspace: string,
  state: { status: string, steps: Record<string, unknown>, env: Record<string, string> },
): Record<string, unknown> {
  const run = job?.run ?? {}
  const ref = String(run.ref ?? '')
  const full = String(job?.repository_full_name ?? '')

  const github = {
    workflow: String(run.workflow ?? ''),
    event_name: String(run.event ?? ''),
    event: job?.event ?? {},
    event_path: String(job?.event_path ?? ''),
    ref,
    ref_name: ref.replace(/^refs\/(?:heads|tags)\//, ''),
    ref_type: ref.startsWith('refs/tags/') ? 'tag' : (ref.startsWith('refs/heads/') ? 'branch' : ''),
    head_ref: String(run.head_ref ?? ''),
    base_ref: String(run.base_ref ?? ''),
    sha: String(run.head_sha ?? ''),
    repository: full,
    repository_owner: full.split('/')[0] ?? '',
    actor: String(run.actor ?? ''),
    triggering_actor: String(run.actor ?? ''),
    run_id: String(run.id ?? ''),
    run_number: String(run.number ?? ''),
    run_attempt: String(run.attempt ?? '1'),
    job: String(job?.key ?? ''),
    workspace,
    server_url: String(job?.server_url ?? ''),
    api_url: String(job?.api_url ?? ''),
    /*
     * `github.token`, which is the other name half the ecosystem reads the
     * automatic credential by. The same value as `secrets.GITHUB_TOKEN`, so an
     * action written either way works and neither is a second thing to mint.
     */
    token: String((job?.secrets as any)?.GITHUB_TOKEN ?? ''),
  }

  return {
    github,
    reviewos: github,
    job: { status: state.status },
    steps: state.steps,
    needs: job?.needs ?? {},
    matrix: job?.matrix_values ?? {},
    // `inputs` is what a `workflow_dispatch` or a called workflow reads, and it
    // travels in the event payload because that is where the run recorded it.
    inputs: (job?.event && typeof job.event === 'object' ? (job.event as any).inputs : null) ?? {},
    /*
     * `vars`, already resolved across instance, owner, repository and the
     * workflow file by the control plane.
     *
     * Resolved there rather than merged here, so the precedence exists once:
     * two implementations of "narrowest wins" is two answers to "why is this
     * value what it is", and the screen that explains it reads the same one.
     */
    vars: job?.vars ?? {},
    /*
     * `secrets`, for `${{ secrets.DEPLOY_TOKEN }}`.
     *
     * Readable through the context and **not** injected into the environment,
     * which is Actions' behaviour and the right one: a workflow that wants a
     * secret in a variable says so with `env:`, and a step that was never told
     * about a credential does not have it in its environment where a child
     * process, a crash dump or a `printenv` would find it.
     */
    secrets: job?.secrets ?? {},
    runner: {
      os: runnerOs(),
      arch: runnerArch(),
      name: String(job?.runner_name ?? 'local'),
      temp: join(workspace, '.reviewos-runner', 'temp'),
      tool_cache: join(workspace, '.reviewos-runner', 'tools'),
    },
    env: state.env,
  }
}

/**
 * Start whatever the job's `services:` asked for, with pantry.
 *
 * A workflow writing `services: { postgres: { image: postgres:16 } }` wants one
 * thing: a database on a port before the first step. Every other forge answers
 * that with a container; this instance has pantry, which starts and
 * health-checks sixty-eight of exactly these.
 *
 * **A service already running is used rather than restarted**, and not stopped
 * afterwards. Pantry's services are the machine's, not this job's - stopping
 * one at the end of a job would take down the database another job on the same
 * runner is mid-query against.
 */
type ServiceStart =
  | { ok: true, environment: Record<string, string> }
  | { ok: false, reason: string }

async function startServices(job: any, say: (line: string) => Promise<void>): Promise<ServiceStart> {
  const requests = servicesOf(job)

  if (requests.length === 0)
    return { ok: true, environment: {} }

  const decision = resolveServices(requests)

  if (!decision.ok)
    return { ok: false, reason: decision.reason }

  await say('::group::Services\n')

  for (const service of decision.services) {
    await say(`${service.name}: pantry start ${service.service}\n`)

    const child = Bun.spawn(['pantry', 'start', service.service], { stdout: 'pipe', stderr: 'pipe' })

    await child.exited

    /*
     * Started is not ready. Postgres accepts connections a second or two after
     * the process exists, and a first step that connects immediately fails on
     * a fast machine and passes on a slow one - which is where a whole class
     * of "flaky CI" comes from.
     */
    const ready = await waitForPort(service.port)

    if (!ready) {
      await say('::endgroup::\n')

      return {
        ok: false,
        reason: `\`${service.name}\` never started listening on port ${service.port}. `
          + 'Check `pantry logs ' + service.service + '` on the runner.',
      }
    }

    await say(`${service.name}: ready on 127.0.0.1:${service.port}\n`)
  }

  await say('::endgroup::\n')

  return { ok: true, environment: serviceEnvironment(decision.services) }
}

/** A job's `services:`, out of the settings the control plane copied forward. */
function servicesOf(job: any): ServiceRequest[] {
  try {
    const settings = typeof job?.settings === 'string' ? JSON.parse(job.settings) : (job?.settings ?? {})
    const services = Array.isArray(settings?.services) ? settings.services : []

    return services
      .filter((one: any) => one && typeof one === 'object' && one.image)
      .map((one: any) => ({
        name: String(one.name ?? ''),
        image: String(one.image),
        env: (one.env && typeof one.env === 'object' ? one.env : {}) as Record<string, string>,
      }))
  }
  catch {
    return []
  }
}

/**
 * Register every secret this job was given, before the first step runs.
 *
 * Registered whether or not the workflow ever prints one, because the way a
 * credential reaches a log is never `echo $TOKEN` - it is a curl that fails and
 * prints the request it tried, or a tool that dumps its configuration on error.
 * By then nobody is watching, and the log is the artefact somebody links to in
 * a chat channel.
 *
 * Masking happens here rather than on the control plane for the reason the
 * reader's own note gives: server-side masking is a masking feature that lets
 * the secret cross the wire first.
 */
export function maskDeliveredSecrets(reader: CommandReader, job: any): void {
  for (const value of Object.values((job?.secrets ?? {}) as Record<string, string>))
    reader.addMask(String(value ?? ''))
}

/**
 * Write `reviewos-split` next to it, for a job that shards a test suite.
 *
 * `reviewos-split unit 4 "$INDEX" < files` prints the files this node should
 * run, one per line, ordered slowest first. Written as a sibling of
 * `reviewos-upload` and for the same reason: the alternative is every sharding
 * job carrying a repository credential in its own script, to read timings the
 * job token can already read.
 */
export function writeSplitCommand(directory: string, baseUrl: string, jobToken: string): void {
  try {
    const path = join(directory, 'reviewos-split')

    writeFileSync(path, `#!/bin/sh
# Which of these tests this node should run.
# Usage: reviewos-split <suite> <nodes> <index> [file]
set -e
items=$(cat "\${4:--}")
printf '%s' "$items" | ${JSON.stringify(process.execPath)} -e '
const [suite, nodes, index] = process.argv.slice(1)
const items = require("fs").readFileSync(0, "utf8")
const answer = await fetch(${JSON.stringify(`${baseUrl.replace(/\/$/, '')}/api/runner/split`)}, {
  method: "POST",
  headers: {
    "Authorization": ${JSON.stringify(`Bearer ${jobToken}`)},
    "Content-Type": "application/json",
    "X-Runner-Protocol": "1",
  },
  body: JSON.stringify({ suite, nodes: Number(nodes), index: Number(index), items }),
})
const body = await answer.json()
if (!answer.ok) { console.error(body.error || "split refused"); process.exit(1) }
// The note goes to stderr so a pipe into xargs still works, and so a split
// computed from no history says so where somebody will read it.
if (body.note) console.error(body.note)
process.stdout.write((body.items || []).join("\\n") + "\\n")
' "$1" "$2" "$3"
`)

    chmodSync(path, 0o700)
  }
  catch {
    // Same as the upload command: a convenience over an endpoint that is still
    // there, and not a reason to fail a build.
  }
}

/**
 * Write `reviewos-upload` into a directory on the job's PATH.
 *
 * One line for a job that generates steps: `reviewos-upload generated.yml`, or
 * the same document on stdin. The alternative is every generating job carrying
 * a curl invocation with a job credential in it, which is a credential in a
 * repository's own script and eventually in its own log.
 *
 * The credential lives in this script rather than in the environment, and the
 * script lives *outside* the checkout - so a step that prints its environment,
 * or a `tar` of the workspace, does not carry it.
 */
export function writeUploadCommand(workspace: string, baseUrl: string, jobToken: string): string {
  try {
    const directory = join(workspace, '..', `.reviewos-bin-${process.pid}`)

    mkdirSync(directory, { recursive: true })

    const path = join(directory, 'reviewos-upload')

    writeFileSync(path, `#!/bin/sh
# Add generated jobs to this run. Usage: reviewos-upload [file]
set -e
steps=$(cat "\${1:--}")
exec curl -sS -X POST ${JSON.stringify(`${baseUrl.replace(/\/$/, '')}/api/runner/upload`)} \
  -H "Authorization: Bearer ${jobToken}" \
  -H 'Content-Type: application/json' \
  -H 'X-Runner-Protocol: 1' \
  --data-binary "$(printf '%s' "$steps" | ${JSON.stringify(process.execPath)} -e 'process.stdout.write(JSON.stringify({ steps: require("fs").readFileSync(0, "utf8") }))')"
`)

    chmodSync(path, 0o700)

    return directory
  }
  catch {
    /*
     * A workspace this cannot write to is one where the job still runs. The
     * upload command is a convenience over an HTTP endpoint that is still
     * there, and failing the job over it would be refusing to run a build
     * because a nicety was unavailable.
     */
    return ''
  }
}

/**
 * Install and locate what the checked-out repository says it needs.
 *
 * Answers the PATH entries to prepend, or an empty string when there is nothing
 * to do - which is every repository that does not use pantry, and every machine
 * that does not have it. Neither is a failure: a job whose workflow installs its
 * own tools is a perfectly ordinary job.
 *
 * `pantry env --install --json` does the work; this only reads the answer. The
 * alternative - this runner parsing dependency files and resolving versions
 * itself - would be a second implementation of pantry that drifts from the
 * first, in the one place where being wrong means building against the wrong
 * compiler.
 */
async function provideTools(workspace: string, say: (line: string) => Promise<void>): Promise<string> {
  const manifests = ['deps.yaml', 'deps.yml', 'dependencies.yaml', 'dependencies.yml', 'pkgx.yaml', 'pkgx.yml']

  if (!manifests.some(name => existsSync(join(workspace, name))))
    return ''

  await say('::group::Toolchain\n')

  const child = Bun.spawn(['pantry', 'env', '--install', '--json', '--dir', workspace], {
    cwd: workspace,
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'ignore',
  })

  const [out, error, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])

  if (code !== 0) {
    /*
     * Said once and not fatal. A machine without pantry is a machine whose
     * jobs install their own tools, which is how every workflow written for
     * Actions already works.
     */
    await say(`This repository declares its tools, and pantry is not available here: ${(error || out).trim().slice(0, 300)}\n`)
    await say('::endgroup::\n')

    return ''
  }

  try {
    const answer = JSON.parse(out)
    const entries: string[] = Array.isArray(answer?.path) ? answer.path.map(String) : []

    if (Array.isArray(answer?.dependencies) && answer.dependencies.length > 0)
      await say(`Using ${answer.dependencies.join(', ')}\n`)

    await say('::endgroup::\n')

    return entries.join(':')
  }
  catch {
    await say('::endgroup::\n')

    return ''
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
 *
 * **Every name is set twice**, once as `GITHUB_*` and once as `REVIEWOS_*`.
 * The first is what the ecosystem reads and dropping it would break every
 * action ever written; the second is what this forge is, and a workflow that
 * wants to say so should not have to name somebody else's product to do it.
 * Aliased rather than chosen, because a script that reads one and a script that
 * reads the other are both right.
 *
 * `RUNNER_*` keeps its own prefix. It describes the machine rather than the
 * forge, and `REVIEWOS_OS` would be a claim about the wrong thing.
 */
export function environmentFor(job: any, workspace: string): Record<string, string> {
  const run = job?.run ?? {}
  const ref = String(run.ref ?? '')

  const shared: Record<string, string> = {
    WORKSPACE: workspace,
    REPOSITORY: String(job?.repository_full_name ?? job?.repository ?? ''),
    REPOSITORY_OWNER: String(job?.repository_full_name ?? '').split('/')[0] ?? '',
    SHA: String(run.head_sha ?? ''),
    REF: ref,
    // `refs/heads/main` is what git calls it; `main` is what a script wants,
    // and every workflow that lacks this writes the same `sed` to get it.
    REF_NAME: ref.replace(/^refs\/(?:heads|tags)\//, ''),
    REF_TYPE: ref.startsWith('refs/tags/') ? 'tag' : (ref.startsWith('refs/heads/') ? 'branch' : ''),
    /*
     * Empty outside a pull request, and empty is the answer rather than an
     * absence: `if [ -n "$GITHUB_BASE_REF" ]` is how half the ecosystem asks
     * "am I on a pull request", and an unset variable answers it the same way
     * a wrong one does not.
     */
    HEAD_REF: String(run.head_ref ?? ''),
    BASE_REF: String(run.base_ref ?? ''),
    EVENT_NAME: String(run.event ?? ''),
    EVENT_PATH: String(job?.event_path ?? ''),
    WORKFLOW: String(run.workflow ?? ''),
    JOB: String(job?.key ?? ''),
    RUN_ID: String(run.id ?? ''),
    RUN_NUMBER: String(run.number ?? ''),
    RUN_ATTEMPT: String(run.attempt ?? '1'),
    ACTOR: String(run.actor ?? ''),
    TRIGGERING_ACTOR: String(run.actor ?? ''),
    SERVER_URL: String(job?.server_url ?? ''),
    API_URL: String(job?.api_url ?? ''),
    RETENTION_DAYS: String(job?.retention_days ?? ''),
  }

  const environment: Record<string, string> = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: process.env.HOME ?? workspace,
    LANG: process.env.LANG ?? 'en_US.UTF-8',
    CI: 'true',
    GITHUB_ACTIONS: 'true',
    REVIEWOS: 'true',
    /*
     * What machine this is, under the names Actions uses. `RUNNER_TEMP` and
     * `RUNNER_TOOL_CACHE` are inside the workspace rather than in the host's
     * `/tmp`: a step that writes to a shared temp directory is a step that can
     * read what the last job left there, and on a single-tenant box the last
     * job may still have been somebody else's branch.
     */
    RUNNER_OS: runnerOs(),
    RUNNER_ARCH: runnerArch(),
    RUNNER_NAME: String(job?.runner_name ?? 'local'),
    RUNNER_ENVIRONMENT: 'self-hosted',
    RUNNER_TEMP: join(workspace, '.reviewos-runner', 'temp'),
    RUNNER_TOOL_CACHE: join(workspace, '.reviewos-runner', 'tools'),
  }

  for (const [name, value] of Object.entries(shared)) {
    environment[`GITHUB_${name}`] = value
    environment[`REVIEWOS_${name}`] = value
  }

  /*
   * Which shard this is, for a job that asked for `parallelism:`.
   *
   * `REVIEWOS_*` only, with no `GITHUB_*` twin: Actions has no such variable,
   * and inventing a `GITHUB_PARALLEL_JOB` would be this instance putting words
   * in GitHub's mouth - a workflow written against it would silently do
   * something else on the platform it names.
   *
   * **Zero-based**, which is what `/api/repos/tests/split` takes and what
   * Buildkite exports, while the job's *name* on the run screen counts from
   * one. That split is deliberate and it is the one thing to get wrong here, so
   * it is written down in both places.
   */
  if (job?.parallel && Number(job.parallel.total) > 0) {
    environment.REVIEWOS_PARALLEL_JOB = String(Number(job.parallel.index ?? 0))
    environment.REVIEWOS_PARALLEL_JOB_COUNT = String(Number(job.parallel.total))
  }

  return environment
}

/** Actions' spelling: `Linux`, `macOS`, `Windows`. */
function runnerOs(): string {
  if (process.platform === 'darwin')
    return 'macOS'

  if (process.platform === 'win32')
    return 'Windows'

  return 'Linux'
}

/** Actions' spelling: `X86`, `X64`, `ARM`, `ARM64`. */
function runnerArch(): string {
  if (process.arch === 'arm64')
    return 'ARM64'

  if (process.arch === 'arm')
    return 'ARM'

  if (process.arch === 'ia32')
    return 'X86'

  return 'X64'
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
  baseUrl?: string
  cloneToken?: string
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
  const onHost = existsSync(bare)

  /*
   * Two sources, and which one is used is a fact about *where this runner is*
   * rather than a setting.
   *
   * On the instance's own machine the bare repository is right there:
   * `--no-hardlinks` so a step running `git gc` cannot write into the objects
   * everybody pushes to, no network, and no credential. On any other machine
   * there is nothing on disk, so it clones over the instance's ordinary git
   * endpoint - the same URL a person would.
   */
  const source = onHost ? bare : `${String(input.baseUrl ?? '').replace(/\/$/, '')}/${input.fullName}.git`

  if (!onHost && !input.baseUrl)
    return { ok: false, reason: `no repository on this host at ${bare}, and nowhere to clone it from` }

  await input.onOutput(`::group::Checkout\n${input.fullName} at ${input.sha.slice(0, 8)}\n`, 'stdout')

  const clone = await runStep({
    command: onHost
      ? `git clone --no-hardlinks --quiet '${source}' . && git checkout --quiet '${input.sha}'`
      // A shallow fetch of the one commit, which is what a remote runner
      // actually needs: the history is the instance's, not this machine's.
      : `git init --quiet . && git remote add origin '${source}' && git fetch --quiet --depth 1 origin '${input.sha}' && git checkout --quiet FETCH_HEAD`,
    cwd: input.workspace,
    environment: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: input.workspace,
      GIT_TERMINAL_PROMPT: '0',
      /*
       * The credential, when there is one, through an askpass helper rather
       * than in the URL: a token in a remote URL is written into
       * `.git/config`, which is inside the workspace a step can read.
       */
      ...(input.cloneToken && !onHost
        ? {
            GIT_ASKPASS: askpassFor(input.workspace, input.cloneToken),
            GIT_CONFIG_PARAMETERS: `'credential.helper='`,
          }
        : {}),
    },
    onOutput: input.onOutput,
  })

  await input.onOutput('::endgroup::\n', 'stdout')

  return clone.ok
    ? { ok: true, reason: 'checked out' }
    : { ok: false, reason: `the checkout failed (git exited ${clone.exitCode})` }
}

/**
 * A one-line askpass script holding the clone credential.
 *
 * Outside the workspace, mode 0700, and removed with the workspace's parent
 * when the job ends. The alternative - `https://token@host/...` - writes the
 * credential into `.git/config` *inside the checkout*, where the repository's
 * own steps can read it.
 */
function askpassFor(workspace: string, token: string): string {
  const path = join(workspace, '..', `.reviewos-askpass-${process.pid}`)

  writeFileSync(path, `#!/bin/sh\ncase "$1" in\n  Username*) echo "x-access-token" ;;\n  *) echo ${JSON.stringify(token)} ;;\nesac\n`)
  chmodSync(path, 0o700)

  return path
}

/**
 * Run a `uses:` step.
 *
 * Local actions only, for now, and the refusal for everything else is a
 * *message* rather than silence: a step that did nothing and said nothing is
 * the failure people spend an afternoon on.
 *
 * A composite action's steps run here, in order, with the caller's environment
 * plus the action's inputs. That is most of what an action is in practice -
 * repositories' own actions are nearly all composite - and it needs nothing
 * this runner does not already have.
 */
async function runAction(input: {
  uses: string
  with: Record<string, unknown>
  workspace: string
  job: any
  policy: ReturnType<typeof defaultPolicy>
  cacheRoot: string
  origins?: Record<string, string>
  environment: Record<string, string>
  onOutput: (text: string, stream: 'stdout' | 'stderr') => Promise<void>
  /** How many actions deep this is. The caller's step is zero. */
  depth?: number
  /** The chain that got here, so an action that uses itself is caught. */
  seen?: readonly string[]
}): Promise<{ ok: boolean, reason: string }> {
  const depth = Number(input.depth ?? 0)
  const seen = input.seen ?? []

  /*
   * A ceiling on nesting, and a cycle check, because both failures look
   * identical from outside - a job that never finishes - and neither is
   * something a workflow author can debug from a log that stops.
   *
   * Five is Actions' own limit. An action chain deeper than that is a design
   * nobody meant to write, and the refusal names the chain so it can be seen.
   */
  if (depth > MAX_ACTION_DEPTH) {
    const reason = `\`${input.uses}\` is ${depth} actions deep, and ${MAX_ACTION_DEPTH} is the limit: ${[...seen, input.uses].join(' → ')}`

    await input.onOutput(`${reason}\n`, 'stderr')

    return { ok: false, reason }
  }

  if (seen.includes(input.uses)) {
    const reason = `\`${input.uses}\` uses itself: ${[...seen, input.uses].join(' → ')}`

    await input.onOutput(`${reason}\n`, 'stderr')

    return { ok: false, reason }
  }

  const reference = parseActionRef(input.uses)
  const decision = checkPolicy(reference, input.policy)

  if (!decision.allowed) {
    await input.onOutput(`${decision.reason}\n`, 'stderr')

    return { ok: false, reason: decision.reason }
  }

  if (reference.kind === 'container') {
    const reason = `\`${input.uses}\` is a container action, which needs a container this runner does not have`

    await input.onOutput(`${reason}\n`, 'stderr')

    return { ok: false, reason }
  }

  /*
   * A remote action is fetched into a cache keyed by the commit it resolved
   * to, so the second job that uses it does no network at all.
   */
  let directory: string

  if (reference.kind === 'remote') {
    const fetched = await fetchAction(reference, {
      root: resolve(input.cacheRoot),
      origins: input.origins,
      // The same default the policy checked against, so a reference that passed
      // the policy for one host cannot be fetched from another.
      defaultHost: input.policy.defaultHost,
    })

    if (!fetched.ok || !fetched.path) {
      await input.onOutput(`${fetched.reason}\n`, 'stderr')

      return { ok: false, reason: fetched.reason }
    }

    await input.onOutput(
      `${fetched.cached ? 'Using cached' : 'Fetched'} ${reference.repository}@${String(fetched.sha).slice(0, 12)}\n`,
      'stdout',
    )

    directory = fetched.path
  }
  else {
    directory = join(input.workspace, String(reference.path))
  }
  const file = ['action.yml', 'action.yaml']
    .map(candidate => join(directory, candidate))
    .find(candidate => existsSync(candidate))

  if (!file) {
    const reason = `no \`action.yml\` at \`${reference.path}\``

    await input.onOutput(`${reason}\n`, 'stderr')

    return { ok: false, reason }
  }

  const definition = parseActionFile(read(file))

  if (definition.error) {
    await input.onOutput(`${definition.error}\n`, 'stderr')

    return { ok: false, reason: definition.error }
  }

  const supplied: Record<string, string> = {}

  for (const [name, value] of Object.entries(input.with ?? {}))
    supplied[name] = value === null || value === undefined ? '' : String(value)

  for (const missing of missingInputs(definition, supplied))
    await input.onOutput(`::warning::\`${missing}\` is a required input of this action and was not given\n`, 'stdout')

  const environment = {
    ...input.environment,
    ...inputEnvironment(definition, supplied),
    // Where the action's own files are, which is what an action reads to find
    // anything it ships alongside its entry point.
    GITHUB_ACTION_PATH: directory,
  }

  if (definition.kind === 'composite') {
    return runComposite(definition, input.workspace, environment, input.onOutput, {
      // What a nested `uses:` needs to resolve the way this one did.
      job: input.job,
      policy: input.policy,
      cacheRoot: input.cacheRoot,
      origins: input.origins,
      depth: depth + 1,
      seen: [...seen, input.uses],
    })
  }

  if (definition.kind === 'javascript')
    return runJavaScript(definition, directory, input.workspace, environment, input.onOutput)

  const reason = `\`${input.uses}\` is a ${definition.kind} action, which needs a container this runner does not have`

  await input.onOutput(`${reason}\n`, 'stderr')

  return { ok: false, reason }
}

/** How deep one action may reach through others. Actions' own limit. */
export const MAX_ACTION_DEPTH = 5

/** A composite action: its steps, in order, in the caller's workspace. */
async function runComposite(
  definition: ActionDefinition,
  workspace: string,
  environment: Record<string, string>,
  onOutput: (text: string, stream: 'stdout' | 'stderr') => Promise<void>,
  nesting: {
    job: any
    policy: ReturnType<typeof defaultPolicy>
    cacheRoot: string
    origins?: Record<string, string>
    depth: number
    seen: readonly string[]
  },
): Promise<{ ok: boolean, reason: string }> {
  /*
   * What an expression inside this action may read.
   *
   * `inputs` is the action's own, which is the whole reason a composite action
   * has expressions at all: `${{ inputs.who }}` in a step is how an input
   * reaches the thing the action wraps. Without evaluating them the value
   * arrives as the literal text `${{ inputs.who }}`, which is what happened -
   * the nested action greeted somebody called `${{ inputs.who }}`.
   */
  const context = {
    inputs: Object.fromEntries(
      Object.entries(environment)
        .filter(([key]) => key.startsWith('INPUT_'))
        .map(([key, value]) => [key.slice('INPUT_'.length).toLowerCase().replace(/_/g, '-'), value]),
    ),
    env: environment,
    github: { action_path: environment.GITHUB_ACTION_PATH ?? '' },
  }

  for (const [index, step] of definition.steps.entries()) {
    const name = step.name ?? step.run ?? step.uses ?? `step ${index + 1}`

    /*
     * A composite step that uses another action, which is how the ecosystem's
     * actions are actually written - `actions/setup-node` inside somebody's
     * `setup` action, and so on.
     *
     * Nested through the same path as any other `uses:`, which is what gets it
     * the policy check, the cache, the input mapping and the refusals for
     * free. The depth limit and cycle check live there, once.
     */
    if (step.uses) {
      await onOutput(`::group::${name}\n`, 'stdout')

      const nested = await runAction({
        uses: interpolate(step.uses, context),
        // Evaluated against this action's inputs, so a wrapper can pass its
        // own input down - which is most of what a wrapper is for.
        with: interpolateValues(step.with ?? {}, context),
        workspace,
        job: nesting.job,
        policy: nesting.policy,
        cacheRoot: nesting.cacheRoot,
        origins: nesting.origins,
        // The action's own inputs are in scope for what it calls, which is
        // what makes a wrapper action able to pass its input through.
        environment: { ...environment, ...step.env },
        onOutput,
        depth: nesting.depth,
        seen: nesting.seen,
      })

      await onOutput('::endgroup::\n', 'stdout')

      if (!nested.ok)
        return { ok: false, reason: `${name}: ${nested.reason}` }

      continue
    }

    if (!step.run)
      continue

    await onOutput(`::group::${name}\n`, 'stdout')

    const result = await runStep({
      command: interpolate(step.run, context),
      /*
       * A composite step's working directory defaults to the *workspace*, not
       * to the action's own directory. Actions is explicit about this and it
       * reads as wrong until you write one: an action's steps operate on the
       * repository that called them, and `GITHUB_ACTION_PATH` is how it reaches
       * its own files.
       */
      cwd: step.workingDirectory ? join(workspace, interpolate(step.workingDirectory, context)) : workspace,
      environment: { ...environment, ...interpolateValues(step.env ?? {}, context) },
      onOutput,
    })

    await onOutput('::endgroup::\n', 'stdout')

    if (!result.ok)
      return { ok: false, reason: `${name} exited ${result.exitCode}` }
  }

  return { ok: true, reason: 'every step of the action succeeded' }
}

/**
 * A JavaScript action: its entry point, run with the runtime this host has.
 *
 * Bun rather than node, and the log says so. An action written for `node20`
 * that depends on something Bun does not implement will fail in a way its
 * author can read, which is better than this runner refusing every JavaScript
 * action for not having a node binary it may well have.
 */
async function runJavaScript(
  definition: ActionDefinition,
  directory: string,
  workspace: string,
  environment: Record<string, string>,
  onOutput: (text: string, stream: 'stdout' | 'stderr') => Promise<void>,
): Promise<{ ok: boolean, reason: string }> {
  const entry = join(directory, String(definition.main))

  if (!existsSync(entry)) {
    const reason = `this action's \`main:\` names \`${definition.main}\`, which is not in the action's directory`

    await onOutput(`${reason}\n`, 'stderr')

    return { ok: false, reason }
  }

  await onOutput(`Running ${definition.main} with bun (the action asked for ${definition.runtime}).\n`, 'stdout')

  const result = await runStep({
    command: `bun ${JSON.stringify(entry)}`,
    cwd: workspace,
    environment,
    onOutput,
  })

  return result.ok
    ? { ok: true, reason: 'the action exited zero' }
    : { ok: false, reason: `the action exited ${result.exitCode}` }
}

/**
 * The files a step writes back through.
 *
 * One set per step rather than one per job: a step reading the previous step's
 * `GITHUB_OUTPUT` by accident is a bug that only appears when two steps write
 * the same key, which is the day nobody is looking.
 */
function stepFiles(workspace: string, index: number): {
  environment: Record<string, string>
  paths: { env: string, path: string, output: string, summary: string, state: string }
} {
  const directory = join(workspace, '.reviewos-runner')

  mkdirSync(directory, { recursive: true })

  const paths = {
    env: join(directory, `env-${index}`),
    path: join(directory, `path-${index}`),
    output: join(directory, `output-${index}`),
    summary: join(directory, `summary-${index}`),
    state: join(directory, `state-${index}`),
  }

  for (const file of Object.values(paths))
    writeFileSync(file, '')

  return {
    paths,
    environment: {
      GITHUB_ENV: paths.env,
      GITHUB_PATH: paths.path,
      GITHUB_OUTPUT: paths.output,
      GITHUB_STEP_SUMMARY: paths.summary,
      GITHUB_STATE: paths.state,
    },
  }
}

/** What a step wrote to its files, read after it exited. */
function readStepFiles(files: ReturnType<typeof stepFiles>): {
  environment: Record<string, string>
  path: string
  summary: string
  outputs: Record<string, string>
  masks: string[]
} {
  const environment = parseEnvFile(read(files.paths.env))
  const outputs = parseEnvFile(read(files.paths.output))

  return {
    environment,
    // Each line is a directory, and later steps look in the most recently added
    // first - which is what `GITHUB_PATH` means and the opposite of appending.
    path: read(files.paths.path).split('\n').map(line => line.trim()).filter(Boolean).reverse().join(':'),
    summary: read(files.paths.summary).trim(),
    // What the step wrote to `GITHUB_OUTPUT`, which is how `steps.<id>.outputs`
    // gets anything in it.
    outputs,
    /*
     * Nothing here is masked automatically. An output is not a secret - it is
     * usually a version number or a filename - and masking every one of them
     * would turn a log into asterisks. A step that produced something secret
     * says so with `::add-mask::`.
     */
    masks: Object.keys(outputs).length > 0 ? [] : [],
  }
}

function read(path: string): string {
  try {
    return readFileSync(path, 'utf8')
  }
  catch {
    return ''
  }
}

/**
 * `NAME=value` per line, and the heredoc form for values with newlines.
 *
 * The heredoc exists because a value containing a newline would otherwise be
 * indistinguishable from two variables, and a certificate or a multi-line
 * message is a perfectly ordinary thing to pass between steps.
 */
export function parseEnvFile(text: string): Record<string, string> {
  const values: Record<string, string> = {}
  const lines = text.split('\n')

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? ''

    if (!line.trim())
      continue

    const heredoc = /^([A-Z_][A-Z0-9_]*)<<(\S+)$/i.exec(line.trim())

    if (heredoc) {
      const [, name, marker] = heredoc
      const body: string[] = []

      index++

      while (index < lines.length && lines[index]?.trim() !== marker) {
        body.push(lines[index] ?? '')
        index++
      }

      values[String(name)] = body.join('\n')
      continue
    }

    const separator = line.indexOf('=')

    if (separator <= 0)
      continue

    values[line.slice(0, separator).trim()] = line.slice(separator + 1)
  }

  return values
}

/** Every value in a map, with its expressions filled in. */
function interpolateValues(values: Record<string, unknown>, context: Record<string, unknown>): Record<string, string> {
  const filled: Record<string, string> = {}

  for (const [name, value] of Object.entries(values ?? {}))
    filled[name] = interpolate(String(value ?? ''), context)

  return filled
}

/** Run one command, streaming its output as it arrives. */
async function runStep(input: {
  command: string
  cwd: string
  environment: Record<string, string>
  /** The step's own `timeout-minutes`, in milliseconds. The ceiling otherwise. */
  timeoutMs?: number
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

  let killed = false

  const timeout = setTimeout(() => {
    killed = true
    child.kill()
  }, input.timeoutMs ?? STEP_TIMEOUT_MS)

  try {
    await Promise.all([pump(child.stdout as any, 'stdout'), pump(child.stderr as any, 'stderr')])

    const exitCode = await child.exited

    if (killed) {
      /*
       * Said out loud, because a killed step exits with a signal and reads as
       * an ordinary failure otherwise - which sends somebody looking for the
       * bug in a command that was working fine and simply took too long.
       */
      await input.onOutput(
        `This step hit its ${Math.round((input.timeoutMs ?? STEP_TIMEOUT_MS) / 60_000)}-minute timeout and was stopped.\n`,
        'stderr',
      )
    }

    return { ok: !killed && exitCode === 0, exitCode }
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

async function report(
  baseUrl: string,
  jobToken: string,
  state: string,
  error: string,
  outputs?: Record<string, string>,
  exitStatus?: number | null,
): Promise<void> {
  // The outputs travel with the conclusion: a job that reported values and then
  // failed to report its result would leave them attached to a job nobody can
  // tell finished.
  await post(baseUrl, '/api/runner/report', jobToken, {
    state,
    error,
    outputs: outputs ?? null,
    exit_status: exitStatus ?? null,
  })
}

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

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { fetchAction } from './actionCache'
import { verifyWork } from '../Workflow/stepSignature'
import { checkPolicy, defaultPolicy, parseActionRef } from './actionRef'
import { containerCommand, containerRuntime } from './container'
import type { ActionDefinition } from './actionFile'
import { inputEnvironment, missingInputs, parseActionFile } from './actionFile'
import type { CheckoutOptions } from './checkout'
import { checkoutPlan } from './checkout'
import type { FleetStage, HookStage, InstalledPlugin, ResolvedHook } from './hooks'
import { fleetHook, hooksFor, repositoryHooksAllowed } from './hooks'
import { CommandReader } from './commands'
import { redactWithCount } from './redact'
import { restoreCache, saveCache } from './cacheClient'
import { keyFor, worthCaching } from './snapshot'
import { cacheActionMode, isCacheAction, requestFrom, restoreKeyed, saveKeyed } from './keyedCache'
import { ORCHESTRATE_ACTION } from '../Workflow/program'
import { drive } from './orchestrate'
import { httpTransport } from './orchestratorClient'
import type { ServiceRequest } from './services'
import { resolveServices, serviceEnvironment, waitForPort } from './services'
import { interpolate, shouldRun } from '../Workflow/expression'
import { isNotFalse, isTrue } from '../Support/sql'
import { LEASE_SECONDS } from './protocol'

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
   * Where this machine's own hooks live, outside repository control.
   *
   * An operator put them there, which is what makes `pre-bootstrap` a refusal a
   * repository cannot reach and `command` a wrapper it cannot remove. Absent
   * means a fleet with no hooks, which is every fleet until somebody needs one.
   */
  hooksDirectory?: string
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
  /*
   * `suspended` is a job that stopped without finishing, and it is not a
   * failure. A workflow program that sleeps hands its machine back; the control
   * plane holds the timer and requeues the job when it comes due. Reporting a
   * conclusion here would turn a workflow waiting for an approval into a red
   * cross on somebody's commit.
   */
  state: 'succeeded' | 'failed' | 'cancelled' | 'suspended'
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
/**
 * Check the claim's signature against a key this instance publishes.
 *
 * Fetched rather than taken from the claim, which is the whole of it: a
 * signature checked with a key from the same message proves only that the
 * sender can do arithmetic. The key set comes from a path an operator can curl,
 * over the same base URL the runner was configured with - so an attacker who
 * can rewrite that has already replaced the instance.
 */
export async function verifySignedWork(baseUrl: string, job: any): Promise<{ ok: boolean, reason: string }> {
  let keys: any[] = []

  try {
    const answer = await fetch(`${baseUrl.replace(/\/$/, '')}/.well-known/reviewos-step-keys.json`)
    const body: any = await answer.json()

    keys = Array.isArray(body?.keys) ? body.keys : []
  }
  catch (error) {
    /*
     * An unreachable key set is a refusal rather than a pass. The pool asked
     * for signed work; "I could not check" is not "it was fine", and the
     * failure mode of the other reading is a network somebody can arrange.
     */
    return { ok: false, reason: `its keys could not be fetched (${error instanceof Error ? error.message : String(error)})` }
  }

  return verifyWork({
    signature: job.signature ?? null,
    keys,
    work: {
      runId: Number(job.run?.id ?? 0),
      jobId: Number(job.id ?? 0),
      matrix: (job.matrix_values ?? null) as Record<string, unknown> | null,
      steps: (Array.isArray(job.steps) ? job.steps : []).map((step: Record<string, unknown>) => ({
        run: step.run ?? null,
        uses: step.uses ?? null,
        env: (step.env ?? null) as Record<string, string> | null,
        workingDirectory: step.working_directory ?? null,
      })),
    },
  })
}

/**
 * Write the plugins a claim carried into the workspace.
 *
 * Executable, because a hook that is not executable is not a hook - the
 * resolver on the other side would skip it silently, and the symptom would be
 * a plugin that appears to do nothing.
 */
export function installPlugins(workspace: string, job: any): InstalledPlugin[] {
  const plugins = Array.isArray(job?.plugins) ? job.plugins : []
  const installed: InstalledPlugin[] = []

  for (const plugin of plugins) {
    const name = String(plugin?.name ?? '').replace(/[^\w.-]+/g, '-')
    const hooks = plugin?.hooks && typeof plugin.hooks === 'object' ? plugin.hooks : {}

    if (!name || Object.keys(hooks).length === 0)
      continue

    const directory = join(workspace, '.reviewos-runner', 'plugins', name)

    try {
      mkdirSync(directory, { recursive: true })

      for (const [stage, script] of Object.entries(hooks as Record<string, string>))
        writeFileSync(join(directory, stage), String(script), { mode: 0o755 })

      installed.push({
        name,
        directory,
        environment: (plugin?.environment ?? {}) as Record<string, string>,
      })
    }
    catch {
      /*
       * A plugin that cannot be written is not silently skipped as a decision -
       * it is skipped because there is nothing to run, and the job's own
       * failure will follow from whatever the plugin was there to do. The
       * alternative, failing the job here, would take a fleet down over a full
       * disk in a way nobody could read.
       */
      continue
    }
  }

  return installed
}


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
  if (!isNotFalse(job.run?.trusted)) {
    const reason = 'The local runner does not execute untrusted runs. A fork\'s pull request needs an isolated runner.'

    say(`refusing job ${job.id}: ${reason}`)
    await append(options.baseUrl, jobToken, 1, `${reason}\n`, 'stderr')
    await report(options.baseUrl, jobToken, 'failed', reason)

    return { jobId: Number(job.id), state: 'failed', reason }
  }

  /*
   * A credential the instance could not deliver stops the job here.
   *
   * The claim resolves external secret references - a value this instance never
   * held, read from the store an organisation already runs - and a reference
   * that could not be read means the job would start without the credential it
   * asked for. Starting anyway is the expensive failure: forty minutes of build
   * and a push step that authenticates as nobody, with an error from somebody
   * else's API rather than from here.
   */
  const unavailable = Array.isArray(job.secrets_unavailable) ? job.secrets_unavailable : []

  if (unavailable.length > 0) {
    const named = unavailable
      .map((one: any) => `\`${String(one?.key ?? 'a secret')}\`: ${String(one?.reason ?? 'could not be read')}`)
      .join('; ')

    const reason = `This job asked for a credential this instance could not deliver - ${named}`

    say(`refusing job ${job.id}: ${reason}`)
    await append(options.baseUrl, jobToken, 1, `${reason}\n`, 'stderr')
    await report(options.baseUrl, jobToken, 'failed', reason)

    return { jobId: Number(job.id), state: 'failed', reason }
  }

  /*
   * Whether this instance signed the work, checked before anything of it runs.
   *
   * Only when the pool asks for it. A fleet that started refusing every job the
   * day it upgraded is a fleet nobody upgrades, and the flag travels with the
   * claim so an operator turning it on covers every machine in the pool rather
   * than the ones whose config somebody remembered to edit.
   *
   * Before the workspace, and before the first hook: the point of the signature
   * is that unverified work never reaches a shell, and a check made after the
   * `pre-bootstrap` hook has run is a check that already executed something.
   */
  if (isTrue(job.require_signed_steps)) {
    const verdict = await verifySignedWork(options.baseUrl, job)

    if (!verdict.ok) {
      const reason = `This pool only runs work signed by the instance, and ${verdict.reason}.`

      say(`refusing job ${job.id}: ${reason}`)
      await append(options.baseUrl, jobToken, 1, `${reason}\n`, 'stderr')
      await report(options.baseUrl, jobToken, 'failed', reason)

      return { jobId: Number(job.id), state: 'failed', reason }
    }
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

  /*
   * The job's plugins, written to disk before any hook runs.
   *
   * They arrive as scripts rather than as references, so the machine fetches
   * nothing: what ran is what the instance stored, at the commit it recorded,
   * and a runner that cannot reach a plugin's repository is not a thing that
   * can happen. Written under the workspace's own directory so a failed job
   * leaves them where an operator can read them.
   */
  const installed = installPlugins(workspace, job)

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

  /**
   * The timer that says "still here" while a step runs.
   *
   * Declared out here so the way out can stop it, whichever way out is taken:
   * a heartbeat landing after the conclusion is a machine claiming a job it has
   * finished with, and a timer nobody cleared is a runner still holding a
   * process open after its work ended.
   */
  let pulse: ReturnType<typeof setInterval> | null = null

  try {
    await send(`Running job ${job.key} of run ${job.run?.number} on this host.\n`)
    await send(`::group::Workspace\n${workspace}\n::endgroup::\n`)

    /*
     * `pre-bootstrap`, before anything of the repository's is on disk.
     *
     * The only moment a machine can decide whether to run this repository's
     * code without having already fetched it - which is why it is runner-scoped
     * only, and why a refusal here is a refusal rather than a failed step.
     */
    const bootstrap = await runHooks({
      stage: 'pre-bootstrap',
      job,
      workspace,
      environment: environmentFor(job, workspace),
      runnerDirectory: options.hooksDirectory,
      plugins: installed,
      say: send,
    })

    if (!bootstrap.ok) {
      await flush()
      await report(options.baseUrl, jobToken, 'failed', bootstrap.reason)
      say(`job ${job.id} refused: ${bootstrap.reason}`)

      return { jobId: Number(job.id), state: 'failed', reason: bootstrap.reason }
    }

    /*
     * Hook-exported environment, carried from here to the steps.
     *
     * `environment` runs before the checkout on purpose: a fleet that has to
     * set a proxy or a mirror needs it set *before* git runs, not after.
     */
    const hookEnvironment: Record<string, string> = {}

    for (const stage of ['environment', 'pre-checkout'] as const) {
      const outcome = await runHooks({
        stage,
        job,
        workspace,
        environment: { ...environmentFor(job, workspace), ...hookEnvironment },
        runnerDirectory: options.hooksDirectory,
        plugins: installed,
        say: send,
      })

      Object.assign(hookEnvironment, outcome.exported)

      if (!outcome.ok) {
        await flush()
        await report(options.baseUrl, jobToken, 'failed', outcome.reason)

        return { jobId: Number(job.id), state: 'failed', reason: outcome.reason }
      }
    }

    /*
     * A `checkout` hook replaces the built-in clone entirely - a fleet with a
     * local mirror, a cache server or a filesystem snapshot has its own way of
     * putting the code there, and the built-in one would only get in the way.
     */
    const ownCheckout = hooksFor({ stage: 'checkout', runnerDirectory: options.hooksDirectory })

    /*
     * The checkout, done by the runner rather than by a step.
     *
     * Actions leaves this to `actions/checkout`, and this runner does not
     * resolve actions - so a workflow copied from GitHub would run its steps
     * against an empty directory and fail in a way that reads like a broken
     * product. Checking out first is the difference between "your workflow
     * ran" and "your workflow ran in an empty room".
     */
    const checkout = ownCheckout.length > 0
      ? await (async () => {
          const outcome = await runHooks({
            stage: 'checkout',
            job,
            workspace,
            environment: { ...environmentFor(job, workspace), ...hookEnvironment },
            runnerDirectory: options.hooksDirectory,
            say: send,
          })

          Object.assign(hookEnvironment, outcome.exported)

          return { ok: outcome.ok, reason: outcome.ok ? 'checked out by a runner hook' : outcome.reason }
        })()
      : await checkoutCode({
          reposRoot: options.reposRoot ?? 'storage/repos',
          fullName: String(job.repository_full_name ?? ''),
          sha: String(job.run?.head_sha ?? ''),
          workspace,
          /*
           * Where to clone from when the bare repository is not on this
           * machine, which is every runner that is not the instance's own host.
           */
          baseUrl: options.baseUrl,
          cloneToken: options.cloneToken,
          // What the job asked for: a depth, sparse paths, submodules, LFS, or
          // no checkout at all.
          options: (job.checkout ?? undefined) as CheckoutOptions | undefined,
          /*
           * A hook may have written here already - the `environment` stage runs
           * before the checkout precisely so a fleet can set things up - and
           * `git clone` refuses a directory with anything in it.
           */
          empty: isEmptyDirectory(workspace),
          onOutput: (text, stream) => send(text, stream),
        })

    if (!checkout.ok) {
      await report(options.baseUrl, jobToken, 'failed', checkout.reason)
      say(`job ${job.id} failed: ${checkout.reason}`)

      return { jobId: Number(job.id), state: 'failed', reason: checkout.reason }
    }

    /*
     * The dependency cache, restored here: after the checkout, before the first
     * step.
     *
     * After, because the clone refuses a directory with anything in it and
     * because a snapshot is restored *over* the commit under test rather than
     * instead of it. Before the first step, because the step that would have
     * installed those dependencies is the one this is meant to make cheap.
     *
     * The key is derived from the workspace as it now stands - the lockfiles
     * the checkout just wrote, this machine's architecture, the runtime, the
     * image - so nobody maintains a key expression and a lockfile change
     * invalidates the cache on its own.
     *
     * Every failure here is survivable. A miss, an instance with caching off, a
     * network that dropped: the job installs the slow way, which is what it did
     * before any of this existed.
     */
    const cacheKey = worthCaching(workspace)
      ? keyFor(workspace, { runtime: `bun@${Bun.version}`, image: String((job as any)?.container_image ?? '') || null })
      : null

    let cacheWasExact = false

    if (cacheKey) {
      const restored = await restoreCache({
        baseUrl: options.baseUrl,
        jobToken,
        key: cacheKey,
        workspace,
        scratch: join(workspace, '.reviewos-runner'),
      })

      cacheWasExact = restored.exact

      /*
       * Said in the log, always, hit or miss.
       *
       * A build that is slow today and fast tomorrow with no explanation
       * anywhere is one people stop trusting, and "restored from
       * refs/heads/main" is the sentence somebody needs when a job behaves
       * differently on a branch than it did on the pull request.
       */
      await send(restored.restored
        ? `Restored dependencies from ${restored.scope}${restored.exact ? '' : ' (this branch has no snapshot of its own yet)'}\n`
        : `No dependency snapshot to restore: ${restored.reason}\n`)
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

    if (uploadPath) {
      writeSplitCommand(uploadPath, options.baseUrl, jobToken)
      writeMetaCommand(uploadPath, options.baseUrl, jobToken)
      writeDownloadCommand(uploadPath, options.baseUrl, jobToken)
      writeOidcCommand(uploadPath, options.baseUrl, jobToken)
    }

    /*
     * `post-checkout` and `pre-command`, now that the code is on disk and the
     * repository's own hooks exist to be found.
     */
    for (const stage of ['post-checkout', 'pre-command'] as const) {
      const outcome = await runHooks({
        stage,
        job,
        workspace,
        environment: { ...environmentFor(job, workspace), ...hookEnvironment },
        runnerDirectory: options.hooksDirectory,
        plugins: installed,
        say: send,
      })

      Object.assign(hookEnvironment, outcome.exported)

      if (!outcome.ok) {
        await flush()
        await report(options.baseUrl, jobToken, 'failed', outcome.reason)

        return { jobId: Number(job.id), state: 'failed', reason: outcome.reason }
      }
    }

    /*
     * A `command` hook replaces the steps entirely.
     *
     * The wrapper case: a fleet that runs every command inside a profiler, a
     * sandbox or a container does it here rather than by editing every
     * workflow in every repository. Runner-scoped only, for the obvious reason
     * - a repository that could replace the command would not be running its
     * own steps any more.
     */
    const ownCommand = hooksFor({ stage: 'command', runnerDirectory: options.hooksDirectory })

    const steps: any[] = ownCommand.length > 0 ? [] : (Array.isArray(job.steps) ? job.steps : [])
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
    /*
     * Seeded with what the hooks exported, so a fleet's `environment` hook
     * reaches the steps the same way one step reaches the next. It is the
     * bottom of the stack: a step that sets the same name wins, because the
     * repository's own file is more specific than the machine's default.
     */
    const carried: Record<string, string> = { ...hookEnvironment }
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

    /*
     * What each step did, collected as it goes and sent with the conclusion.
     *
     * Collected rather than written as it happens because nothing reads a
     * step's recorded result until its job is over - and a request per step
     * would be forty of them carrying a few hundred bytes each.
     */
    const timings: StepTiming[] = []

    /*
     * When the step before this one finished, so the gap can be attributed.
     *
     * Starts at the moment the steps began, which makes the first step's queue
     * time everything the runner did to get ready - the checkout, the cache
     * restore, the container pull. That time is real and somebody waited for
     * it; leaving it out of every number is how a job that takes nine minutes
     * reports four.
     */
    let previousFinishedAt = Date.now()

    /** Write down what one step did, whatever it did. */
    const timed = (index: number, startedAt: number, activeMs: number, state: string, exitCode: number | null, error: string | null = null) => {
      const finished = Date.now()

      timings.push({
        // The definition's own numbering, which `.entries()` made zero-based
        // when the workflow was stored and this loop follows exactly.
        position: index,
        state,
        exit_code: exitCode,
        started_at: new Date(startedAt).toISOString(),
        finished_at: new Date(finished).toISOString(),
        queued_ms: Math.max(0, startedAt - previousFinishedAt),
        active_ms: Math.max(0, Math.round(activeMs)),
        outputs: null,
        // One, until a step can retry itself. Stated all the same, because the
        // control plane records what it is told rather than counting reports.
        attempt: 1,
        error,
      })

      previousFinishedAt = finished
    }

    /*
     * How many of those results the control plane has.
     *
     * A step's result used to travel only with the conclusion, which is a
     * result a crash loses - and "the runner died at step nine" is precisely
     * the case restart-from-step is for. So each one goes up as it lands, on
     * the heartbeat that was being sent anyway, and the conclusion carries
     * whatever is left.
     */
    let sentThrough = 0

    /** Hand up whatever has finished since the last time, and renew the lease. */
    const handUpResults = async (): Promise<void> => {
      const pending = timings.slice(sentThrough)
      const answer = await beat(options.baseUrl, jobToken, pending).catch(() => ({ held: false, recorded: 0 }))

      /*
       * Only counted as sent when the answer came back. A lost answer means
       * sending them again, which the control plane is built to accept: every
       * field is stated rather than accumulated, so a second write of the same
       * result is the same row.
       */
      if (answer.held)
        sentThrough = timings.length
    }

    /*
     * And a heartbeat on a timer, for the step that takes longer than a lease.
     *
     * Without one, a job whose first step is a ten-minute build had its lease
     * lapse at sixty seconds, was swept back into the queue, and ran a second
     * time on another machine - while the first was still working. The runner
     * never said it was alive because nothing ever asked it to.
     */
    pulse = setInterval(() => { void handUpResults() }, Math.max(5000, (LEASE_SECONDS / 3) * 1000))

    for (const [index, step] of steps.entries()) {
      const name = String(step.name ?? step.run ?? step.uses ?? `step ${index + 1}`)
      const stepStartedAt = Date.now()

      /*
       * A step this restart is keeping the answer to.
       *
       * Not executed, and not reported either: its row already holds the
       * result, and writing over it with "this attempt did nothing" is exactly
       * the erasure the whole re-run design exists to avoid. Its outputs go
       * into the context all the same, because the steps that follow read
       * `steps.<id>.outputs` and cannot tell - or care - which attempt
       * produced them.
       */
      if (isTrue(step.reused)) {
        const kept = (step.outputs ?? {}) as Record<string, string>

        if (step.id)
          stepContext[String(step.id)] = { outputs: kept, outcome: 'success', conclusion: 'success' }

        await send(`::group::${name}\nKept from an earlier attempt: this restart begins later in the job.\n::endgroup::\n`)
        previousFinishedAt = Date.now()

        continue
      }

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

        // A skipped step is a step whose result is "it did not run", and a row
        // that says nothing is indistinguishable from one nobody reported.
        timed(index, stepStartedAt, 0, 'skipped', null, decision.reason)
        }

        await handUpResults()

        continue
      }

      /*
       * `actions/cache`, answered here rather than fetched and run.
       *
       * The real action talks to GitHub's cache service over an API this
       * instance does not implement, with a token it does not mint - so running
       * it would fail on a machine where caching already works, and a workflow
       * arriving from GitHub would conclude the feature is broken. Intercepting
       * is the same choice the checkout makes, and for the same reason: a
       * workflow copied from somewhere else should run rather than explain
       * itself.
       */
      /*
       * The workflow program itself, run here because here is where running
       * repository code is allowed.
       *
       * Named as an action rather than a shell line for two reasons: what has
       * to happen - load this file and drive it against the journal - is not
       * something a shell command can express, and making it one would make it
       * depend on what happens to be installed on the machine.
       */
      if (step.uses && String(step.uses) === ORCHESTRATE_ACTION) {
        await send(`::group::${name}\n`)

        const file = join(workspace, String((interpolateValues(step.with ?? {}, context) as any)?.workflow ?? ''))

        const outcome = await drive(file, httpTransport({ server: options.baseUrl, token: jobToken }))

        await send(`${outcome.reason} after ${outcome.calls} call${outcome.calls === 1 ? '' : 's'}\n`)
        await send('::endgroup::\n')

        if (outcome.state === 'failed') {
          failed = outcome.reason
          break
        }

        /*
         * Suspended is not a finished job and not a failed one.
         *
         * The control plane already moved this job to `sleeping` when it
         * answered the call, so there is nothing to report - and reporting a
         * conclusion would either be rejected or, worse, accepted and turn a
         * workflow waiting for an approval into a red cross.
         */
        if (outcome.state === 'suspended') {
          await flush()
          say(`job ${job.id} suspended: ${outcome.reason}`)

          return { jobId: Number(job.id), state: 'suspended', reason: outcome.reason }
        }

        continue
      }

      if (step.uses && isCacheAction(String(step.uses))) {
        await send(`::group::${name}\n`)

        const outcome = await runKeyedCache({
          mode: cacheActionMode(String(step.uses)),
          request: requestFrom(interpolateValues(step.with ?? {}, context) as Record<string, unknown>),
          baseUrl: options.baseUrl,
          jobToken,
          workspace,
          send,
        })

        if (step.id) {
          stepContext[String(step.id)] = {
            // The output real workflows read: `if: steps.cache.outputs.cache-hit
            // != 'true'` is how half of them skip their install.
            outputs: { 'cache-hit': outcome.hit ? 'true' : 'false' },
            outcome: 'success',
            conclusion: 'success',
          }
        }

        await send('::endgroup::\n')

        continue
      }

      if (step.uses) {
        await send(`::group::${name}\n`)

        /*
         * An action gets the same files a `run:` step gets, and until now it
         * did not - which meant `GITHUB_OUTPUT` was absent from every action's
         * environment and no action could set an output at all. Nothing failed:
         * the action wrote to a path that was not there or to nothing, and the
         * step after it read an empty value, which is the shape of bug that
         * reads as "that action is broken on this forge".
         */
        const actionFiles = stepFiles(workspace, index)

        const result = await runAction({
          uses: String(step.uses),
          with: interpolateValues(step.with ?? {}, context),
          workspace,
          job,
          policy: options.policy ?? defaultPolicy(),
          cacheRoot: options.actionCacheRoot ?? 'storage/framework/runtime/actions',
          origins: options.actionOrigins,
          environment: {
            ...environmentFor(job, workspace),
            ...serviceEnv,
            ...carried,
            ...actionFiles.environment,
            ...interpolateValues(step.env ?? {}, context),
          },
          onOutput: (text, stream) => send(text, stream),
        })

        await flush()

        // Whatever it wrote through those files, applied the same way a
        // `run:` step's writes are: outputs to the steps after it, environment
        // and path carried, masks added to the reader, summary kept.
        const wrote = readStepFiles(actionFiles)

        Object.assign(carried, wrote.environment)

        if (step.id) {
          stepContext[String(step.id)] = {
            outputs: wrote.outputs,
            outcome: result.ok ? 'success' : 'failure',
            conclusion: result.ok || step.continue_on_error ? 'success' : 'failure',
          }
        }

        if (wrote.path)
          extraPath = extraPath ? `${wrote.path}:${extraPath}` : wrote.path

        if (wrote.summary)
          summary.push(wrote.summary)

        for (const value of wrote.masks)
          reader.addMask(value)

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

      const commandStartedAt = Date.now()

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

      /*
       * Timed around the command rather than around the iteration.
       *
       * `active_ms` is the command's own duration; everything else this
       * iteration did - interpolating the environment, opening the group,
       * reading the step's files afterwards - lands in the wall time, where it
       * belongs. A step whose command took two seconds inside a forty-second
       * iteration is a setup problem, and collapsing the two would hide it.
       */
      timed(
        index,
        stepStartedAt,
        Date.now() - commandStartedAt,
        result.ok ? 'succeeded' : (step.continue_on_error ? 'succeeded' : 'failed'),
        Number.isFinite(Number(result.exitCode)) ? Number(result.exitCode) : null,
      )

      const recorded = timings[timings.length - 1]

      if (recorded && Object.keys(written.outputs).length > 0)
        recorded.outputs = written.outputs

      if (recorded && !result.ok)
        recorded.error = `${name} exited ${result.exitCode}`

      /*
       * Up it goes, before the next step starts.
       *
       * This is what "durable" means for a step: the row says what happened the
       * moment it happened, so a machine that dies during step nine leaves a
       * run somebody can restart at step nine rather than one that looks as
       * though it never began.
       */
      await handUpResults()

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

    if (ownCommand.length > 0) {
      const outcome = await runHooks({
        stage: 'command',
        job,
        workspace,
        environment: { ...environmentFor(job, workspace), ...hookEnvironment },
        runnerDirectory: options.hooksDirectory,
        plugins: installed,
        say: send,
      })

      Object.assign(hookEnvironment, outcome.exported)

      if (!outcome.ok) {
        failed = outcome.reason
        jobFailed = true
      }
    }

    // `post-command` runs whether the steps passed or failed: it is where a
    // fleet collects a profile or tears down what `pre-command` set up.
    const afterCommand = await runHooks({
      stage: 'post-command',
      job,
      workspace,
      environment: { ...environmentFor(job, workspace), ...hookEnvironment },
      runnerDirectory: options.hooksDirectory,
      plugins: installed,
      say: send,
    })

    if (!afterCommand.ok && !failed)
      failed = afterCommand.reason

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

    /*
     * A value a step called sensitive does not leave in an output.
     *
     * `::add-mask::` is the only way a step says "this is secret", and until
     * now it meant "hide this in the log" - which is the smaller half. An
     * output travels further than a log line does: it is stored, and it is put
     * into the environment of every job that declares `needs` on this one. A
     * masked value reaching one of those has been un-masked by the trip.
     *
     * Said out loud rather than done quietly. An output that arrives as the
     * marker is one somebody will come asking about, and the answer belongs in
     * the log of the job that produced it, not in a support thread.
     */
    for (const [name, value] of Object.entries(resolvedOutputs)) {
      const hidden = redactWithCount(value, reader.maskedValues())

      if (hidden.count === 0)
        continue

      resolvedOutputs[name] = hidden.text
      await send(`output "${name}" carried a masked value, so it leaves this runner redacted\n`, 'stderr')
    }

    await flush()

    /*
     * What the job asked to have kept, collected on the way out.
     *
     * Before the conclusion for the same reason the annotations are: reporting
     * the conclusion is what makes a run terminal, and an artifact that lands
     * after its run finished is one somebody has already given up looking for.
     * Pass or fail - the failing run is the one with the screenshot in it.
     */
    for (const stage of ['pre-artifact'] as const) {
      const outcome = await runHooks({
        stage,
        job,
        workspace,
        environment: { ...environmentFor(job, workspace), ...hookEnvironment },
        runnerDirectory: options.hooksDirectory,
        plugins: installed,
        say: send,
      })

      if (!outcome.ok && !failed)
        failed = outcome.reason
    }

    await publishArtifacts({ job, workspace, baseUrl: options.baseUrl, jobToken, say: send })

    /*
     * `post-artifact`, then `pre-exit` - which runs whatever happened, and is
     * therefore where a machine unmounts a cache or stops a container it
     * started. A failure in either is recorded but does not overwrite a real
     * failure the job already had.
     */
    for (const stage of ['post-artifact', 'pre-exit'] as const) {
      const outcome = await runHooks({
        stage,
        job,
        workspace,
        environment: { ...environmentFor(job, workspace), ...hookEnvironment },
        runnerDirectory: options.hooksDirectory,
        plugins: installed,
        say: send,
      })

      if (!outcome.ok && !failed)
        failed = outcome.reason
    }

    // Flushed again, because what the collection said about itself - a glob
    // that matched nothing, an upload that was refused - is written through the
    // same buffer as the job's own output.
    await flush()

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

    /*
     * Read after the artifact and exit hooks, not before them.
     *
     * A `pre-exit` hook that fails has failed the job, and computing the
     * conclusion earlier would report success for a machine that could not tear
     * down what it set up - which is the one thing that hook exists for.
     */
    const state = failed ? 'failed' : 'succeeded'

    /*
     * The snapshot, saved before the conclusion and only on the way out.
     *
     * Three conditions, each of them load bearing:
     *
     * - **the job succeeded.** A workspace from a failed job is a half-finished
     *   install as often as a finished one, and caching it would hand the next
     *   run the state that broke this one.
     * - **the restore was not exact.** An exact hit means this scope already
     *   has this key: re-packing a gigabyte to store what is already stored is
     *   an upload spent to reach the state it is in.
     * - **there was a key at all**, which means the workspace had a lockfile.
     *
     * Before the conclusion because reporting it is what makes a run terminal,
     * and a snapshot that lands after its run finished is one the next run had
     * already given up waiting for.
     */
    if (cacheKey && !cacheWasExact && !failed) {
      const saved = await saveCache({
        baseUrl: options.baseUrl,
        jobToken,
        key: cacheKey,
        workspace,
        scratch: join(workspace, '.reviewos-runner'),
      })

      await send(saved.saved
        ? `Saved a dependency snapshot (${Math.round(Number(saved.sizeBytes ?? 0) / 1024)} KiB) for the runs after this one\n`
        : `No dependency snapshot saved: ${saved.reason}\n`)

      await flush()
    }

    /*
     * Stop saying "still here" before saying "done".
     *
     * A heartbeat that lands after the conclusion is a machine claiming a job
     * it has finished with, and the control plane cleared the lease when it
     * recorded the result.
     */
    stopPulse()

    /*
     * Whatever the heartbeats did not carry, which on a job that ran normally
     * is the last step and nothing else. Sent again rather than assumed
     * delivered when an answer was lost: every field a step reports is stated
     * rather than accumulated, so the second write of a result is the same row.
     */
    await report(options.baseUrl, jobToken, state, failed ?? '', resolvedOutputs, failedStatus, timings.slice(sentThrough))
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

    stopPulse()

    await report(options.baseUrl, jobToken, 'failed', reason).catch(() => {})
    say(`job ${job.id} failed: ${reason}`)

    return { jobId: Number(job.id), state: 'failed', reason }
  }
  finally {
    stopPulse()

    if (!options.workspaceRoot)
      rmSync(workspace, { recursive: true, force: true })
  }

  /** Stop the heartbeat timer, whichever way this job ended. */
  function stopPulse(): void {
    if (pulse === null)
      return

    clearInterval(pulse)
    pulse = null
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

  /*
   * The machine's own lifecycle, either side of the loop.
   *
   * `runner-startup` is where a fleet warms a cache, mounts a volume or
   * registers itself with something; `runner-shutdown` is where it puts all of
   * that back. Neither can fail a job, because neither belongs to one - a
   * failing startup hook is said out loud and the machine still takes work,
   * which is the honest behaviour for a hook whose author is the operator
   * watching the log.
   */
  await runFleetHook('runner-startup', options)

  try {
    return await pollForJobs()
  }
  finally {
    await runFleetHook('runner-shutdown', options)
  }

  async function pollForJobs(): Promise<JobOutcome[]> {
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
}

/**
 * One of the machine's own lifecycle hooks.
 *
 * It gets no job and no workspace, because there is neither: it runs in the
 * runner's own working directory, before any work has been claimed or after all
 * of it is done. A failure is reported to the operator's log and changes
 * nothing else - there is no job to fail.
 */
async function runFleetHook(stage: FleetStage, options: LocalRunnerOptions): Promise<void> {
  const hook = fleetHook(options.hooksDirectory, stage)

  if (!hook)
    return

  const result = await runStep({
    command: JSON.stringify(hook.path),
    cwd: options.workspaceRoot ?? process.cwd(),
    environment: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: process.env.HOME ?? '',
      REVIEWOS: 'true',
      REVIEWOS_HOOK: stage,
      REVIEWOS_HOOK_SCOPE: 'runner',
      REVIEWOS_SERVER_URL: options.baseUrl,
    },
    onOutput: async (text) => {
      options.say?.(text.replace(/\n$/, ''))
    },
  })

  if (!result.ok)
    options.say?.(`the ${stage} hook failed (exited ${result.exitCode})`)
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
    /*
     * What the event touched, so a step's condition can ask.
     *
     * `if: contains(github.changed_files, 'migrations/')` is the shape people
     * want, and it is a *declared* value rather than access to control-plane
     * state: the list was computed at dispatch and handed over with the job,
     * so a condition cannot reach anything the claim did not already give it.
     *
     * The flag beside it is not decoration. A very large push is cut, and a
     * condition answering "no, that did not change" out of a cut list is the
     * failure this exists to make visible.
     */
    changed_files: Array.isArray(run.changed_files) ? run.changed_files : [],
    changed_files_truncated: run.changed_files_truncated === true,
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
    /*
     * `strategy`, as the control plane resolved it: `fail-fast`,
     * `max-parallel`, and which of a matrix's jobs this is.
     *
     * Sent rather than worked out here, because a runner holds one job and
     * `job-index` is a fact about the run - a machine counting its own
     * combination would be guessing at what the other machines got.
     */
    strategy: (job?.strategy as any) ?? {},
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
      .filter((one: Record<string, unknown>) => one && typeof one === 'object' && one.image)
      .map((one: Record<string, unknown>) => ({
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
 * `reviewos-oidc`, for a short-lived identity token.
 *
 *     aws sts assume-role-with-web-identity \
 *       --web-identity-token "$(reviewos-oidc sts.amazonaws.com)" ...
 *
 * The whole point is that nothing long-lived is stored anywhere: the token is
 * minted when the step asks, lasts fifteen minutes, and names the repository
 * and ref that asked for it.
 */
export function writeOidcCommand(directory: string, baseUrl: string, jobToken: string): void {
  try {
    const path = join(directory, 'reviewos-oidc')

    writeFileSync(path, `#!/bin/sh
# A short-lived identity token. Usage: reviewos-oidc [audience]
set -e
audience="\${1:-}"
body=$(${JSON.stringify(process.execPath)} -e 'process.stdout.write(JSON.stringify({ audience: process.argv[1] || undefined }))' "$audience")
answer=$(curl -sS --fail-with-body -X POST ${JSON.stringify(`${baseUrl.replace(/\/$/, '')}/api/runner/oidc`)} \
  -H "Authorization: Bearer ${jobToken}" \
  -H 'Content-Type: application/json' \
  -H 'X-Runner-Protocol: 1' \
  --data-binary "$body")
# The token alone, so it can be substituted straight into a command. Anything
# else here would end up in somebody's shell history around a credential.
printf '%s' "$answer" | ${JSON.stringify(process.execPath)} -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{process.stdout.write(JSON.parse(d)?.value ?? "")}catch{process.stdout.write("")}})'
`)

    chmodSync(path, 0o700)
  }
  catch {
    // A workspace this cannot write to is one where the job still runs.
  }
}

/**
 * `reviewos-download`, for an artifact an earlier job in this run produced.
 *
 * The other half of `reviewos-upload`, and the reason most artifacts exist: a
 * build produces a binary and a deploy needs it. Writes the file to the name it
 * was stored under, or to a path the step names.
 *
 *     reviewos-download out-report.txt
 *     reviewos-download out-report.txt ./report.txt
 */
export function writeDownloadCommand(directory: string, baseUrl: string, jobToken: string): void {
  try {
    const path = join(directory, 'reviewos-download')

    writeFileSync(path, `#!/bin/sh
# An artifact from earlier in this run. Usage: reviewos-download NAME [path]
set -e
name="\${1:?a name is required}"
out="\${2:-$name}"
body=$(${JSON.stringify(process.execPath)} -e 'process.stdout.write(JSON.stringify({ name: process.argv[1] }))' "$name")
# Fails on an error status rather than writing the JSON error into the file a
# step is about to read as a binary.
curl -sS --fail-with-body -X POST ${JSON.stringify(`${baseUrl.replace(/\/$/, '')}/api/runner/artifacts/fetch`)} \
  -H "Authorization: Bearer ${jobToken}" \
  -H 'Content-Type: application/json' \
  -H 'X-Runner-Protocol: 1' \
  --data-binary "$body" \
  -o "$out"
`)

    chmodSync(path, 0o700)
  }
  catch {
    // A workspace this cannot write to is one where the job still runs.
  }
}

/**
 * `reviewos-meta`, for reading and writing the run's shared values.
 *
 * A helper on the PATH rather than a documented curl, for the same reason
 * `reviewos-upload` is one: the endpoint is three headers and a JSON body, and
 * a step that has to get those right to hand a version number to the next job
 * will use an artifact instead.
 *
 *     reviewos-meta set version 1.4.2
 *     reviewos-meta get version
 *
 * The token is written into the script rather than into the environment, so a
 * step that prints its own environment does not print it.
 */
export function writeMetaCommand(directory: string, baseUrl: string, jobToken: string): void {
  try {
    const path = join(directory, 'reviewos-meta')

    writeFileSync(path, `#!/bin/sh
# The run's shared values. Usage: reviewos-meta get KEY | set KEY VALUE | list
set -e
action="\${1:-list}"
key="\${2:-}"
value="\${3:-}"
body=$(${JSON.stringify(process.execPath)} -e 'process.stdout.write(JSON.stringify({ action: process.argv[1], key: process.argv[2], value: process.argv[3] }))' "$action" "$key" "$value")
answer=$(curl -sS -X POST ${JSON.stringify(`${baseUrl.replace(/\/$/, '')}/api/runner/metadata`)} \
  -H "Authorization: Bearer ${jobToken}" \
  -H 'Content-Type: application/json' \
  -H 'X-Runner-Protocol: 1' \
  --data-binary "$body")
# The value alone for a get, so \`v=$(reviewos-meta get version)\` works; the
# whole answer otherwise, because a set that was refused has to be readable.
if [ "$action" = "get" ]; then
  printf '%s' "$answer" | ${JSON.stringify(process.execPath)} -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{process.stdout.write(JSON.parse(d)?.entry?.value ?? "")}catch{process.stdout.write("")}})'
else
  printf '%s' "$answer"
fi
`)

    chmodSync(path, 0o700)
  }
  catch {
    // A workspace this cannot write to is one where the job still runs. The
    // helper is a convenience over an endpoint that is still there.
  }
}

/** The most files one job publishes automatically. Past this, say so and stop. */
export const MAX_COLLECTED_FILES = 200

/**
 * What matched the job's `artifact-paths:`, relative to the workspace.
 *
 * Sorted, so two runs of the same job upload the same files in the same order
 * and a person comparing two runs is comparing lists rather than orderings.
 * Directories are skipped: an artifact is a file, and a glob like `coverage/**`
 * matches the directory as well as what is in it.
 *
 * Exported for the tests, because the interesting behaviour here - a glob that
 * matches nothing, a list past the ceiling, a path that resolves outside the
 * workspace after globbing - is all in the matching rather than in the upload.
 */
export async function collectArtifacts(workspace: string, globs: readonly string[]): Promise<string[]> {
  const found = new Set<string>()

  for (const glob of globs) {
    try {
      for await (const match of new Bun.Glob(glob).scan({ cwd: workspace, onlyFiles: true, dot: false })) {
        /*
         * Checked again after globbing, not only at parse time. A symlink
         * inside the checkout can point anywhere, and `coverage/**` matching a
         * link to `/etc/shadow` would publish it to a repository page.
         */
        const full = resolve(workspace, match)

        if (full.startsWith(resolve(workspace) + '/'))
          found.add(match)
      }
    }
    catch {
      // A malformed glob collects nothing rather than failing the job. The
      // build already happened; refusing to report it over a pattern would
      // throw away the result somebody was waiting for.
      continue
    }
  }

  return [...found].sort().slice(0, MAX_COLLECTED_FILES)
}

/**
 * Upload what the job left behind, whether it passed or failed.
 *
 * **Failure is the case this exists for.** A step that uploads its own output
 * has to be written `if: always()`, and the run where somebody forgot is always
 * the run with the screenshot in it. So this happens after the steps, before
 * the conclusion, on both paths.
 *
 * Nothing here can fail the job. The work is done and reported either way; an
 * upload that 413s or a disk that vanished is worth a line in the log, not a
 * red build for a build that was green.
 */
async function publishArtifacts(input: {
  job: any
  workspace: string
  baseUrl: string
  jobToken: string
  say: (line: string) => Promise<void>
}): Promise<void> {
  const globs = Array.isArray(input.job?.artifact_paths) ? input.job.artifact_paths.map(String) : []

  if (globs.length === 0)
    return

  const files = await collectArtifacts(input.workspace, globs)

  if (files.length === 0) {
    // Said out loud. A glob that matches nothing is usually a typo or a build
    // that wrote somewhere else, and silence makes it look like the feature is
    // not wired up.
    await input.say(`no files matched artifact-paths: ${globs.join(', ')}\n`)
    return
  }

  for (const file of files) {
    try {
      const bytes = readFileSync(join(input.workspace, file))

      const answer = await fetch(`${input.baseUrl.replace(/\/$/, '')}/api/runner/artifacts`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${input.jobToken}`,
          'Content-Type': 'application/octet-stream',
          'X-Runner-Protocol': '1',
          /*
           * The path inside the workspace, not the basename. The store flattens
           * a name's separators, so `out/report.txt` is stored as
           * `out-report.txt` - which keeps two files called `report.xml` in two
           * directories apart, where sending the basename would make the second
           * one a name collision the endpoint refuses.
           */
          'X-Artifact-Name': file,
        },
        body: bytes,
      })

      if (!answer.ok)
        await input.say(`could not publish ${file}: ${answer.status}\n`)
    }
    catch (error) {
      await input.say(`could not publish ${file}: ${error instanceof Error ? error.message : String(error)}\n`)
    }
  }
}

/** Whether nothing has been written into the workspace yet. */
function isEmptyDirectory(path: string): boolean {
  try {
    return readdirSync(path).length === 0
  }
  catch {
    // Unreadable means treat it as occupied: the fetch shape works either way,
    // and the clone shape does not.
    return false
  }
}

/** Where a repository keeps its own hooks, inside the checkout. */
export const REPOSITORY_HOOKS = '.reviewos/hooks'

export interface HookOutcome {
  /** Whether every hook that ran succeeded. */
  ok: boolean
  /** Which hooks ran, for the log and for the tests. */
  ran: ResolvedHook[]
  /** The first failure, in the words the job's log gets. */
  reason: string
  /** Environment variables the hooks exported, for the steps that follow. */
  exported: Record<string, string>
}

/**
 * Run one stage's hooks, in scope order.
 *
 * **A hook failing fails the job.** That is the whole reason to have them: a
 * fleet that must inject a proxy or refuse untrusted work is a fleet where the
 * hook not working means the job must not run either. Continuing past a failed
 * hook would make the guarantee "usually".
 *
 * Anything a hook writes to `$REVIEWOS_ENV` is read back and carried into the
 * steps, the same channel `GITHUB_ENV` gives a step. It is how `environment`
 * earns its name: a hook that exports a proxy setting for the job has nowhere
 * else to put it.
 */
async function runHooks(input: {
  stage: HookStage
  job: any
  workspace: string
  environment: Record<string, string>
  runnerDirectory?: string | null
  plugins?: readonly InstalledPlugin[]
  say: (text: string, stream?: 'stdout' | 'stderr') => Promise<void>
}): Promise<HookOutcome> {
  /*
   * A fork's hooks are not run at all. This runner refuses untrusted runs
   * outright, so this is a second line - and it is here so that the day the
   * first is relaxed for a sandboxed runner, this is not relaxed with it.
   */
  const repositoryDirectory = repositoryHooksAllowed(input.job)
    ? join(input.workspace, REPOSITORY_HOOKS)
    : null

  const hooks = hooksFor({
    stage: input.stage,
    runnerDirectory: input.runnerDirectory,
    repositoryDirectory,
    plugins: input.plugins,
  })

  const outcome: HookOutcome = { ok: true, ran: [], reason: '', exported: {} }

  for (const hook of hooks) {
    const envFile = join(input.workspace, '.reviewos-runner', `hook-env-${input.stage}-${hook.scope}${hook.plugin ? `-${hook.plugin}` : ''}`)

    /*
     * The directory has to exist before the hook runs, not after.
     *
     * `environment` is the first stage and it runs before the checkout, which
     * is what creates the rest of the workspace - so a hook appending to
     * `$REVIEWOS_ENV` was failing on a directory that did not exist yet, and
     * reporting it as the hook's own failure.
     */
    try {
      mkdirSync(join(input.workspace, '.reviewos-runner'), { recursive: true })
    }
    catch { /* the hook will fail on its own terms, and say so */ }

    await input.say(`::group::Hook ${input.stage} (${hook.plugin ? `plugin ${hook.plugin}` : hook.scope})\n`)

    const result = await runStep({
      command: `${JSON.stringify(hook.path)}`,
      cwd: input.workspace,
      environment: {
        ...input.environment,
        ...outcome.exported,
        // A plugin's own parameters, last, so a plugin reads what it was given
        // rather than what the job happened to have a variable for.
        ...(hook.environment ?? {}),
        REVIEWOS_HOOK: input.stage,
        REVIEWOS_HOOK_SCOPE: hook.scope,
        REVIEWOS_ENV: envFile,
      },
      onOutput: (text, stream) => input.say(text, stream),
    })

    await input.say('::endgroup::\n')

    Object.assign(outcome.exported, readEnvFile(envFile))
    outcome.ran.push(hook)

    if (!result.ok) {
      outcome.ok = false
      // Named down to the scope, because "a hook failed" sends an operator to
      // read the repository's hooks when the failure was the machine's own.
      outcome.reason = hook.plugin
        ? `The \`${hook.plugin}\` plugin's \`${input.stage}\` hook failed (exited ${result.exitCode}).`
        : `The ${hook.scope} \`${input.stage}\` hook failed (exited ${result.exitCode}).`

      return outcome
    }
  }

  return outcome
}

/** What a hook exported, out of the file it was given. */
function readEnvFile(path: string): Record<string, string> {
  try {
    if (!existsSync(path))
      return {}

    const values = parseEnvFile(readFileSync(path, 'utf8'))

    rmSync(path, { force: true })

    return values
  }
  catch {
    return {}
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
    /*
     * The id of the API request that started this run, when one did.
     *
     * Empty otherwise, and empty rather than absent for the same reason
     * `BASE_REF` is: a script that tests for it should get one answer, not two
     * that look alike. A job that echoes this makes its own log searchable from
     * the caller's side, which is the entire point of keeping the id they sent.
     */
    REQUEST_ID: String(job?.request_id ?? ''),
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
  /** What the workflow asked for, when it asked. */
  options?: CheckoutOptions
  /** False when a hook has already written into the workspace. */
  empty?: boolean
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

  const plan = checkoutPlan({ source, sha: input.sha, onHost, empty: input.empty, options: input.options })

  if (plan.commands.length === 0) {
    // A job that asked for no code at all - one that calls an API, or unblocks
    // something. Said out loud, because an empty workspace with no explanation
    // is the first thing somebody blames when a step cannot find a file.
    await input.onOutput(`::group::Checkout\nskipped: the workflow asked for no checkout\n::endgroup::\n`, 'stdout')

    return { ok: true, reason: 'no checkout was asked for' }
  }

  await input.onOutput(`::group::Checkout\n${input.fullName} at ${input.sha.slice(0, 8)} (${plan.summary})\n`, 'stdout')

  const clone = await runStep({
    // Joined with `&&`: each step of a checkout depends on the one before it,
    // and a sparse-checkout that failed followed by a fetch that succeeded is a
    // build against the wrong tree with a green checkout above it.
    command: plan.commands.join(' && '),
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
    /*
     * `uses: docker://image` has no `action.yml` to read: the image *is* the
     * action. So the inputs go in as `INPUT_*` the same way, and `args` and
     * `entrypoint` mean what they mean to a container rather than being inputs
     * of anything - which is what Actions does with them too.
     */
    const supplied: Record<string, string> = {}

    for (const [name, value] of Object.entries(input.with ?? {})) {
      if (name === 'args' || name === 'entrypoint')
        continue

      supplied[`INPUT_${name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`] = value === null || value === undefined ? '' : String(value)
    }

    return runContainer({
      image: String(reference.image ?? ''),
      uses: input.uses,
      workspace: input.workspace,
      environment: { ...input.environment, ...supplied },
      entrypoint: input.with?.entrypoint === undefined ? null : String(input.with.entrypoint),
      args: input.with?.args === undefined ? null : String(input.with.args),
      onOutput: input.onOutput,
    })
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

  if (definition.kind === 'docker') {
    const image = String(definition.image ?? '')

    /*
     * A pre-built image runs; a `Dockerfile` does not.
     *
     * Building one would mean this runner is a build host for arbitrary images
     * from a repository it is running the workflow of - a bigger decision than
     * "may containers run here", with its own cache, its own disk budget and
     * its own supply chain. Refused by name so the workflow author knows to
     * publish the image rather than wondering why nothing happened.
     */
    if (!image || !image.startsWith('docker://')) {
      const reason = `this action builds its image from \`${image || 'a Dockerfile'}\`, and this runner runs published images only. Publish it and reference it as \`docker://\`.`

      await input.onOutput(`${reason}\n`, 'stderr')

      return { ok: false, reason }
    }

    return runContainer({
      image: image.slice('docker://'.length),
      uses: input.uses,
      workspace: input.workspace,
      environment,
      entrypoint: definition.entrypoint ?? null,
      // The action's own `args:`, with the caller's inputs already substituted
      // into the environment above - an action.yml's args reference them as
      // `${{ inputs.x }}`, which the definition resolved.
      args: definition.args ?? null,
      onOutput: input.onOutput,
    })
  }

  const reason = `\`${input.uses}\` is a ${definition.kind} action, which needs a container this runner does not have`

  await input.onOutput(`${reason}\n`, 'stderr')

  return { ok: false, reason }
}

/**
 * One container run: find a runtime, build the argv, stream what it printed.
 *
 * The refusal when there is no runtime is not a fallback - there is nothing to
 * fall back to. Running an image's entry point on the host would be the exact
 * opposite of what the image was for, and quietly skipping the step would make
 * a job pass without doing the thing it exists to do.
 */
async function runContainer(input: {
  image: string
  uses: string
  workspace: string
  environment: Record<string, string>
  entrypoint: string | null
  args: string | null
  onOutput: (text: string, stream: 'stdout' | 'stderr') => Promise<void>
}): Promise<{ ok: boolean, reason: string }> {
  if (!input.image) {
    const reason = `\`${input.uses}\` names no image`

    await input.onOutput(`${reason}\n`, 'stderr')

    return { ok: false, reason }
  }

  const runtime = await containerRuntime()

  if (!runtime) {
    const reason = `\`${input.uses}\` is a container action, and this runner has no container runtime: install docker or podman, or set REVIEWOS_CONTAINER_RUNTIME to the one it should use`

    await input.onOutput(`${reason}\n`, 'stderr')

    return { ok: false, reason }
  }

  const argv = containerCommand(runtime, {
    image: input.image,
    workspace: input.workspace,
    environment: input.environment,
    entrypoint: input.entrypoint,
    args: input.args,
  })

  // Said before it runs, because pulling an image somebody has not cached is
  // minutes of a log saying nothing, and "which image is this" is the first
  // question about a container step that behaves oddly.
  await input.onOutput(`Running ${input.image} with ${runtime}.\n`, 'stdout')

  const result = await runStep({
    argv,
    cwd: input.workspace,
    // The container's environment is passed with `--env`, so the runtime itself
    // needs only enough to find its own socket and configuration.
    environment: process.env as Record<string, string>,
    onOutput: input.onOutput,
  })

  return result.ok
    ? { ok: true, reason: 'the container exited zero' }
    : { ok: false, reason: `the container exited ${result.exitCode}` }
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
  /** A shell command, for a `run:` step. */
  command?: string
  /**
   * An argv, executed directly.
   *
   * For a container run, where the values - an image, an argument, an
   * environment value - come off a workflow file anybody who can push may edit.
   * There is no shell in the middle, so there is nothing to quote for and
   * nothing to get wrong when a commit message contains a semicolon.
   */
  argv?: readonly string[]
  cwd: string
  environment: Record<string, string>
  /** The step's own `timeout-minutes`, in milliseconds. The ceiling otherwise. */
  timeoutMs?: number
  onOutput: (text: string, stream: 'stdout' | 'stderr') => Promise<void>
}): Promise<StepResult> {
  const child = Bun.spawn(input.argv ? [...input.argv] : ['/bin/sh', '-c', String(input.command ?? '')], {
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
  /*
   * Retried when the instance asks this runner to slow down.
   *
   * The chunk is idempotent on its sequence, so sending it again costs nothing
   * and the log stays whole - which is the point: the ceiling truncates at the
   * end, visibly, and dropping the middle instead would be a log missing the
   * part where something went wrong with nothing to say it happened.
   *
   * Bounded, because a runner that waits forever on a server that keeps saying
   * no is a job nobody can cancel. After a few tries the chunk is let go and
   * the job carries on: losing a line is bad, and stalling a machine is worse.
   */
  for (let attempt = 0; attempt < 5; attempt++) {
    const answer = await post(baseUrl, '/api/runner/logs', jobToken, { sequence, content, stream })

    if (answer.ok || !answer.body?.retry_after_ms)
      return

    await new Promise(resolve => setTimeout(resolve, Math.min(2000, Number(answer.body.retry_after_ms) || 200)))
  }
}

/**
 * "Still here", and what has finished since the last time this was said.
 *
 * Two jobs in one request because they are the same request: the lease has to
 * be renewed on a timer anyway, and a step result that waits for the job to end
 * is a step result a crash loses - which is exactly the case restart-from-step
 * exists for.
 *
 * A refusal is information rather than an error to swallow: the job is no
 * longer this runner's, and anything it does afterwards will be refused too.
 * The caller is told, so it can stop.
 */
async function beat(baseUrl: string, jobToken: string, steps: StepTiming[]): Promise<{ held: boolean, recorded: number }> {
  const answer = await post(baseUrl, '/api/runner/heartbeat', jobToken, {
    steps: steps.length > 0 ? steps : null,
  })

  return {
    held: answer.ok,
    recorded: Number(answer.body?.steps_recorded ?? 0) || 0,
  }
}

async function report(
  baseUrl: string,
  jobToken: string,
  state: string,
  error: string,
  outputs?: Record<string, string>,
  exitStatus?: number | null,
  steps?: StepTiming[],
): Promise<void> {
  // The outputs travel with the conclusion: a job that reported values and then
  // failed to report its result would leave them attached to a job nobody can
  // tell finished.
  //
  // The steps travel with it for the same reason, and because nothing reads a
  // step's recorded result until its job is over - so a call per step would be
  // forty requests to deliver information nobody is waiting for.
  await post(baseUrl, '/api/runner/report', jobToken, {
    state,
    error,
    outputs: outputs ?? null,
    exit_status: exitStatus ?? null,
    steps: steps && steps.length > 0 ? steps : null,
  })
}

/**
 * What one step did, in the shape the control plane records.
 *
 * Three numbers rather than one, because they answer different questions.
 * **Wall time** is `finished_at` minus `started_at` and is derived from them
 * rather than sent. **`queued_ms`** is what this step spent waiting before
 * anything ran it - the gap after the step before it, which for the first step
 * is everything the runner did to get ready. **`active_ms`** is the command's
 * own duration.
 *
 * A step that took nine minutes of which eight were setup is a different
 * problem from one that took nine minutes of work, and one number cannot say
 * which.
 */
interface StepTiming {
  position: number
  state: string
  exit_code: number | null
  started_at: string
  finished_at: string
  queued_ms: number
  active_ms: number
  outputs: Record<string, string> | null
  /**
   * How many times this runner ran the step, counting from one.
   *
   * Stated rather than left to the control plane to count, so the same result
   * arriving twice - which at-least-once delivery guarantees will happen -
   * records the same number rather than climbing.
   */
  attempt: number
  /** Why it failed, when it did. */
  error: string | null
}

/**
 * One intercepted `actions/cache` step.
 *
 * Says what it did, always. An intercepted step is a step that did not run the
 * program its author named, and a runner that stayed quiet about that would be
 * a runner somebody debugs for an hour - so the log names the substitution as
 * well as the outcome.
 */
async function runKeyedCache(input: {
  mode: 'both' | 'restore' | 'save'
  request: ReturnType<typeof requestFrom>
  baseUrl: string
  jobToken: string
  workspace: string
  send: (text: string, stream?: 'stdout' | 'stderr') => Promise<void> | void
}): Promise<{ hit: boolean }> {
  const scratch = join(input.workspace, '.reviewos-runner')

  await input.send('Handled by this instance rather than by the action: same store, same scopes, same collection policy.\n')

  if (!input.request.key) {
    await input.send('This step named no key, so there is nothing to look up.\n', 'stderr')

    return { hit: false }
  }

  let hit = false

  if (input.mode !== 'save') {
    const restored = await restoreKeyed({
      baseUrl: input.baseUrl,
      jobToken: input.jobToken,
      request: input.request,
      workspace: input.workspace,
      scratch,
    })

    hit = restored.hit

    await input.send(restored.restored
      ? `Restored ${restored.hit ? 'an exact match' : 'the closest earlier cache'} for "${input.request.key}" from ${restored.scope}\n`
      : `Nothing cached for "${input.request.key}": ${restored.reason}\n`)
  }

  /*
   * Saved on the way through rather than at the end of the job.
   *
   * The real action saves in a post-step, which this runner has no equivalent
   * of. Saving now is a smaller difference than it looks: the paths a keyed
   * step names are written by the step before it - that is the whole shape of
   * the form - and anything written afterwards was never part of what the
   * author asked to cache.
   *
   * An exact hit skips the save, because storing what is already stored is an
   * upload spent to reach the state it is in.
   */
  if (input.mode !== 'restore' && !hit) {
    const saved = await saveKeyed({
      baseUrl: input.baseUrl,
      jobToken: input.jobToken,
      request: input.request,
      workspace: input.workspace,
      scratch,
    })

    await input.send(saved.saved
      ? `Cached ${JSON.stringify(input.request.path)} under "${input.request.key}"\n`
      : `Nothing cached under "${input.request.key}": ${saved.reason}\n`)
  }

  return { hit }
}

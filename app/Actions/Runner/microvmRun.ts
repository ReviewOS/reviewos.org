/**
 * A claimed job, routed into a machine.
 *
 * `microvmSupervisor.ts` runs one job in one machine; this decides that *this*
 * job is one of them and turns a claim into the arguments for it. Separate from
 * `localExecutor.ts` on purpose: that file is thousands of lines of host
 * execution, and the point of this mode is that almost none of it applies.
 *
 * ## What it deliberately does not reuse
 *
 * No workspace, no toolchain path, no plugin install, no `GITHUB_ENV` carried
 * between steps through the host's filesystem. All of that is machinery for
 * running somebody's code as a process on this machine, and this mode exists so
 * that does not happen. Sharing it would mean sharing the assumptions it was
 * built on.
 *
 * ## The fork rule inverts here, and that is the point
 *
 * `localExecutor.ts` refuses an untrusted run with "a fork's pull request needs
 * an isolated runner". This *is* the isolated runner, so that refusal is not
 * carried over: a machine with its own kernel, a read-only image and a
 * default-deny network is the mode in which running a stranger's code is
 * defensible, which is the sentence the threat model uses.
 *
 * It is still opt-in and still refuses when a piece is missing, because a runner
 * that quietly ran the job somewhere weaker would be claiming an isolation it
 * does not have.
 */

import { mkdir, rm } from 'node:fs/promises'
import { checkoutCode } from './checkout'
import type { ActionShip, GuestStep } from './microvmActions'
import { expandSteps } from './microvmActions'
import { deliverableSecrets } from './microvmSecrets'
import { machineSpec } from './microvm'
import type { EgressPolicy, EgressRule } from './networkPolicy'
import { buildEgressPolicy } from './networkPolicy'
import { superviseJob } from './microvmSupervisor'
import type { JobStep, SupervisorHost } from './microvmSupervisor'
import {
  egressRules,
  firecrackerPath,
  guestAddress,
  guestImage,
  guestImageDigest,
  guestKernel,
  hostAddress,
  instanceAddresses,
  machineDiskMib,
  machineMemoryMib,
  machineVcpus,
  microvmRefusal,
  scratchDirectory,
} from '../../../config/ci-execution'

/** What the runner knows that the job does not: where to clone from, and as whom. */
export interface CheckoutSource {
  reposRoot: string
  baseUrl: string
  cloneToken?: string
}

export interface MicrovmRunOutcome {
  state: 'succeeded' | 'failed'
  reason: string
  /** What the failing step exited with, so `retry: { exit-status: [...] }` means something. */
  exitStatus: number | null
}

/**
 * The steps a job wants run, as commands the guest can execute.
 *
 * A `uses:` step is expanded here rather than run there: the host resolves the
 * reference, applies the policy, fetches what needs fetching and reads the
 * manifest, and a composite action becomes the commands it is made of.
 * `microvmActions.ts` explains why that division is the right one rather than a
 * shortcut.
 */
export async function stepsFor(input: {
  job: any
  workspace: string
  actionsRoot: string
  /** Where fetched actions are cached, host-side. */
  cacheRoot: string
  /** The checkout, host-side, which is where a local action lives. */
  sourcePath?: string
  onOutput: (text: string, stream: 'stdout' | 'stderr') => Promise<void>
}): Promise<{ ok: true, steps: GuestStep[], ship: ActionShip[] } | { ok: false, reason: string }> {
  const raw: any[] = Array.isArray(input.job?.steps) ? input.job.steps : []

  const expanded = await expandSteps({
    steps: raw,
    workspace: input.workspace,
    actionsRoot: input.actionsRoot,
    resolve: uses => resolveAction(uses, input),
  })

  if (!expanded.ok)
    return { ok: false, reason: expanded.reason }

  for (const warning of expanded.warnings)
    await input.onOutput(`::warning::${warning}\n`, 'stdout').catch(() => {})

  if (expanded.steps.length === 0)
    return { ok: false, reason: 'This job has no commands to run.' }

  return { ok: true, steps: expanded.steps, ship: expanded.ship }
}

/**
 * A reference, as a directory on the host.
 *
 * The policy is checked before anything is fetched, which is the ordering that
 * makes it a policy: a reference that would be refused must not have been
 * downloaded first.
 */
async function resolveAction(
  uses: string,
  context: { cacheRoot: string, sourcePath?: string },
): Promise<{ ok: true, directory: string, local: boolean, label: string, relative?: string } | { ok: false, reason: string }> {
  const { parseActionRef, defaultPolicy, checkPolicy } = await import('./actionRef')

  const reference = parseActionRef(uses)

  if (reference.kind === 'container') {
    return {
      ok: false,
      reason: `\`${uses}\` is a container action, and a microVM is already the isolation boundary - it does not run a container runtime inside itself.`,
    }
  }

  if (reference.kind === 'unknown')
    return { ok: false, reason: `\`${uses}\` is not an action reference this runner understands` }

  if (reference.kind === 'local') {
    if (!context.sourcePath)
      return { ok: false, reason: `\`${uses}\` is an action in this repository, and this job has no checkout` }

    const relative = String(reference.path ?? '').replace(/^\.\//, '')

    return { ok: true, directory: `${context.sourcePath}/${relative}`, local: true, label: uses, relative }
  }

  const decision = checkPolicy(reference, defaultPolicy())

  if (!decision.allowed)
    return { ok: false, reason: decision.reason ?? `\`${uses}\` is not allowed by this instance's action policy` }

  const { fetchAction } = await import('./actionCache')

  const fetched = await fetchAction(reference, {
    root: context.cacheRoot,
    defaultHost: defaultPolicy().defaultHost,
  } as any)

  if (!fetched.ok || !fetched.path)
    return { ok: false, reason: fetched.reason ?? `\`${uses}\` could not be fetched` }

  return { ok: true, directory: fetched.path, local: false, label: uses }
}

/**
 * The egress entries an operator wrote, as a policy.
 *
 * `host:port`, with the port optional because the policy's own default is 443.
 * A refused entry fails the job rather than being dropped: an operator who wrote
 * a rule the policy will not accept has a misconfigured runner, and running
 * their jobs with a quietly shorter allowlist is how that goes unnoticed.
 */
export function policyFrom(
  entries: readonly string[],
  own: readonly string[],
): { ok: true, policy: EgressPolicy } | { ok: false, reason: string } {
  const rules: EgressRule[] = entries.map((entry) => {
    const at = entry.lastIndexOf(':')
    const port = at > 0 ? Number(entry.slice(at + 1)) : Number.NaN

    return Number.isInteger(port) && port > 0
      ? { host: entry.slice(0, at), ports: [port] }
      : { host: entry }
  })

  const built = buildEgressPolicy(rules, { instanceAddresses: own })

  if (!built.ok) {
    return {
      ok: false,
      reason: `This runner's egress policy was refused: ${built.refusals.map(one => `\`${one.rule}\` (${one.reason})`).join('; ')}`,
    }
  }

  return { ok: true, policy: built.policy }
}

/**
 * How long the machine may live.
 *
 * The job's own `timeout-minutes` where it set one. Unlike the host path this is
 * not checked between steps - it is handed to the supervisor, which kills the
 * machine. A step that ignores a signal is not a case needing handling when the
 * thing being ended is the computer it runs on.
 */
export function wallSecondsFor(job: any): number {
  const minutes = Number(job?.timeout_minutes ?? 0)

  return Number.isFinite(minutes) && minutes > 0 ? Math.floor(minutes * 60) : 3600
}

/**
 * Run one claimed job in a machine.
 *
 * Returns rather than reports. The caller owns the conversation with the
 * instance, and a function that both ran the job and told the instance how it
 * went would be two responsibilities that fail separately.
 */
export async function runJobInMachine(input: {
  job: any
  /** Where the source comes from. Absent means the job runs without one. */
  source?: CheckoutSource
  /** Called with console output as it arrives, for the live log. */
  onOutput: (text: string, stream: 'stdout' | 'stderr') => Promise<void>
  /** Overridable, so a test can see what would be run without a hypervisor. */
  supervise?: typeof superviseJob
}): Promise<MicrovmRunOutcome> {
  const refusal = microvmRefusal()

  if (refusal)
    return { state: 'failed', reason: refusal, exitStatus: null }

  const own = instanceAddresses()
  const policy = policyFrom(egressRules(), own)

  if (!policy.ok)
    return { state: 'failed', reason: policy.reason, exitStatus: null }

  const jobId = Number(input.job?.id ?? 0)
  const scratch = scratchDirectory()

  const spec = machineSpec({
    jobId,
    imagePath: guestImage(),
    imageDigest: guestImageDigest(),
    kernelPath: guestKernel(),
    overlayPath: `${scratch}/job-${jobId}.ext4`,
    policy: policy.policy,
    vcpus: machineVcpus(),
    memoryMib: machineMemoryMib(),
    diskMib: machineDiskMib(),
    wallSeconds: wallSecondsFor(input.job),
  })

  const host: SupervisorHost = {
    firecracker: firecrackerPath(),
    scratch,
    hostAddress: hostAddress(),
    guestAddress: guestAddress(),
    instanceAddresses: own,
    privileged: runPrivileged,
  }

  /*
   * The checkout happens **on the host**, and that is the security property
   * rather than a convenience.
   *
   * The host has the clone credential and a route to the instance; the guest has
   * neither and must keep having neither - the egress policy refuses the
   * instance's own addresses, so a guest could not clone even if it were handed
   * a token. So the host checks out into a staging directory and the working
   * tree crosses as bytes on the payload disk.
   *
   * The credential does not cross with it: `checkoutCode` keeps it in an askpass
   * helper written to the staging directory's *parent*, so copying the staging
   * directory copies the tree and nothing else.
   */
  const staging = `${scratch}/checkout-${jobId}`
  let sourcePath: string | undefined

  if (input.source) {
    const prepared = await prepareCheckout({
      staging,
      job: input.job,
      source: input.source,
      onOutput: input.onOutput,
    })

    if (!prepared.ok)
      return { state: 'failed', reason: prepared.reason, exitStatus: null }

    sourcePath = prepared.checkedOut ? staging : undefined
  }

  try {
    /*
     * The steps are worked out *after* the checkout, because a `uses:` naming an
     * action in this repository can only be resolved once the repository is on
     * disk. A job whose action cannot be expanded fails here rather than in the
     * machine - which is the right place, since nothing about it is the guest's
     * business.
     */
    const steps = await stepsFor({
      job: input.job,
      workspace: '/work/workspace',
      actionsRoot: '/work/actions',
      cacheRoot: `${scratch}/actions`,
      sourcePath,
      onOutput: input.onOutput,
    })

    if (!steps.ok)
      return { state: 'failed', reason: steps.reason, exitStatus: null }

    const outcome = await (input.supervise ?? superviseJob)({
      spec,
      steps: steps.steps,
      ship: steps.ship,
      host,
      sourcePath,
      /*
       * What the instance already decided this job may have. `deliverableSecrets`
       * re-checks the one rule whose failure is unrecoverable - an untrusted run
       * receives nothing - as a second lock on the door that matters.
       */
      secrets: deliverableSecrets(input.job),
      onOutput: async text => input.onOutput(text, 'stdout'),
    })

  /*
   * The guest's report says what the steps came to; whether the *job* succeeded
   * is the host's judgement and it is stricter. A machine that stopped without
   * the agent saying it finished failed, whatever its last step reported - that
   * is the shape a job takes when the clock kills it.
   */
    const failing = outcome.steps.find(step => step.exitCode !== 0)

    if (outcome.ok)
      return { state: 'succeeded', reason: '', exitStatus: 0 }

    return {
      state: 'failed',
      reason: failing
        ? `Step ${failing.index + 1} exited ${failing.exitCode}.`
        : (outcome.reason || 'The machine did not report a result.'),
      exitStatus: failing ? failing.exitCode : null,
    }
  }
  finally {
    /*
     * The staging checkout goes whatever happened. It is a full copy of somebody's
     * repository on a machine that runs one job after another, and a runner that
     * kept them would fill its disk with other people's source - which is both a
     * disclosure between jobs and an outage.
     */
    await rm(staging, { recursive: true, force: true }).catch(() => {})
  }
}

/**
 * Check the job's commit out into a staging directory.
 *
 * Reuses `checkoutCode`, so a depth, sparse paths, submodules and LFS mean the
 * same thing here as on the host path. A second implementation of "what a
 * checkout is" would drift from that one within a month, and the drift would be
 * invisible until a workflow behaved differently in the two modes.
 */
async function prepareCheckout(input: {
  staging: string
  job: any
  source: CheckoutSource
  onOutput: (text: string, stream: 'stdout' | 'stderr') => Promise<void>
}): Promise<{ ok: true, checkedOut: boolean } | { ok: false, reason: string }> {
  await mkdir(input.staging, { recursive: true }).catch(() => {})

  const done = await checkoutCode({
    reposRoot: input.source.reposRoot,
    fullName: String(input.job?.repository_full_name ?? ''),
    sha: String(input.job?.run?.head_sha ?? ''),
    workspace: input.staging,
    baseUrl: input.source.baseUrl,
    cloneToken: input.source.cloneToken,
    options: (input.job?.checkout ?? undefined),
    onOutput: input.onOutput,
    run: runGitCommand,
  })

  if (!done.ok)
    return { ok: false, reason: done.reason }

  /*
   * A job that asked for no checkout gets no workspace rather than an empty one.
   * The distinction reaches the guest: `cd /work/workspace` succeeds either way,
   * and a step looking for a file it expected is better served by "there is no
   * source here" than by an empty directory it has to diagnose.
   */
  return { ok: true, checkedOut: done.reason !== 'no checkout was asked for' }
}

/**
 * The privileged half, which is three commands.
 *
 * A tap device, a filter, and a loop mount. Firecracker itself runs as whoever
 * started the runner - which is why this is a short list rather than "the
 * supervisor runs as root".
 *
 * `sudo -n`, never prompting: a runner is a daemon with nobody at the keyboard,
 * and a sudo that waits for a password is a job that hangs until its lease
 * lapses instead of failing with a reason.
 */
async function runPrivileged(argv: readonly string[], stdin?: string): Promise<{ ok: boolean, output: string }> {
  const child = Bun.spawn(['sudo', '-n', ...argv], {
    stdin: stdin === undefined ? 'ignore' : new TextEncoder().encode(stdin),
    stdout: 'pipe',
    stderr: 'pipe',
  })

  const out = await new Response(child.stdout).text()
  const err = await new Response(child.stderr).text()

  return { ok: (await child.exited) === 0, output: `${out}${err}` }
}

/**
 * Run the clone.
 *
 * Plainer than the host path's `runStep`, deliberately. That one applies the
 * step ceilings, the step timeout and the log grouping, all of which exist for
 * *a workflow's* commands - and this is the runner cloning into a staging
 * directory it is about to copy and delete. Borrowing the ceilings would mean a
 * checkout that trips a limit written for somebody's test suite.
 */
async function runGitCommand(options: {
  command: string
  cwd: string
  environment: Record<string, string>
  onOutput: (text: string, stream: 'stdout' | 'stderr') => Promise<void>
}): Promise<{ ok: boolean, exitCode: number }> {
  const child = Bun.spawn(['/bin/sh', '-c', options.command], {
    cwd: options.cwd,
    env: options.environment,
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'ignore',
  })

  const decoder = new TextDecoder()

  for await (const chunk of child.stdout as any)
    await options.onOutput(decoder.decode(chunk, { stream: true }), 'stdout').catch(() => {})

  const code = await child.exited

  return { ok: code === 0, exitCode: code }
}

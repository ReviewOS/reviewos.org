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

export interface MicrovmRunOutcome {
  state: 'succeeded' | 'failed'
  reason: string
  /** What the failing step exited with, so `retry: { exit-status: [...] }` means something. */
  exitStatus: number | null
}

/**
 * The steps a job wants run, as commands.
 *
 * Only `run:` steps. A `uses:` step is an action - a program the runner fetches
 * and executes with a protocol around it - and none of that exists for a guest.
 * Refused by name rather than skipped, because a job whose `uses:` steps
 * silently did not happen is a job reporting success for work nobody did.
 */
export function stepsFor(job: any): { ok: true, steps: JobStep[] } | { ok: false, reason: string } {
  const raw: any[] = Array.isArray(job?.steps) ? job.steps : []
  const steps: JobStep[] = []

  for (const [index, step] of raw.entries()) {
    if (step?.uses) {
      return {
        ok: false,
        reason: `Step ${index + 1} uses \`${String(step.uses)}\`, and actions do not run in a microVM yet. This runner will not pretend to have run it.`,
      }
    }

    if (!step?.run)
      continue

    steps.push({ run: String(step.run) })
  }

  if (steps.length === 0)
    return { ok: false, reason: 'This job has no commands to run.' }

  return { ok: true, steps }
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
  /** Called with console output as it arrives, for the live log. */
  onOutput: (text: string, stream: 'stdout' | 'stderr') => Promise<void>
  /** Overridable, so a test can see what would be run without a hypervisor. */
  supervise?: typeof superviseJob
}): Promise<MicrovmRunOutcome> {
  const refusal = microvmRefusal()

  if (refusal)
    return { state: 'failed', reason: refusal, exitStatus: null }

  const steps = stepsFor(input.job)

  if (!steps.ok)
    return { state: 'failed', reason: steps.reason, exitStatus: null }

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

  const outcome = await (input.supervise ?? superviseJob)({
    spec,
    steps: steps.steps,
    host,
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

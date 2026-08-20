/**
 * Running one job inside one machine, and taking the machine away afterwards.
 *
 * This is the piece the execution plane was missing. `microvm.ts` decides what
 * the machine is, `networkPolicy.ts` decides what it may reach, and neither of
 * them starts anything - so until now the mechanisms were verified and the
 * product still ran every step as a process on the runner host.
 *
 * ## The unit is the job, not the step
 *
 * A step is not independently isolatable: it inherits a workspace the steps
 * before it wrote, so a machine per step would hand step nine a fresh disk and
 * none of the eight installs it depends on. One machine per job, every step
 * inside it, torn down at the end - which is also what makes the workspace
 * ephemeral without anybody remembering to delete it.
 *
 * ## Teardown is not the happy path
 *
 * The reason teardown is a plan rather than a sequence of statements at the
 * bottom of a function: a supervisor that only cleans up when the job ends
 * normally leaks a tap device, a filter table and a disk image on every crash,
 * every timeout and every kill - and a runner that has leaked forty tap devices
 * stops being able to start machines at all, for a reason nobody will connect to
 * a build that failed three weeks ago.
 *
 * So every resource is registered the moment it exists and released in reverse,
 * unconditionally, including when the boot itself failed.
 *
 * ## What the host trusts
 *
 * Nothing the guest says about itself. The exit codes come back framed by
 * `microvmProtocol.ts` and the wall clock is enforced by killing the machine,
 * because a guest that decides not to report is the ordinary case rather than a
 * surprise. What the host trusts is what it can see: the process exited, the
 * frames it could parse, and the clock.
 */

import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { MachineSpec } from './microvm'
import { firecrackerConfig } from './microvm'
import { nftRuleset } from './networkPolicy'
import type { StepReport } from './microvmProtocol'
import { bootNonce, readConsole } from './microvmProtocol'

export interface JobStep {
  /** The shell command this step runs, exactly as the workflow wrote it. */
  run: string
}

export interface SupervisorHost {
  /** Where firecracker is. */
  firecracker: string
  /** A directory the supervisor may create per-job files in. */
  scratch: string
  /** The guest's address on the tap link, and the host's. */
  guestAddress: string
  hostAddress: string
  /** Addresses of this instance, which a job may never reach. */
  instanceAddresses?: readonly string[]
  /** Run a privileged command. Separate so tests can watch it without root. */
  privileged: (argv: readonly string[], input?: string) => Promise<{ ok: boolean, output: string }>
}

export interface SupervisedOutcome {
  ok: boolean
  steps: StepReport[]
  /** Why it ended, when it did not end by the guest finishing. */
  reason?: string
  /** Console text outside any frame - the guest kernel, mostly. */
  noise: string
}

/**
 * Everything that has to be undone, in the order it was made.
 *
 * A list rather than a `finally` block with five statements in it, because the
 * statements would each need their own guard for "did this get as far as
 * existing" and the guards are where the leaks come from.
 */
export interface Teardown {
  what: string
  undo: () => Promise<void>
}

/**
 * Run a job in a machine.
 *
 * Never throws. A supervisor that threw would leave the caller holding a job it
 * cannot report on, and the resources would already be registered here.
 */
export async function superviseJob(input: {
  spec: MachineSpec
  steps: readonly JobStep[]
  host: SupervisorHost
  /** A checkout on the host to hand the guest as its working directory. */
  sourcePath?: string
  /** Live output, as the console produces it. */
  onOutput?: (text: string) => Promise<void>
  /** Injectable for tests; defaults to the real clock. */
  now?: () => number
}): Promise<SupervisedOutcome> {
  const undo: Teardown[] = []
  const nonce = bootNonce()
  const overlay = input.spec.drives.find(drive => !drive.isRoot)?.path ?? join(input.host.scratch, `job-${input.spec.jobId}.ext4`)
  const table = `reviewos_job${Math.abs(Math.trunc(input.spec.jobId))}`

  try {
    /*
     * The payload disk first, because it is the only thing the guest is told.
     * The steps and the nonce go on it; the agent unlinks the nonce before the
     * first step runs.
     */
    /*
     * Registered **before** it is made, and removed with privilege.
     *
     * Both halves are a bug found by a disk filling up mid-run. `mkfs` failed
     * partway and left a root-owned gigabyte behind: registering the cleanup
     * after a successful creation meant a *partial* disk was never registered at
     * all, and the file it left could not have been removed by the unprivileged
     * process anyway, because the chown that hands it over is the last line of a
     * script that had already failed.
     *
     * So the undo is armed first and goes through the privileged path. Removing
     * something that was never created is what `rm -f` is for.
     */
    undo.push({ what: 'overlay', undo: async () => { await input.host.privileged(['rm', '-f', overlay]) } })

    const made = await makeOverlay(input.host, overlay, input.spec.diskMib, input.steps, nonce, input.sourcePath)

    if (!made.ok)
      return { ok: false, steps: [], reason: made.output.slice(0, 400), noise: '' }

    const tap = input.spec.network.tapDevice

    const network = await input.host.privileged(['sh', '-c', tapScript(tap, input.host.hostAddress)])

    if (!network.ok)
      return { ok: false, steps: [], reason: `the tap device could not be made: ${network.output.slice(0, 200)}`, noise: '' }

    undo.push({ what: 'tap', undo: async () => { await input.host.privileged(['ip', 'link', 'del', tap]) } })

    /*
     * The filter before the machine, never after.
     *
     * A guest that boots into an unfiltered network and is filtered a moment
     * later has had a moment of unfiltered network, and a moment is all an
     * exfiltration needs.
     */
    const ruleset = nftRuleset({
      table,
      guestAddress: input.host.guestAddress,
      tapDevice: tap,
      policy: input.spec.network.policy,
      instanceAddresses: input.host.instanceAddresses,
    })

    const filtered = await input.host.privileged(['nft', '-f', '-'], ruleset)

    if (!filtered.ok)
      return { ok: false, steps: [], reason: `the egress policy could not be applied: ${filtered.output.slice(0, 200)}`, noise: '' }

    undo.push({ what: 'ruleset', undo: async () => { await input.host.privileged(['nft', 'delete', 'table', 'inet', table]) } })

    const configPath = join(input.host.scratch, `job-${input.spec.jobId}.json`)

    await Bun.write(configPath, JSON.stringify(firecrackerConfig(input.spec), null, 2))
    undo.push({ what: 'config', undo: () => rm(configPath, { force: true }).catch(() => {}) })

    const booted = await boot({
      host: input.host,
      configPath,
      wallSeconds: input.spec.wallSeconds,
      onOutput: input.onOutput,
    })

    const reading = readConsole(booted.console, nonce)

    return {
      /*
       * `ok` is the guest saying it finished *and* every step it reported
       * succeeding. A machine that stopped without saying so is not a success,
       * whatever its last step said - that is the shape a job takes when it is
       * killed for time, and reading its final exit code would report the step
       * before the one that ran out.
       */
      ok: reading.finished && reading.steps.every(step => step.exitCode === 0),
      steps: reading.steps,
      reason: reading.finished ? undefined : booted.reason,
      noise: reading.noise,
    }
  }
  catch (error) {
    return { ok: false, steps: [], reason: String((error as Error)?.message ?? error).slice(0, 400), noise: '' }
  }
  finally {
    // In reverse, unconditionally, and each one swallowing its own failure: the
    // second resource must be released even when the first refuses to be.
    for (const step of undo.reverse())
      await step.undo().catch(() => {})
  }
}

/**
 * Boot, stream, and stop.
 *
 * The wall clock is enforced by killing the process rather than by asking the
 * guest to stop, which is the difference between a limit and a request - and the
 * reason the roadmap's "enforced outside the job" is true here and was not true
 * of `ulimit`.
 */
async function boot(input: {
  host: SupervisorHost
  configPath: string
  wallSeconds: number
  onOutput?: (text: string) => Promise<void>
}): Promise<{ console: string, reason?: string }> {
  const child = Bun.spawn([input.host.firecracker, '--no-api', '--config-file', input.configPath], {
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'ignore',
  })

  let text = ''
  let timedOut = false

  const timer = setTimeout(() => {
    timedOut = true
    child.kill()
  }, Math.max(1, input.wallSeconds) * 1000)

  try {
    const decoder = new TextDecoder()

    for await (const chunk of child.stdout as any) {
      const piece = decoder.decode(chunk, { stream: true })

      text += piece

      // Streamed as it arrives, so a run screen shows a build happening rather
      // than a blank panel and then everything at once.
      if (input.onOutput)
        await input.onOutput(piece).catch(() => {})
    }

    await child.exited
  }
  finally {
    clearTimeout(timer)
  }

  return { console: text, reason: timedOut ? `the machine was killed after ${input.wallSeconds} seconds` : 'the machine stopped without the agent reporting' }
}

/**
 * The payload disk: an ext4 image holding the steps and the nonce.
 *
 * Each step is a file rather than a line in a script, so a step whose command
 * contains a newline, a quote or a null is still one step. Assembling them into
 * one shell program is how a `run:` block with a heredoc in it becomes two
 * steps, one of which is somebody's data.
 */
export async function makeOverlay(
  host: SupervisorHost,
  path: string,
  sizeMib: number,
  steps: readonly JobStep[],
  nonce: string,
  /** A checkout on the host, copied in as the guest's working directory. */
  sourcePath?: string,
): Promise<{ ok: boolean, output: string }> {
  const files: string[] = [
    `mkdir -p "$M/steps" "$M/workspace"`,
    `printf '%s' ${shellQuote(nonce)} > "$M/nonce"`,
  ]

  /*
   * The source, copied rather than mounted, and copied by the *host*.
   *
   * This is the property worth stating plainly: the guest is handed a working
   * tree as bytes and never given the credential that produced it, nor a route
   * to the instance it came from. The host clones - it has the token and the
   * network - and what crosses is a directory.
   *
   * `.` inside the directory rather than the directory itself, so the tree lands
   * *as* the workspace instead of one level down inside it. And `-a` because the
   * executable bit on a checked-in script is the difference between a build that
   * runs and one that says "permission denied" for no visible reason.
   */
  if (sourcePath)
    files.push(`cp -a ${shellQuote(sourcePath)}/. "$M/workspace/"`)

  steps.forEach((step, index) => {
    files.push(`printf '%s' ${shellQuote(step.run)} > "$M/steps/${index}.sh"`)
  })

  /*
   * Handed back to the user who will boot the machine.
   *
   * Making the disk needs root - a loop mount does - and *booting* deliberately
   * does not: Firecracker runs unprivileged, which is the whole reason the
   * privileged surface here is three commands rather than the supervisor.
   *
   * Without this line the two disagree, and they disagree silently in the worst
   * way: the disk is created, the tap comes up, the filter loads, and the
   * hypervisor then refuses to open a file it does not own. Found by running it.
   */
  const owner = `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`

  return host.privileged(['sh', '-c', [
    'set -e',
    `rm -f ${shellQuote(path)}`,
    `dd if=/dev/zero of=${shellQuote(path)} bs=1M count=${Math.max(16, Math.floor(sizeMib))} status=none`,
    `mkfs.ext4 -q ${shellQuote(path)}`,
    `M=$(mktemp -d)`,
    `mount -o loop ${shellQuote(path)} "$M"`,
    ...files,
    `umount "$M"`,
    `rmdir "$M"`,
    `chown ${owner} ${shellQuote(path)}`,
  ].join('\n')])
}

/** The commands that bring a tap device up for one machine. */
export function tapScript(tap: string, hostAddress: string): string {
  return [
    'set -e',
    `ip link del ${tap} 2>/dev/null || true`,
    `ip tuntap add dev ${tap} mode tap`,
    `ip addr add ${hostAddress}/30 dev ${tap}`,
    `ip link set ${tap} up`,
    'sysctl -w net.ipv4.ip_forward=1 >/dev/null',
  ].join('\n')
}

/** A value as one shell word, whatever is in it. */
export function shellQuote(value: string): string {
  return `'${String(value ?? '').replace(/'/g, `'\\''`)}'`
}

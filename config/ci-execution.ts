/**
 * **How this runner executes a job**
 *
 * [The threat model](../docs/ci-threat-model.md) names three modes and makes the
 * default the one that runs nothing. This is where a runner says which of them
 * it is, and the reading of an unset variable is the safe one: a runner that has
 * been told nothing runs steps as host processes, exactly as it did before any
 * of this existed, and refuses untrusted work.
 *
 * ## Why `microvm` is a mode and not a fallback
 *
 * `REVIEWOS_EXECUTION=microvm` is a claim about the machine the runner is on -
 * that it has KVM, a hypervisor, an image and a kernel. None of that can be
 * usefully guessed, and a runner that quietly fell back to host execution when
 * it could not boot a machine would be a runner that says it is isolating jobs
 * and is not. That is the failure [the security review](../docs/ci-security-review.md)
 * calls the one that gets somebody hurt.
 *
 * So the mode is asked for explicitly, and when the pieces are missing the
 * runner refuses the job rather than running it somewhere weaker.
 */

export type ExecutionMode = 'host' | 'microvm'

export interface CiExecutionConfig {
  mode: ExecutionMode
  firecracker: string
  kernel: string
  image: string
  imageDigest: string
  scratch: string
  hostAddress: string
  guestAddress: string
  /** Addresses of the instance, which a job may never reach. */
  instanceAddresses: string[]
  /** What a job may connect to, as `host:port` entries. */
  egress: string[]
  vcpus: number
  memoryMib: number
  diskMib: number
}

/**
 * The mode, defaulting to what this runner has always done.
 *
 * Anything unrecognised is `host` rather than an error. A runner is somebody
 * else's machine started by somebody else's script, and a typo in an environment
 * variable should not take their CI offline - it should leave it doing what it
 * did yesterday.
 */
export function executionMode(env: Record<string, string | undefined> = process.env): ExecutionMode {
  return String(env.REVIEWOS_EXECUTION ?? '').trim().toLowerCase() === 'microvm' ? 'microvm' : 'host'
}

export function firecrackerPath(env: Record<string, string | undefined> = process.env): string {
  return String(env.REVIEWOS_FIRECRACKER ?? '/usr/local/bin/firecracker').trim()
}

export function guestKernel(env: Record<string, string | undefined> = process.env): string {
  return String(env.REVIEWOS_GUEST_KERNEL ?? '').trim()
}

export function guestImage(env: Record<string, string | undefined> = process.env): string {
  return String(env.REVIEWOS_GUEST_IMAGE ?? '').trim()
}

/**
 * The image's digest, which is what the run records.
 *
 * Read from configuration rather than computed from the file: an operator builds
 * the image and knows its digest, and hashing a multi-gigabyte file on every job
 * to re-learn something already known is a minute of every build.
 */
export function guestImageDigest(env: Record<string, string | undefined> = process.env): string {
  return String(env.REVIEWOS_GUEST_IMAGE_DIGEST ?? '').trim()
}

export function scratchDirectory(env: Record<string, string | undefined> = process.env): string {
  return String(env.REVIEWOS_MICROVM_SCRATCH ?? '/var/lib/reviewos/microvm').trim()
}

/**
 * The two ends of the tap link.
 *
 * A `/30` holding exactly two addresses, because the link has exactly two things
 * on it and a wider one is addresses a guest could try to reach.
 */
export function hostAddress(env: Record<string, string | undefined> = process.env): string {
  return String(env.REVIEWOS_MICROVM_HOST_IP ?? '172.20.0.1').trim()
}

export function guestAddress(env: Record<string, string | undefined> = process.env): string {
  return String(env.REVIEWOS_MICROVM_GUEST_IP ?? '172.20.0.2').trim()
}

/** Addresses of the instance itself, comma separated, which a job may never reach. */
export function instanceAddresses(env: Record<string, string | undefined> = process.env): string[] {
  return list(env.REVIEWOS_INSTANCE_ADDRESSES)
}

/**
 * What a job may connect to.
 *
 * Empty means nothing, which is the default and is genuinely usable for a great
 * many workflows and genuinely unusable for the ones that install dependencies.
 * The documentation says so rather than pretending the default is free.
 */
export function egressRules(env: Record<string, string | undefined> = process.env): string[] {
  return list(env.REVIEWOS_EGRESS_ALLOW)
}

export function machineVcpus(env: Record<string, string | undefined> = process.env): number {
  return whole(env.REVIEWOS_MICROVM_VCPUS, 2)
}

export function machineMemoryMib(env: Record<string, string | undefined> = process.env): number {
  return whole(env.REVIEWOS_MICROVM_MEMORY_MIB, 2048)
}

export function machineDiskMib(env: Record<string, string | undefined> = process.env): number {
  return whole(env.REVIEWOS_MICROVM_DISK_MIB, 2048)
}

/**
 * Why this runner cannot run a job in a machine, or null when it can.
 *
 * Checked before a job is claimed rather than after, so a misconfigured runner
 * says so in its own log instead of failing somebody's build with it.
 */
export function microvmRefusal(env: Record<string, string | undefined> = process.env): string | null {
  if (!guestKernel(env))
    return 'REVIEWOS_GUEST_KERNEL is not set, and a microVM needs a kernel to boot'

  if (!guestImage(env))
    return 'REVIEWOS_GUEST_IMAGE is not set, and a microVM needs a root image'

  /*
   * The digest is required rather than optional, and this is the one refusal
   * here that is about honesty rather than about booting. A machine will boot
   * perfectly well from an image nobody named; what it cannot do is tell the run
   * what executed it, and "a run records exactly what executed it" is the line
   * this mode exists to be able to answer.
   */
  if (!guestImageDigest(env))
    return 'REVIEWOS_GUEST_IMAGE_DIGEST is not set, and a run has to be able to record what executed it'

  return null
}

function list(raw: string | undefined): string[] {
  return String(raw ?? '')
    .split(',')
    .map(one => one.trim())
    .filter(Boolean)
}

function whole(raw: string | undefined, fallback: number): number {
  const value = Number(raw)

  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback
}

export default {
  mode: executionMode(),
  firecracker: firecrackerPath(),
  kernel: guestKernel(),
  image: guestImage(),
  imageDigest: guestImageDigest(),
  scratch: scratchDirectory(),
  hostAddress: hostAddress(),
  guestAddress: guestAddress(),
  instanceAddresses: instanceAddresses(),
  egress: egressRules(),
  vcpus: machineVcpus(),
  memoryMib: machineMemoryMib(),
  diskMib: machineDiskMib(),
} satisfies CiExecutionConfig

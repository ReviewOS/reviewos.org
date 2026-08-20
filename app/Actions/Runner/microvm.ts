/**
 * The machine a job gets, as a value.
 *
 * `container.ts` makes the argument this file is built on, about a container
 * run: *"a long command line where every mistake is silent... None of those fail
 * loudly, and all of them are testable without a runtime - so the shape is
 * decided here and the execution is three lines elsewhere."*
 *
 * A microVM is that with higher stakes. A drive listed without `is_read_only`
 * boots a machine whose base image the job can rewrite for the next job. A
 * missing network interface silently gives a job the host's, unfiltered. A
 * `mem_size_mib` copied from the wrong field gives it the host's memory. Not one
 * of those fails at boot; they all produce a machine that works and is wrong.
 *
 * So the spec is a pure function, and the thing that hands it to a hypervisor is
 * phase B - which needs a Linux host with KVM and is not written here, because
 * a tap device attached to the wrong bridge looks exactly like one attached to
 * the right bridge and nobody should write that blind.
 *
 * ## Why the limits live here
 *
 * The roadmap asks for CPU, memory, process, disk and wall-time limits *enforced
 * outside the job*, and `app/Actions/Runner/limits.ts` is honest that `ulimit`
 * is not that: it is a ceiling the kernel applies to a process the job's own
 * user owns, which is housekeeping rather than a boundary.
 *
 * A VM's vcpus and memory are not a request. The guest cannot ask for a
 * seventeenth core, and a guest that forks until it dies takes only itself with
 * it. That is the same sentence the roadmap wrote, and this is the first place
 * in the product where it is true.
 */

import type { EgressPolicy } from './networkPolicy'

/** What a job is given. */
export interface MachineSpec {
  /** The job this machine exists for. One job, one machine, no reuse. */
  jobId: number
  vcpus: number
  memoryMib: number
  /** The writable overlay's ceiling, which is this job's disk limit. */
  diskMib: number
  /** How long the supervisor lets it live before killing it. */
  wallSeconds: number
  kernel: KernelSpec
  drives: readonly DriveSpec[]
  network: NetworkSpec
  /** The image this booted, by digest, which is what the run records. */
  imageDigest: string
}

export interface KernelSpec {
  path: string
  /**
   * The boot arguments.
   *
   * `panic=-1` matters more than it looks: a guest kernel that panics should
   * take the machine down immediately rather than sit at a prompt holding a
   * vcpu and a slot in the fleet until the wall clock catches it.
   */
  bootArgs: string
}

export interface DriveSpec {
  id: string
  path: string
  readOnly: boolean
  isRoot: boolean
}

export interface NetworkSpec {
  /** The host-side device. The guest cannot reconfigure what the host filters. */
  tapDevice: string
  guestMac: string
  policy: EgressPolicy
}

export interface MachineRequest {
  jobId: number
  imagePath: string
  imageDigest: string
  kernelPath: string
  overlayPath: string
  policy: EgressPolicy
  vcpus?: number
  memoryMib?: number
  diskMib?: number
  wallSeconds?: number
}

/** The defaults, which are deliberately modest: a job that needs more says so. */
export const DEFAULT_VCPUS = 2
export const DEFAULT_MEMORY_MIB = 2048
export const DEFAULT_DISK_MIB = 20480
export const DEFAULT_WALL_SECONDS = 3600

/**
 * The machine, from what the job needs and what the operator allows.
 *
 * Every ceiling is clamped rather than trusted. The caller assembling this is
 * reading a workflow file, which is somebody else's document - and a
 * `mem_size_mib` taken from it unclamped is a workflow that asks for the host's
 * memory and gets it.
 */
export function machineSpec(request: MachineRequest): MachineSpec {
  return {
    jobId: request.jobId,
    vcpus: clamp(request.vcpus, DEFAULT_VCPUS, 1, 16),
    memoryMib: clamp(request.memoryMib, DEFAULT_MEMORY_MIB, 256, 32768),
    diskMib: clamp(request.diskMib, DEFAULT_DISK_MIB, 1024, 204800),
    wallSeconds: clamp(request.wallSeconds, DEFAULT_WALL_SECONDS, 60, 21600),
    kernel: {
      path: request.kernelPath,
      bootArgs: bootArgs(),
    },
    drives: [
      /*
       * The base image, read-only, always. This is the line that makes the
       * image immutable: a job cannot modify what the next job boots, so a
       * poisoned toolchain cannot outlive the machine that installed it.
       */
      { id: 'root', path: request.imagePath, readOnly: true, isRoot: true },
      /*
       * And the writable layer, which is this job's and is destroyed with it.
       * Ephemeral by construction rather than by a cleanup somebody has to
       * remember - the failure mode of the current runner's workspace, which is
       * removed afterwards "unless a workspace root was configured".
       */
      { id: 'overlay', path: request.overlayPath, readOnly: false, isRoot: false },
    ],
    network: {
      tapDevice: tapDeviceFor(request.jobId),
      guestMac: guestMacFor(request.jobId),
      policy: request.policy,
    },
    imageDigest: request.imageDigest,
  }
}

/**
 * The guest kernel's command line.
 *
 * `panic=-1` reboots instantly on panic, which with no boot device to reboot
 * into means the machine ends. `reboot=k` makes a guest-initiated reboot a
 * shutdown, so a job cannot reboot itself into a second run inside one machine.
 * `random.trust_cpu=on` is the difference between a boot that takes a second and
 * one that blocks on entropy for a minute.
 */
export function bootArgs(): string {
  return 'ro console=ttyS0 noapic reboot=k panic=-1 pci=off random.trust_cpu=on i8042.noaux i8042.nomux'
}

/** The host-side device name for a job, bounded to what Linux accepts. */
export function tapDeviceFor(jobId: number): string {
  // Linux caps an interface name at 15 characters, and a name that is silently
  // truncated is two jobs sharing a device.
  return `rvos${Math.abs(Math.trunc(jobId)) % 100_000_000}`
}

/**
 * A MAC for the guest, derived from the job.
 *
 * Locally administered (the `02:` prefix) so it cannot collide with real
 * hardware, and derived rather than random so a packet capture on the host names
 * the job that sent it.
 */
export function guestMacFor(jobId: number): string {
  const id = Math.abs(Math.trunc(jobId)) >>> 0
  const bytes = [
    (id >>> 24) & 0xFF,
    (id >>> 16) & 0xFF,
    (id >>> 8) & 0xFF,
    id & 0xFF,
  ]

  return ['02', '00', ...bytes.map(byte => byte.toString(16).padStart(2, '0'))].join(':')
}

/**
 * The spec as Firecracker's configuration document.
 *
 * Its shape is from Firecracker's documented API and **has never been handed to
 * one** - this was written on a machine with no KVM. That the fields are right
 * is a claim phase B verifies; what is testable here is that the drives come out
 * read-only, the ceilings are clamped, and nothing of the host's is listed.
 */
export function firecrackerConfig(spec: MachineSpec): Record<string, unknown> {
  return {
    'boot-source': {
      kernel_image_path: spec.kernel.path,
      boot_args: spec.kernel.bootArgs,
    },
    'drives': spec.drives.map(drive => ({
      drive_id: drive.id,
      path_on_host: drive.path,
      is_root_device: drive.isRoot,
      is_read_only: drive.readOnly,
    })),
    'machine-config': {
      vcpu_count: spec.vcpus,
      mem_size_mib: spec.memoryMib,
      // No ballooning and no hotplug: a machine that can grow is a machine whose
      // limit is a suggestion.
      smt: false,
    },
    'network-interfaces': [{
      iface_id: 'eth0',
      guest_mac: spec.network.guestMac,
      host_dev_name: spec.network.tapDevice,
    }],
    /*
     * Deliberately absent, and each absence is a decision:
     *
     * - no `vsock` here, because the supervisor adds it with a path of its own
     *   and listing it twice is how two jobs share a socket,
     * - no shared filesystem of any kind. Not the repository storage, not a
     *   docker socket, not the runner's directory. There is nothing to escape
     *   *to* through the filesystem, which removes the class rather than
     *   guarding it,
     * - no `logger` or `metrics` pointing at a host path a guest could fill.
     */
  }
}

/** A requested number, clamped, or the default when it is not a number at all. */
function clamp(value: unknown, fallback: number, low: number, high: number): number {
  const raw = Number(value)

  if (!Number.isFinite(raw) || raw <= 0)
    return fallback

  return Math.min(Math.max(Math.floor(raw), low), high)
}

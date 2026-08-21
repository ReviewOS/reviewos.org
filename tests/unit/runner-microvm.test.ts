// The machine a job is given.
//
// `container.ts` makes the argument these tests rest on: a long configuration
// where every mistake is silent. A drive without its read-only flag boots a
// machine whose base image the job can rewrite for the next job; a memory figure
// copied from the wrong field hands over the host's. None of that fails at boot.
// It produces a machine that works and is wrong.
//
// So the spec is a value, and this is what it must always be. No microVM has
// been booted here - the host has no KVM - and that limit is exactly why these
// assertions are about the document rather than about a guest.

import { describe, expect, test } from 'bun:test'
import {
  bootArgs,
  DEFAULT_MEMORY_MIB,
  DEFAULT_VCPUS,
  firecrackerConfig,
  guestMacFor,
  machineSpec,
  tapDeviceFor,
} from '../../app/Actions/Runner/microvm'
import { buildEgressPolicy } from '../../app/Actions/Runner/networkPolicy'

const denied = (buildEgressPolicy([]) as any).policy

function spec(over: Record<string, unknown> = {}) {
  return machineSpec({
    jobId: 41,
    imagePath: '/var/lib/reviewos/images/base-abc.ext4',
    imageDigest: 'sha256:abc',
    kernelPath: '/var/lib/reviewos/kernels/vmlinux',
    overlayPath: '/var/lib/reviewos/overlays/41.ext4',
    policy: denied,
    ...over,
  } as any)
}

describe('the drives', () => {
  test('boot a read-only root, which is what makes the image immutable', () => {
    /*
     * The single most consequential flag here. A writable base image is a job
     * modifying what the next job boots - a poisoned toolchain that outlives the
     * machine that installed it, on every job afterwards.
     */
    const root = spec().drives.find(drive => drive.isRoot)

    expect(root?.readOnly).toBe(true)
    expect(firecrackerConfig(spec()).drives).toEqual([
      { drive_id: 'root', path_on_host: '/var/lib/reviewos/images/base-abc.ext4', is_root_device: true, is_read_only: true },
      { drive_id: 'overlay', path_on_host: '/var/lib/reviewos/overlays/41.ext4', is_root_device: false, is_read_only: false },
    ])
  })

  test('and nothing of the host is listed at all', () => {
    /*
     * Not the repository storage, not a docker socket, not the runner's own
     * directory. There is nothing to escape *to* through the filesystem, which
     * removes the class of mount-escape bug rather than guarding against it.
     */
    const config = firecrackerConfig(spec()) as any
    const paths = config.drives.map((drive: any) => drive.path_on_host)

    expect(paths).toEqual(['/var/lib/reviewos/images/base-abc.ext4', '/var/lib/reviewos/overlays/41.ext4'])
    expect(config.vsock).toBeUndefined()
    expect(JSON.stringify(config)).not.toContain('storage/repos')
  })
})

describe('the ceilings', () => {
  test('are the machine\'s, not a request the guest makes', () => {
    const built = spec({ vcpus: 4, memoryMib: 4096 })

    expect(built.vcpus).toBe(4)
    expect((firecrackerConfig(built) as any)['machine-config']).toEqual({
      vcpu_count: 4,
      mem_size_mib: 4096,
      smt: false,
    })
  })

  test('and a workflow asking for the host gets the ceiling instead', () => {
    /*
     * The caller assembling this is reading a workflow file, which is somebody
     * else's document. A memory figure taken from it unclamped is a workflow
     * that asks for the host's memory and receives it.
     */
    expect(spec({ vcpus: 512 }).vcpus).toBeLessThanOrEqual(16)
    expect(spec({ memoryMib: 1_000_000 }).memoryMib).toBeLessThanOrEqual(32768)
    expect(spec({ wallSeconds: 999_999 }).wallSeconds).toBeLessThanOrEqual(21600)
  })

  test('and nonsense falls back to the default rather than to nothing', () => {
    // A ceiling of zero would be a machine that cannot boot, which is the wrong
    // direction to guess in when the input is malformed.
    expect(spec({ vcpus: 0 }).vcpus).toBe(DEFAULT_VCPUS)
    expect(spec({ memoryMib: -1 }).memoryMib).toBe(DEFAULT_MEMORY_MIB)
    expect(spec({ memoryMib: 'lots' }).memoryMib).toBe(DEFAULT_MEMORY_MIB)
  })
})

describe('the guest kernel', () => {
  test('cannot sit at a prompt holding a slot in the fleet', () => {
    // `panic=-1` ends the machine instead of waiting, and `reboot=k` makes a
    // guest-initiated reboot a shutdown rather than a second run inside one
    // machine.
    expect(bootArgs()).toContain('panic=-1')
    expect(bootArgs()).toContain('reboot=k')
  })

  test('hands control to the agent, which is the whole point of booting', () => {
    /*
     * This is a regression from phase B rather than a guess. The command line
     * omitted `init=` entirely, so a machine built from it booted the right
     * kernel, mounted the right read-only root, and then ran the *image's*
     * default init instead of the agent - silently, with every marker the test
     * looked for simply absent.
     */
    expect(bootArgs()).toContain('init=/sbin/reviewos-agent')
    expect(bootArgs('/init')).toContain('init=/init')
    expect(spec({ init: '/init' }).kernel.bootArgs).toContain('init=/init')
  })

  test('and says nothing Firecracker will say itself', () => {
    /*
     * Firecracker appends `root=`, `ro` and `pci=off` from the drive list - it
     * knows which drive is the root and whether it is read-only. Saying it again
     * produced a command line carrying `ro` and `pci=off` twice, which is
     * harmless and is the signature of somebody guessing.
     */
    expect(bootArgs()).not.toContain('root=')
    expect(bootArgs()).not.toMatch(/\bro\b/)
    expect(bootArgs()).not.toContain('pci=off')
  })

  test('and nothing that only means something on x86', () => {
    // `noapic` and the `i8042` options were carried for a machine this has never
    // run on. The host it was verified against is aarch64.
    for (const x86 of ['noapic', 'i8042'])
      expect(bootArgs()).not.toContain(x86)
  })
})

describe('the network device', () => {
  test('is named per job, within what Linux accepts', () => {
    // Linux caps an interface name at 15 characters, and a name silently
    // truncated is two jobs sharing a device.
    expect(tapDeviceFor(41).length).toBeLessThanOrEqual(15)
    expect(tapDeviceFor(999_999_999_999).length).toBeLessThanOrEqual(15)
    expect(tapDeviceFor(41)).not.toBe(tapDeviceFor(42))
  })

  test('and the MAC is locally administered, so it cannot collide with hardware', () => {
    expect(guestMacFor(41).startsWith('02:')).toBe(true)
    expect(guestMacFor(41)).not.toBe(guestMacFor(42))
    expect(guestMacFor(41)).toMatch(/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/)
  })

  test('and the policy travels with the machine rather than being applied later', () => {
    // The guest cannot reconfigure what the host filters, which is the whole
    // difference between an egress policy and a request that the guest behave.
    expect(spec().network.policy.mode).toBe('deny')
  })
})

describe('what the run records', () => {
  test('is the digest of the image that executed it', () => {
    // "A run records exactly what executed it" - by digest, because a tag is a
    // name somebody can move afterwards.
    expect(spec().imageDigest).toBe('sha256:abc')
  })
})

describe('the ceilings a guest cannot raise', () => {
  test('are the machine\'s, and a guest reads them as its hardware', () => {
    /*
     * Verified on real KVM rather than asserted: a machine given two vcpus and
     * 512 MiB reported `nproc=2` and a `MemTotal` of about 485 MB. A guest cannot
     * ask for a seventeenth core, which is what "enforced outside the job" means
     * and what `ulimit` never was.
     */
    const built = spec({ vcpus: 2, memoryMib: 512 })

    expect((firecrackerConfig(built) as any)['machine-config']).toEqual({
      vcpu_count: 2,
      mem_size_mib: 512,
      smt: false,
    })
  })

  test('and the writable layer is a fixed size, so filling it is ENOSPC rather than the host\'s disk', () => {
    // A 2048 MiB overlay refused a 4 GiB write at about 1.9 GB, and the host's
    // free space did not move.
    expect(spec({ diskMib: 2048 }).diskMib).toBe(2048)
  })

  test('and a disk too small to hold a checkout is raised rather than honoured', () => {
    /*
     * The floor exists because the payload disk carries the repository as well as
     * whatever the job writes, and a 64 MiB overlay is a machine that cannot
     * check out. Worth stating because a request for less is silently raised.
     */
    expect(spec({ diskMib: 64 }).diskMib).toBe(1024)
  })
})

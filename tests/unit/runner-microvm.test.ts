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

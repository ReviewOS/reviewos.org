// Which image a job booted, and how much the record is worth.
//
// The roadmap's line carries two claims - pinned, and attestable - and they are
// very different in strength. These tests hold the line between them: the
// pinning is real and enforced here, and the attestation is deliberately labelled
// `asserted`, because a runner telling the instance what it booted is not the
// instance knowing.

import { describe, expect, test } from 'bun:test'
import {
  executionRecord,
  missingToolchains,
  refusalForImage,
  refusalForManifest,
} from '../../app/Actions/Runner/vmImage'

const digest = `sha256:${'a'.repeat(64)}`
const kernel = `sha256:${'b'.repeat(64)}`

const manifest = {
  name: 'ubuntu-24.04',
  digest,
  kernelDigest: kernel,
  toolchains: { bun: '1.3.14', node: '22.11.0' },
  builtAt: '2026-08-01T00:00:00Z',
}

describe('pinning', () => {
  test('a digest is a pin', () => {
    expect(refusalForImage(digest)).toBeNull()
  })

  test('and a tag is not, however specific it looks', () => {
    /*
     * The whole point. `base:24.04` reads like a version and is a name somebody
     * can move afterwards - so a run that recorded it recorded nothing that can
     * be checked later.
     */
    expect(refusalForImage('ubuntu:24.04')).toContain('not a pin')
    expect(refusalForImage('ubuntu:latest')).toContain('moving tag')
    expect(refusalForImage('latest')).toContain('moving tag')
    expect(refusalForImage('')).toContain('has to be named')
  })

  test('and the kernel is pinned separately, because the image does not contain it', () => {
    /*
     * A microVM boots a kernel the host supplies. An image digest says nothing
     * about it, so two runs on one image and two kernels are two different
     * machines - and the kernel is usually the one that matters.
     */
    expect(refusalForManifest(manifest)).toBeNull()
    expect(refusalForManifest({ ...manifest, kernelDigest: 'vmlinux-6.1' }))
      .toContain('kernel has to be pinned')
  })
})

describe('what the run records', () => {
  test('is the digest, the kernel, and what was installed', () => {
    const record = executionRecord(manifest)

    expect(record.imageDigest).toBe(digest)
    expect(record.kernelDigest).toBe(kernel)
    expect(record.toolchains.bun).toBe('1.3.14')
  })

  test('and says plainly that the runner asserted it', () => {
    /*
     * The honest half. Recording a digest proves what this runner *said* it
     * booted; proving what it *did* needs a measurement it cannot forge, which
     * needs the hypervisor and the hardware.
     *
     * `provenance` exists now so that adding `measured` later does not silently
     * upgrade the meaning of every row written before it.
     */
    expect(executionRecord(manifest).provenance).toBe('asserted')
  })

  test('and copies the toolchains rather than sharing them', () => {
    // A record that aliased the manifest would change when the manifest did,
    // which is the opposite of a record.
    const record = executionRecord(manifest)

    ;(record.toolchains as any).bun = 'tampered'

    expect(manifest.toolchains.bun).toBe('1.3.14')
  })
})

describe('what a workflow asked for', () => {
  test('is matched exactly, not approximately', () => {
    /*
     * A workflow that says `1.3.14` and is given `1.3.15` got something it did
     * not ask for - and "close enough" is precisely what produces a build that
     * passes here and fails elsewhere.
     */
    expect(missingToolchains(manifest, { bun: '1.3.14' })).toEqual([])
    expect(missingToolchains(manifest, { bun: '1.3.15' })).toEqual([
      { name: 'bun', wanted: '1.3.15', found: '1.3.14' },
    ])
  })

  test('and something absent is reported as absent rather than as a mismatch', () => {
    expect(missingToolchains(manifest, { python: '3.12' })).toEqual([
      { name: 'python', wanted: '3.12', found: null },
    ])
  })
})

describe('measuring what is actually there', () => {
  async function withFile(bytes: string, run: (path: string) => Promise<void>) {
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')

    const root = mkdtempSync(join(tmpdir(), 'reviewos-measure-'))
    const path = join(root, 'image.ext4')

    writeFileSync(path, bytes)

    try {
      await run(path)
    }
    finally {
      rmSync(root, { recursive: true, force: true })
    }
  }

  test('a digest is computed from the bytes, not taken on trust', async () => {
    const { measureFile, forgetMeasurements } = await import('../../app/Actions/Runner/vmImage')

    forgetMeasurements()

    await withFile('hello', async (path) => {
      const found = await measureFile(path)
      const expected = `sha256:${new Bun.CryptoHasher('sha256').update('hello').digest('hex')}`

      expect(found).toBe(expected)
    })
  })

  test('and a file that is not there measures to nothing rather than throwing', async () => {
    const { measureFile } = await import('../../app/Actions/Runner/vmImage')

    expect(await measureFile('/no/such/image.ext4')).toBeNull()
  })

  test('and a rebuilt file is measured again rather than remembered', async () => {
    /*
     * The memo exists because hashing a gigabyte per job is a minute per build,
     * and its risk is staleness: an image rebuilt in place under the same path
     * is one of the two failures this whole check exists to catch, so the key
     * carries size and modification time rather than the path alone.
     */
    const { measureFile, forgetMeasurements } = await import('../../app/Actions/Runner/vmImage')
    const { writeFileSync, utimesSync } = await import('node:fs')

    forgetMeasurements()

    await withFile('first', async (path) => {
      const before = await measureFile(path)

      writeFileSync(path, 'second-and-longer')
      utimesSync(path, new Date(Date.now() + 5000), new Date(Date.now() + 5000))

      expect(await measureFile(path)).not.toBe(before)
    })
  })
})

describe('the pin, checked against the bytes', () => {
  async function pinned(imageBytes: string, claimed: string) {
    const { verifyPinned, measureFile, forgetMeasurements } = await import('../../app/Actions/Runner/vmImage')
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')

    forgetMeasurements()

    const root = mkdtempSync(join(tmpdir(), 'reviewos-pin-'))
    const image = join(root, 'base.ext4')
    const kernel = join(root, 'vmlinux')

    writeFileSync(image, imageBytes)
    writeFileSync(kernel, 'kernel-bytes')

    try {
      const real = await measureFile(image)

      return {
        result: await verifyPinned({
          imagePath: image,
          imageDigest: claimed === 'REAL' ? String(real) : claimed,
          kernelPath: kernel,
          kernelDigest: '',
        }),
        real,
      }
    }
    finally {
      rmSync(root, { recursive: true, force: true })
    }
  }

  test('passes, and says it measured rather than assumed', async () => {
    const { result } = await pinned('the image', 'REAL')

    expect(result.ok).toBe(true)
    expect(result.ok && result.provenance).toBe('measured')
  })

  test('and refuses an image that is not the one that was pinned', async () => {
    /*
     * The failure that actually happens, and nobody is lying when it does: an
     * image rebuilt in place, a path pointing at last month's file, a digest
     * copied from the wrong line of a build log. Before this the digest was a
     * string in a configuration file that was never compared to anything, so a
     * runner could boot one image and report another with nothing noticing.
     */
    const { result } = await pinned('the image', `sha256:${'b'.repeat(64)}`)

    expect(result.ok).toBe(false)
    expect(!result.ok && result.reason).toContain('not the')
    expect(!result.ok && result.reason).toContain('did not execute it')
  })

  test('and refuses rather than warns, because a wrong record is worse than none', async () => {
    // A warning would leave a run recording a digest that is checkable and wrong,
    // which is worse than a run recording nothing at all.
    const { result } = await pinned('the image', `sha256:${'c'.repeat(64)}`)

    expect(result.ok).toBe(false)
  })
})

describe('what a run says about the machine', () => {
  test('names the provenance rather than implying it', async () => {
    /*
     * `measured` means this runner hashed the bytes it booted. It is not the same
     * claim as hardware having signed them, and a log that let a reader confuse
     * the two would be the weakest level being read as the strongest.
     */
    const { machineRecord } = await import('../../app/Actions/Runner/microvmRun')

    const measured = machineRecord('measured')
    const asserted = machineRecord('asserted')

    expect(measured).toContain('provenance: measured')
    expect(measured).toContain('hashed the bytes it booted')

    expect(asserted).toContain('provenance: asserted')
    expect(asserted).toContain('nobody checked')
  })

  test('and says so when the kernel was never pinned', async () => {
    // An operator who pinned only the image pinned half of what ran.
    const { machineRecord } = await import('../../app/Actions/Runner/microvmRun')

    expect(machineRecord('measured')).toContain('kernel: not pinned')
  })
})

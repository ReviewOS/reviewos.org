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

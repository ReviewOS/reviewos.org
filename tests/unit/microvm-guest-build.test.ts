/**
 * The image's contract, which until now was written down and checked nowhere.
 *
 * `docs/ci-execution-plane.md` listed this exactly: "what an image must contain
 * - an agent at `/sbin/reviewos-agent`, a `/work` mount point - is written here
 * and enforced nowhere." An image that satisfies the prose and not the code
 * fails at boot, in the one place with no debugger: the kernel hands control to
 * a path that is not there, and the host sees a machine that stopped without
 * the agent reporting.
 *
 * These are cheap string assertions against the build script on purpose. The
 * expensive version is booting the thing, which `tests/e2e/microvm-egress.test.ts`
 * does on a machine with KVM; this is what catches the mismatch before anybody
 * spends twelve minutes of CI finding out.
 */

import { describe, expect, test } from 'bun:test'
import { DEFAULT_INIT } from '../../app/Actions/Runner/microvm'
import { measureFile } from '../../app/Actions/Runner/vmImage'
import { guestAgent } from '../../app/Actions/Runner/microvmProtocol'

const script = await Bun.file('scripts/microvm/build-guest.sh').text()

describe('the guest build script', () => {
  test('installs the agent at the path the kernel is told to run', () => {
    /*
     * `bootArgs()` passes `init=/sbin/reviewos-agent`, and a kernel given an
     * init that does not exist panics. The two values have no reason to agree
     * other than somebody keeping them in step, which is what this is for.
     */
    expect(script).toContain(`$TREE${DEFAULT_INIT}`)
  })

  test('creates the mount points a read-only root cannot create later', () => {
    /*
     * The agent mounts /proc, /sys, a tmpfs on /tmp and the payload disk on
     * /work. `mount` onto a directory that does not exist fails, and the agent
     * suppresses that error deliberately - so the symptom of a missing /work is
     * not an error, it is a job whose steps are all "no such file".
     */
    for (const directory of ['proc', 'sys', 'tmp', 'work'])
      expect(script).toContain(`"$TREE/${directory}"`)
  })

  test('takes the agent from the protocol source rather than writing its own', () => {
    /*
     * The one rule that keeps the image honest: the agent is whatever
     * `guestAgent()` says, because the host parses what `guestAgent()` emits. A
     * script that wrote its own copy would be a second source of truth for a
     * wire format, and the failure mode is an image that boots, runs the job,
     * and reports nothing the host can read.
     */
    expect(script).toContain('write-agent.ts')
    expect(script).not.toContain('#!/bin/sh\n# The ReviewOS guest agent')
  })

  test('emits digests in the shape the verifier actually compares', async () => {
    /*
     * `verifyPinned` compares against `measureFile`, which returns
     * `sha256:<hex>` and compares the whole string. Emitting the bare hex
     * produced the best error message of this exercise - "the guest image ... is
     * `sha256:01c74106...`, not the `01c74106...` this runner was told to boot" -
     * with the two hashes identical and the prefix the entire difference.
     *
     * Measured from a real file rather than asserted as a literal, so a change
     * to that format is caught here instead of at boot.
     */
    const real = await measureFile('package.json')

    expect(real).toStartWith('sha256:')
    expect(script).toContain('KERNEL_DIGEST="sha256:$(')
    expect(script).toContain('IMAGE_DIGEST="sha256:$(')
  })

  test('builds the same image twice from the same inputs', () => {
    /*
     * Two CI runs over identical pinned downloads produced two different image
     * digests, because mke2fs stamps a random UUID, a random directory hash
     * seed and the current time into the superblock. On an ordinary disk that
     * is invisible; here the digest is the claim the whole mode rests on, and
     * one that changes when nothing did cannot be checked against a published
     * one.
     */
    expect(script).toContain('SOURCE_DATE_EPOCH=0')
    expect(script).toContain('-U "$GUEST_UUID"')
    expect(script).toContain('-E hash_seed="$GUEST_UUID"')
  })

  test('every pinned digest is a whole sha256', () => {
    /*
     * A truncated hash still looks like a hash. This is the guard against a
     * paste that lost its tail, which would fail at build time with "does not
     * match its pinned digest" and read like a tampered download.
     */
    const pinned = [...script.matchAll(/^\s+(kernel|alpine)-\w+\) echo ([0-9a-f]+) ;;$/gm)]

    expect(pinned.length).toBe(4)

    for (const [, , digest] of pinned)
      expect(digest).toHaveLength(64)
  })

  test('keeps everything but the env block off stdout', () => {
    /*
     * `--env` is meant to be eval'd, so anything else on that stream is eval'd
     * with it. `mke2fs -q` is quieter than `mke2fs` and not silent - it still
     * announces "Creating filesystem with 16384 4k blocks" - and the first CI
     * run of this died with "Creating: command not found".
     *
     * The fix is not per-command silencing, which would hold until the next
     * tool decided to say something. The script moves its own stdout to stderr
     * and hands the env block the real one on fd 3, so the stream carries the
     * env or nothing.
     */
    expect(script).toContain('exec 3>&1')
    expect(script).toContain('exec 1>&2')
    expect(script).toContain('cat >&3 <<ENV')
  })

  test('pins both architectures, because the runner and the author do not share one', () => {
    /*
     * The design was built and verified on aarch64, and the only CI this
     * project has is x86_64 - GitHub's nested virtualization is x86_64 only.
     * An image pipeline that served one of them would leave the other where
     * this started.
     */
    for (const arch of ['x86_64', 'aarch64']) {
      expect(script).toContain(`kernel-${arch}`)
      expect(script).toContain(`alpine-${arch}`)
    }
  })
})

describe('the agent it installs', () => {
  test('is the one the host knows how to read', async () => {
    const written = await Bun.$`bun scripts/microvm/write-agent.ts`.quiet().text()

    expect(written).toBe(guestAgent())
  })

  test('runs every program the image actually ships', () => {
    /*
     * Alpine's minirootfs is busybox and little else, and the build adds no
     * packages - that is what keeps it a tarball plus one file, with no chroot
     * and no network beyond two pinned downloads. So the agent may only use
     * what busybox provides, and this is the list that was checked against the
     * tarball: mount, stty, ip, base64, poweroff, wc, head, cat, rm.
     *
     * `wget` is in there too, which the egress tests' steps use to try to reach
     * somewhere they should not.
     */
    const agent = guestAgent()

    for (const program of ['mount', 'stty', 'ip ', 'base64', 'poweroff', 'wc ', 'head ', 'cat ', 'rm '])
      expect(agent).toContain(program)
  })
})

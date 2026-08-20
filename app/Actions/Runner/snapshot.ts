/**
 * The runner's half of dependency caching: making the archive, and unpacking it.
 *
 * The instance decides *which* snapshot ([`cache.ts`](../Workflow/cache.ts));
 * this decides what goes in one. The split matters because the scope rules are
 * a security boundary and this file runs on a machine executing somebody's
 * build - a runner that could choose its own scope would be a pull request that
 * could write the default branch's cache.
 *
 * ## Why `tar` and not a tar written here
 *
 * There is a tar builder in this repository already
 * ([`Artifact/tar.ts`](../Artifact/tar.ts)) and it is the wrong tool for this:
 * it builds in memory, truncates names past 99 characters, and knows nothing
 * about symlinks or permissions. A `node_modules` is fifty thousand files deep,
 * full of symlinked binaries whose executable bit is the difference between a
 * cache that works and a build that cannot run its own linter. The system `tar`
 * handles all of that, every machine that runs CI has one, and its own comment
 * in that file says as much.
 *
 * ## What a snapshot contains
 *
 * The workspace, minus the checkout it was restored on top of. That is the
 * roadmap's primitive - *"a snapshot of the workspace after `install`, rather
 * than a keyed archive of a named directory"* - and it is the better one
 * because nobody has to know which paths their package manager writes to. Every
 * `actions/cache` bug report is somebody who got that list wrong.
 *
 * In practice "minus the checkout" is done by exclusion rather than by diffing:
 * `.git` and the runner's own directory are left out, and everything the
 * checkout wrote is already in the repository, so restoring over a fresh
 * checkout is a no-op for those files. Diffing the tree would be more precise
 * and would cost a stat of every file to save bytes on files that compress to
 * nothing.
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import process from 'node:process'
import { join } from 'node:path'
import { lockfileDigest, LOCKFILE_NAMES, snapshotKey } from '../Workflow/cacheKey'
import { firstUnsafe } from './archiveSafety'

/** Directories that never belong in a snapshot, whatever else is in the workspace. */
export const NEVER_SNAPSHOT = ['.git', '.reviewos-runner'] as const

export interface SnapshotResult {
  ok: boolean
  path?: string
  digest?: string
  sizeBytes?: number
  reason?: string
}

/**
 * The lockfiles in a workspace, by digest.
 *
 * Top level only, deliberately. A recursive search finds the lockfiles of every
 * vendored example and test fixture in the repository, and a key that changes
 * when a fixture does is a cache that never hits - which from the outside is
 * indistinguishable from caching being broken. A monorepository whose real
 * lockfile is one directory down says so with the workflow's own `extra` input
 * rather than by making every repository pay for a walk.
 */
export function lockfilesIn(workspace: string): Record<string, string> {
  const found: Record<string, string> = {}

  for (const name of LOCKFILE_NAMES) {
    const path = join(workspace, name)

    if (!existsSync(path))
      continue

    try {
      found[name] = lockfileDigest(readFileSync(path))
    }
    catch {
      // Unreadable is not the same as absent, and the difference matters: a
      // file that is there and cannot be read should not silently produce the
      // key of a repository that does not have it.
      found[name] = 'unreadable'
    }
  }

  return found
}

/** The key for this workspace, on this machine, for this job. */
export function keyFor(workspace: string, facts: { runtime?: string | null, image?: string | null, extra?: readonly string[] }): string {
  return snapshotKey({
    lockfiles: lockfilesIn(workspace),
    runtime: facts.runtime ?? null,
    architecture: process.arch,
    image: facts.image ?? null,
    extra: facts.extra ?? [],
  })
}

/**
 * Whether a workspace has anything worth snapshotting.
 *
 * A job with no lockfile at all is a job whose cache would be keyed on nothing
 * and would hit for every unrelated run of the repository - restoring one
 * build's leftovers into another's workspace. So the absence of a lockfile
 * turns caching off rather than producing a key that means "any job here".
 */
export function worthCaching(workspace: string): boolean {
  return Object.keys(lockfilesIn(workspace)).length > 0
}

/**
 * Pack the workspace into an archive beside it.
 *
 * Compressed with gzip rather than zstd: `tar -z` is present on every machine
 * that has tar, and `--zstd` is not. The trade is a few seconds of CPU against
 * a runner that cannot cache at all on a base image from before 2021.
 */
export async function packSnapshot(workspace: string, into: string): Promise<SnapshotResult> {
  const excludes = NEVER_SNAPSHOT.flatMap(name => ['--exclude', `./${name}`])

  const packed = Bun.spawn(['tar', '-czf', into, ...excludes, '-C', workspace, '.'], {
    stdout: 'pipe',
    stderr: 'pipe',
  })

  const failure = await new Response(packed.stderr).text()
  const status = await packed.exited

  if (status !== 0)
    return { ok: false, reason: `tar exited ${status}: ${failure.slice(0, 400)}` }

  if (!existsSync(into))
    return { ok: false, reason: 'tar reported success and wrote nothing' }

  return {
    ok: true,
    path: into,
    sizeBytes: statSync(into).size,
    digest: await digestOfFile(into),
  }
}

/**
 * Unpack an archive over a workspace.
 *
 * Over rather than into an empty directory: the checkout is already there, and
 * a snapshot that replaced it would throw away the commit this run is meant to
 * be testing. Files in both win from the archive, which is what "restored as
 * the starting state" means - an install that patched a checked-in file stays
 * patched.
 *
 * `-p` keeps permissions, because the executable bit on `node_modules/.bin/*`
 * is the difference between a restored cache and a build that cannot run its
 * own tools.
 */
export async function unpackSnapshot(archive: string, workspace: string): Promise<{ ok: boolean, reason?: string }> {
  /*
   * Inspected before a byte is written.
   *
   * An archive is a thing a previous run produced, and unpacking one is where a
   * run stops deciding what lands on its disk. `../` escapes the workspace and
   * a symlink pointing outside escapes it more quietly - `link -> /etc` and
   * then `link/passwd`, which is two ordinary-looking entries.
   *
   * Refused here rather than left to tar, because "tar" is two programs whose
   * defences differ by version and flag. This codebase has been bitten by that
   * shape once already: `ulimit -S -H` meant what it looked like in bash and
   * set nothing at all in dash.
   */
  const unsafe = await inspectSnapshot(archive)

  if (unsafe)
    return { ok: false, reason: `the snapshot was refused: ${unsafe.reason}` }

  const unpacked = Bun.spawn(['tar', '-xzpf', archive, '-C', workspace], { stdout: 'pipe', stderr: 'pipe' })

  const failure = await new Response(unpacked.stderr).text()
  const status = await unpacked.exited

  if (status !== 0)
    return { ok: false, reason: `tar exited ${status}: ${failure.slice(0, 400)}` }

  return { ok: true }
}

/**
 * Read the archive's index twice and ask whether it may be unpacked.
 *
 * Twice because the two listings answer different halves and neither answers
 * both portably: `-tzf` gives the paths, one per line, spelled identically by
 * every tar; `-tvzf` gives the type and a link's target, in columns the two
 * tars lay out differently. Zipped by index in `archiveSafety.ts`, so nothing
 * has to know where a column starts.
 *
 * Cheap: both read the index rather than the contents, so a gigabyte of
 * `node_modules` is not decompressed to find out whether it is allowed to be.
 *
 * A tar that cannot list the archive at all refuses it. An archive this runner
 * cannot read is one it certainly should not unpack.
 */
export async function inspectSnapshot(archive: string): Promise<{ path: string, reason: string } | null> {
  const names = Bun.spawn(['tar', '-tzf', archive], { stdout: 'pipe', stderr: 'pipe' })
  const namesText = await new Response(names.stdout).text()

  if (await names.exited !== 0)
    return { path: '', reason: 'its index could not be read' }

  const verbose = Bun.spawn(['tar', '-tvzf', archive], { stdout: 'pipe', stderr: 'pipe' })
  const verboseText = await new Response(verbose.stdout).text()

  if (await verbose.exited !== 0)
    return { path: '', reason: 'its index could not be read' }

  return firstUnsafe(namesText, verboseText)
}

/**
 * SHA-256 of an archive, lower case hex - the address the instance stores it at.
 *
 * Streamed rather than read.
 *
 * A snapshot may be a gigabyte. Reading one into memory to hash it would put a
 * gigabyte on the heap of a process that is also running somebody's build, on a
 * machine chosen for cheapness - which is how a runner gets killed by the OOM
 * killer while doing the one thing that was meant to make the next job faster.
 */
export async function digestOfFile(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher('sha256')

  for await (const chunk of Bun.file(path).stream())
    hasher.update(chunk)

  return hasher.digest('hex')
}

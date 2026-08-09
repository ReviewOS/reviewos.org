/**
 * Running git.
 *
 * The system git binary does the git work. It is a declared pantry dependency,
 * it is the reference implementation, and no TypeScript reimplementation of
 * packfile handling is going to be more correct than it is.
 *
 * Arguments are always passed as an array, never a shell string, so a branch
 * called `; rm -rf /` is a branch name and not a command. Nothing in this file
 * builds a shell command.
 */

import { observeGit } from '../../Ops/metrics'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

export interface GitResult {
  ok: boolean
  stdout: string
  stderr: string
  code: number
}

/**
 * Refs that git will not let you write, and that this application will not ask
 * it to. Passing one through would be a way to rewrite history out of band.
 */
const REF_PATTERN = /^[A-Za-z0-9._\-/]+$/

/** Whether a ref name is one we are willing to hand to git. */
export function isSafeRef(ref: string): boolean {
  if (ref.length === 0 || ref.length > 255)
    return false

  // git's own rules, the parts that matter here: no `..`, no leading or
  // trailing slash, no `@{`, no control characters.
  if (ref.includes('..') || ref.startsWith('/') || ref.endsWith('/') || ref.includes('@{'))
    return false

  if (ref.startsWith('-'))
    return false

  return REF_PATTERN.test(ref)
}

/**
 * A commit-ish: a full or abbreviated SHA, or a ref name.
 *
 * Anything handed to `git show`/`git diff` goes through this, because those
 * commands take options that start with `-` and a user-supplied value that
 * looks like one would become a flag.
 */
export function isSafeRevision(revision: string): boolean {
  if (revision.length === 0 || revision.length > 255)
    return false

  if (revision.startsWith('-'))
    return false

  return /^[A-Za-z0-9._\-/^~]+$/.test(revision)
}

/** Whether a string is a full 40-character hex SHA. */
export function isFullSha(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value)
}

/**
 * The `PATH` a git child process gets.
 *
 * `deps.yaml` declares the binaries this application runs - git, and gnupg for
 * signature verification - and pantry installs them into `<project>/pantry`,
 * with `pantry/.bin` holding the symlinks. A shell picks that up on `cd`,
 * through pantry's hook. **Nothing else does.** A systemd unit, a Docker
 * `CMD`, a launchd job, a `bun test` run - none of them have been anywhere, so
 * none of them see it.
 *
 * The symptom is not an error. `git verify-commit` answers `cannot run gpg: No
 * such file or directory`, which this reads as `unavailable`, which the
 * interface reports as "this server could not check the signature" - on a
 * machine where the dependency is installed, declared, and sitting on disk.
 * Every signature reads as unverified and nothing anywhere says why.
 *
 * So the path is put back here rather than left to the environment: the process
 * should not have to have been started from the right directory to find the
 * binaries the project declares.
 *
 * **Appended, not prepended,** and that is a deliberate retreat from the
 * obvious version. Putting it first makes the declared git win over the host's,
 * which sounds better and is a much larger change than the one this is for -
 * and it broke three of the wire-protocol tests, in a way not yet run down.
 * Appending fills a gap rather than taking a decision away: whatever the host
 * already resolves keeps resolving exactly as it did, and a binary it does not
 * have at all - gpg, here - is found in the project instead of not at all.
 */
export function dependencyPath(root = process.cwd()): string | null {
  const bin = resolve(root, 'pantry/.bin')

  return existsSync(bin) ? bin : null
}

/** The environment every git child gets: no prompts, no host config, our binaries. */
export function gitEnvironment(extra: Record<string, string> = {}): Record<string, string> {
  const bin = dependencyPath()
  const path = bin ? `${process.env.PATH ?? ''}:${bin}` : process.env.PATH

  return {
    ...process.env as Record<string, string>,
    ...(path ? { PATH: path } : {}),
    ...extra,
    // Never let a repository's own config change how we read it, and never let
    // git prompt: a hung credential prompt would hold the request open.
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
  }
}

/**
 * Run git in a repository and collect its output.
 *
 * For anything whose output can be large (a packfile, an archive) use
 * `spawnGit` instead and stream it: buffering a packfile is how this falls over
 * on a real repository, and it will pass every test written against a small one.
 */
export async function runGit(repositoryPath: string, args: string[], options: {
  input?: string
  timeoutMs?: number
  env?: Record<string, string>
} = {}): Promise<GitResult> {
  const { input, timeoutMs = 30_000, env = {} } = options

  /*
   * Timed, because git is where this product spends its time and a forge that
   * has become slow is almost always a forge whose git calls have.
   *
   * The *subcommand* is the label - `diff`, `rev-parse`, `merge-base` - and not
   * the arguments. Arguments carry branch names and paths, so labelling with
   * them would produce a new time series per branch, which is the cardinality
   * explosion that takes a scraper down.
   */
  const startedNs = Bun.nanoseconds()
  const subcommand = String(args.find(argument => !argument.startsWith('-')) ?? 'unknown')

  return await new Promise<GitResult>((resolvePromise) => {
    const child = spawn('git', ['--git-dir', repositoryPath, ...args], { env: gitEnvironment(env) })

    const record = () => {
      try {
        observeGit(subcommand, (Bun.nanoseconds() - startedNs) / 1_000_000_000)
      }
      catch {
        // A measurement must never fail the thing it measures.
      }
    }

    let stdout = ''
    let stderr = ''
    let settled = false

    const timer = setTimeout(() => {
      if (!settled) {
        child.kill('SIGKILL')
        settled = true
        // Timed out is a duration too, and the most interesting one: it is
        // what a histogram's overflow bucket is for.
        record()
        resolvePromise({ ok: false, stdout, stderr: `${stderr}\ngit timed out after ${timeoutMs}ms`, code: -1 })
      }
    }, timeoutMs)

    child.stdout.on('data', chunk => stdout += chunk)
    child.stderr.on('data', chunk => stderr += chunk)

    child.on('error', (error) => {
      if (settled)
        return
      settled = true
      clearTimeout(timer)
      record()
      resolvePromise({ ok: false, stdout, stderr: String(error), code: -1 })
    })

    child.on('close', (code) => {
      if (settled)
        return
      settled = true
      clearTimeout(timer)
      record()
      resolvePromise({ ok: code === 0, stdout, stderr, code: code ?? -1 })
    })

    if (input !== undefined) {
      child.stdin.write(input)
      child.stdin.end()
    }
  })
}

/**
 * Spawn git for streaming.
 *
 * The caller owns the streams. This is what the wire-protocol endpoints use, so
 * a clone of a large repository never sits in memory.
 */
export function spawnGit(repositoryPath: string, args: string[], env: Record<string, string> = {}) {
  return spawn('git', ['--git-dir', repositoryPath, ...args], { env: gitEnvironment(env) })
}

/** Create a bare repository. */
export async function initBare(repositoryPath: string, defaultBranch = 'main'): Promise<GitResult> {
  return await new Promise<GitResult>((resolvePromise) => {
    const child = spawn('git', ['init', '--bare', `--initial-branch=${defaultBranch}`, repositoryPath], {
      env: gitEnvironment(),
    })

    let stderr = ''
    child.stderr.on('data', chunk => stderr += chunk)
    child.on('error', error => resolvePromise({ ok: false, stdout: '', stderr: String(error), code: -1 }))
    child.on('close', code => resolvePromise({ ok: code === 0, stdout: '', stderr, code: code ?? -1 }))
  })
}

/**
 * Copy a bare repository, for a fork.
 *
 * Not through `runGit`, and that is the point: `runGit` prefixes `--git-dir`,
 * which `clone` reads as the repository it is cloning *into*, so a clone routed
 * through it writes the new repository over whichever repository was named. Its
 * own spawn here means the arguments say exactly what they mean.
 *
 * `--local` is what makes a fork cheap. Cloning from a path on the same
 * filesystem hardlinks the object store instead of copying it, so a fork of a
 * repository with a decade of history costs a directory of refs and takes no
 * meaningful time. Both paths are under `storage/repos`, so the condition
 * `--local` needs always holds.
 */
export async function cloneBare(from: string, to: string): Promise<GitResult> {
  return await new Promise<GitResult>((resolvePromise) => {
    const child = spawn('git', ['clone', '--bare', '--local', from, to], { env: gitEnvironment() })

    let stderr = ''
    child.stderr.on('data', chunk => stderr += chunk)
    child.on('error', error => resolvePromise({ ok: false, stdout: '', stderr: String(error), code: -1 }))
    child.on('close', code => resolvePromise({ ok: code === 0, stdout: '', stderr, code: code ?? -1 }))
  })
}

/**
 * Replay a range of commits onto a branch, and report where they landed.
 *
 * `git replay` is the only way to rebase in a bare repository: it works
 * entirely on objects, with no index and no checkout. Anything else would mean
 * checking out a copy of the repository on every merge.
 *
 * **It must never be allowed to move the ref itself, and making sure of that is
 * the whole reason this function exists.** Replay printed its update and
 * applied nothing until git 2.54, which made applying the default and printing
 * opt-in behind `--ref-action=print`. Both callers here had been written
 * against the old behavior, and under the new default:
 *
 * - the rebase merge strategy lost its compare-and-swap, so a push arriving
 *   mid-merge was overwritten rather than refused - and replay printed nothing,
 *   so the code then reported "the replay produced no commit" and the merge had
 *   already landed;
 * - restacking a stacked child pointed `--advance` at the *base* branch, on
 *   purpose, only ever wanting the sha it printed. Under the new default that
 *   moves `main` to the child's commits, with no merge, no review and no guard.
 *
 * So the flag is passed, the ref update is returned rather than applied, and
 * the caller writes it through a guarded `update-ref`. The fallback runs only
 * when git says it does not know the flag - never on a conflict, which would
 * trade a refusal for exactly the unguarded update this prevents.
 */
export async function replayOnto(
  repositoryPath: string,
  branchRef: string,
  range: string,
  env?: Record<string, string>,
): Promise<{ ok: boolean, sha: string | null, stderr: string }> {
  const advance = ['--advance', branchRef, range]

  let replayed = await runGit(repositoryPath, ['replay', '--ref-action=print', ...advance], { env })

  if (!replayed.ok && /unknown option|ref-action/i.test(replayed.stderr))
    replayed = await runGit(repositoryPath, ['replay', ...advance], { env })

  if (!replayed.ok)
    return { ok: false, sha: null, stderr: replayed.stderr }

  // Each line is `update <ref> <new> <old>`.
  const line = replayed.stdout.split('\n').find(candidate => candidate.startsWith('update '))
  const sha = line?.trim().split(/\s+/)[2] ?? null

  if (!sha || !isFullSha(sha))
    return { ok: false, sha: null, stderr: replayed.stderr }

  return { ok: true, sha, stderr: '' }
}

/**
 * The commit both refs descend from.
 *
 * This is what a pull request diffs against. Diffing against the base tip shows
 * every change made on the base since the branch left it, which is the single
 * most common way a review interface misleads a reviewer.
 */
export async function mergeBase(repositoryPath: string, a: string, b: string): Promise<string | null> {
  if (!isSafeRevision(a) || !isSafeRevision(b))
    return null

  const result = await runGit(repositoryPath, ['merge-base', a, b])
  if (!result.ok)
    return null

  const sha = result.stdout.trim()
  return isFullSha(sha) ? sha : null
}

/** Branch names, in the order git lists them. */
export async function listBranches(repositoryPath: string): Promise<string[]> {
  const result = await runGit(repositoryPath, ['for-each-ref', '--format=%(refname:short)', 'refs/heads'])
  if (!result.ok)
    return []

  return result.stdout.split('\n').map(line => line.trim()).filter(Boolean)
}

/** Whether a repository has any commits yet. */
export async function isEmpty(repositoryPath: string): Promise<boolean> {
  const result = await runGit(repositoryPath, ['rev-parse', '--verify', 'HEAD'])
  return !result.ok
}

/**
 * The argument list for a wire-protocol service.
 *
 * Extracted so it can be tested, because the mistake it exists to prevent is
 * invisible from the outside. `upload-pack` and `receive-pack` take the
 * repository as their own positional argument and resolve it themselves - they
 * do **not** read `--git-dir`. Passing `.` therefore makes them operate on the
 * server process's working directory, and everything still *works*: git speaks
 * the protocol correctly, the clone succeeds, the push succeeds. It is just the
 * wrong repository.
 *
 * That shipped here. A clone of any URL served the forge's own source, a clone
 * of a private repository served it too - the permission check passed on the
 * repository that was asked for, and a different one was handed over - and a
 * push wrote its refs into the application's checkout.
 */
export function serviceArgs(
  repositoryPath: string,
  service: 'upload-pack' | 'receive-pack',
  options: { advertiseRefs?: boolean, stateless?: boolean } = {},
): string[] {
  // `--stateless-rpc` is the HTTP framing, where each request carries one round
  // of the protocol and the process exits. Over SSH the process talks for the
  // life of the channel, which is the mode git was written for - and passing
  // the flag there produces a client that hangs waiting for a second round
  // nobody is going to send.
  const args = options.stateless === false ? [service] : [service, '--stateless-rpc']

  if (options.advertiseRefs)
    args.push('--advertise-refs')

  // The repository, named explicitly. Never `.`.
  args.push(repositoryPath)

  return args
}

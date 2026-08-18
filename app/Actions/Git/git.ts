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

import type { GitProcessClass } from './semaphore'
import { observeGit } from '../../Ops/metrics'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { acquireGitSlot } from './semaphore'

export interface GitResult {
  ok: boolean
  stdout: string
  stderr: string
  code: number
  /**
   * True when `maxBytes` stopped the read short. `ok` is still true: the
   * caller asked for at most that much and got it, and treating a budget as a
   * failure would make every bounded caller drop the bytes it budgeted for.
   */
  truncated?: boolean
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

/**
 * The identity git falls back to when the caller does not supply one.
 *
 * A forge writes commits nobody typed: a merge commit, a squash, the rebase
 * behind a stack landing. Those are the instance acting, not a person, and
 * until now they carried no identity at all - so git looked for one in
 * `~/.gitconfig` and the commit was attributed to whatever the *box* happened
 * to be configured with. On a box with no identity configured, which is every
 * fresh server and every CI runner, git refuses outright:
 *
 *     Committer identity unknown
 *
 * and the merge fails. The pull request stays open, the API answers as though
 * nothing went wrong, and the cause is a machine setting rather than anything
 * in the request. That is how "the parent landing rebases the child and the
 * cascade merges it" passed on every laptop and failed in CI.
 *
 * So the instance names itself. Anything that knows the real actor - a push, a
 * commit written on somebody's behalf - passes `GIT_AUTHOR_*` through `extra`
 * and overrides this; see `write.ts`. The fallback is the committer of last
 * resort, not a way to lose attribution.
 *
 * `.invalid` is reserved by RFC 2606 and can never be a real domain, which is
 * the right shape for an address that must never receive mail.
 */
const INSTANCE_IDENTITY = {
  GIT_AUTHOR_NAME: 'ReviewOS',
  GIT_AUTHOR_EMAIL: 'noreply@reviewos.invalid',
  GIT_COMMITTER_NAME: 'ReviewOS',
  GIT_COMMITTER_EMAIL: 'noreply@reviewos.invalid',
} as const

/** The environment every git child gets: no prompts, no host config, our binaries. */
export function gitEnvironment(extra: Record<string, string> = {}): Record<string, string> {
  const bin = dependencyPath()
  const path = bin ? `${process.env.PATH ?? ''}:${bin}` : process.env.PATH

  return {
    ...process.env as Record<string, string>,
    ...(path ? { PATH: path } : {}),
    // Before `extra`, so a caller that knows who is acting still wins.
    ...INSTANCE_IDENTITY,
    ...extra,
    // Never let a repository's own config change how we read it, and never let
    // git prompt: a hung credential prompt would hold the request open.
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
  }
}

/**
 * The most stdout `runGit` will hold, unless a caller budgets tighter.
 *
 * Ten mebibytes is far past anything a plumbing command legitimately answers
 * and far short of what fills a process: before this cap, the only bound was
 * the timeout, and a *fast* git - `log --patch` on a large repository, say -
 * fills memory long before a slow one hits thirty seconds.
 */
export const RUN_GIT_MAX_BYTES = 10 * 1024 * 1024

/**
 * Run git in a repository and collect its output.
 *
 * For anything whose output can be large (a packfile, an archive) use
 * `spawnGit` instead and stream it: buffering a packfile is how this falls over
 * on a real repository, and it will pass every test written against a small one.
 *
 * stdout is bounded by `maxBytes` (default `RUN_GIT_MAX_BYTES`): on breach the
 * child is SIGKILLed immediately - never read to completion and sliced after -
 * and the result carries what fit with `truncated: true` and `ok: true`. Both
 * streams are read as utf8, so a multibyte character spanning a chunk boundary
 * arrives whole rather than as replacement characters. stderr is always capped
 * at 64KB, same constant and same rationale as `diffStream.ts`.
 *
 * Every call holds a slot in its `priority` class (`semaphore.ts`) for the
 * child's lifetime. `interactive` unless the caller says otherwise; jobs and
 * scans pass `background` so a pile of them can never starve a page. When the
 * class stays saturated past the acquire timeout the result is a plain
 * failure naming the class - the caller was not going to get an answer from a
 * box in that state anyway.
 */
export async function runGit(repositoryPath: string, args: string[], options: {
  input?: string
  timeoutMs?: number
  env?: Record<string, string>
  maxBytes?: number
  priority?: GitProcessClass
} = {}): Promise<GitResult> {
  const { input, timeoutMs = 30_000, env = {}, maxBytes = RUN_GIT_MAX_BYTES, priority = 'interactive' } = options

  const releaseSlot = await acquireGitSlot(priority)

  if (!releaseSlot)
    return { ok: false, stdout: '', stderr: `git not started: too many concurrent ${priority} git processes`, code: -1 }

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
      // The slot is held exactly as long as the child could be running, and
      // `record` is called on every settle path. Release is idempotent.
      releaseSlot()

      try {
        observeGit(subcommand, (Bun.nanoseconds() - startedNs) / 1_000_000_000)
      }
      catch {
        // A measurement must never fail the thing it measures.
      }
    }

    let stdout = ''
    let stdoutBytes = 0
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

    // utf8 on both, so chunks arrive as strings through a StringDecoder and a
    // multibyte character split across a 64KB read boundary stays one
    // character. Coercing each Buffer chunk independently - what this did
    // before - turns that character into replacement characters.
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')

    child.stdout.on('data', (chunk: string) => {
      if (settled)
        return

      const bytes = Buffer.byteLength(chunk, 'utf8')

      if (stdoutBytes + bytes > maxBytes) {
        // Keep what fits of this chunk, then kill: the point of the budget is
        // that the allocation never happens, not that it is trimmed later. Cut
        // at the byte, then drop the replacement character a mid-character cut
        // leaves, so the kept text ends on a whole character.
        const budget = Math.max(0, maxBytes - stdoutBytes)
        stdout += Buffer.from(chunk, 'utf8').subarray(0, budget).toString('utf8').replace(/�+$/, '')
        settled = true
        clearTimeout(timer)
        child.kill('SIGKILL')
        record()
        resolvePromise({ ok: true, stdout, stderr, code: -1, truncated: true })

        return
      }

      stdoutBytes += bytes
      stdout += chunk
    })

    child.stderr.on('data', (chunk: string) => {
      // Bounded unconditionally, same constant as diffStream.ts: a repository
      // failing on every object would otherwise write its complaint into
      // memory until the request dies, for a message that only ever shows its
      // first few hundred bytes.
      if (stderr.length < 64_000)
        stderr += chunk
    })

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
 *
 * Prefer `spawnGitLimited`: this raw form holds no slot in the process
 * ceiling, and exists for it to build on.
 */
export function spawnGit(repositoryPath: string, args: string[], env: Record<string, string> = {}) {
  return spawn('git', ['--git-dir', repositoryPath, ...args], { env: gitEnvironment(env) })
}

/**
 * Spawn git for streaming, under the process ceiling.
 *
 * `spawnGit` with a slot: acquired before the spawn, released when the child
 * closes or fails to start, held the whole time in between. Returns `null`
 * when the class stays saturated past the acquire timeout - for a
 * wire-protocol route that is a 503 with `Retry-After`, which git clients
 * honor politely.
 */
export async function spawnGitLimited(
  processClass: GitProcessClass,
  repositoryPath: string,
  args: string[],
  env: Record<string, string> = {},
  acquireTimeoutMs?: number,
): Promise<ReturnType<typeof spawnGit> | null> {
  const release = await acquireGitSlot(processClass, acquireTimeoutMs)

  if (!release)
    return null

  const child = spawnGit(repositoryPath, args, env)

  // `close` rather than `exit`: the slot guards the whole process including
  // its output being read, and `close` is when the streams are done.
  child.on('close', release)
  child.on('error', release)

  return child
}

/** Create a bare repository. */
export async function initBare(repositoryPath: string, defaultBranch = 'main'): Promise<GitResult> {
  const releaseSlot = await acquireGitSlot('interactive')

  if (!releaseSlot)
    return { ok: false, stdout: '', stderr: 'git not started: too many concurrent interactive git processes', code: -1 }

  return await new Promise<GitResult>((resolvePromise) => {
    const child = spawn('git', ['init', '--bare', `--initial-branch=${defaultBranch}`, repositoryPath], {
      env: gitEnvironment(),
    })

    let stderr = ''
    child.stderr.on('data', chunk => stderr += chunk)
    child.on('error', (error) => {
      releaseSlot()
      resolvePromise({ ok: false, stdout: '', stderr: String(error), code: -1 })
    })
    child.on('close', (code) => {
      releaseSlot()
      resolvePromise({ ok: code === 0, stdout: '', stderr, code: code ?? -1 })
    })
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
  const releaseSlot = await acquireGitSlot('interactive')

  if (!releaseSlot)
    return { ok: false, stdout: '', stderr: 'git not started: too many concurrent interactive git processes', code: -1 }

  return await new Promise<GitResult>((resolvePromise) => {
    const child = spawn('git', ['clone', '--bare', '--local', from, to], { env: gitEnvironment() })

    let stderr = ''
    child.stderr.on('data', chunk => stderr += chunk)
    child.on('error', (error) => {
      releaseSlot()
      resolvePromise({ ok: false, stdout: '', stderr: String(error), code: -1 })
    })
    child.on('close', (code) => {
      releaseSlot()
      resolvePromise({ ok: code === 0, stdout: '', stderr, code: code ?? -1 })
    })
  })
}

/**
 * How long a mirror clone may run before it is killed.
 *
 * The mirror *fetch* path already allows fifteen minutes (`fetch.ts`), and a
 * first clone moves strictly more data than any fetch after it, so it gets the
 * same budget. The 30 second `runGit` default is tuned for plumbing commands
 * and would kill any non-trivial import mid-transfer.
 */
export const MIRROR_CLONE_TIMEOUT_MS = 15 * 60_000

/**
 * The argument list for a mirror clone, extracted so a test can assert what is
 * actually handed to git. The property under test is a negative one - no
 * `--git-dir` anywhere - and that is invisible from outside the spawn.
 */
export function mirrorCloneArgs(from: string, to: string): string[] {
  return ['clone', '--mirror', from, to]
}

/**
 * Clone a remote repository as a mirror, for imports.
 *
 * Not through `runGit`, for the same reason as `cloneBare` above: `runGit`
 * prepends `--git-dir`, which `clone` reads as the repository it is cloning
 * *into*, so a clone routed through it writes over whichever repository was
 * named. `--mirror` rather than `--bare` because an import wants every ref -
 * tags, and the remote's own branches - not a snapshot of the default branch.
 *
 * stderr is capped at 64KB (`diffStream.ts` sets the precedent): a remote that
 * prints progress for a million objects would otherwise buffer all of it for
 * an error message that only ever shows its first few hundred bytes.
 */
export async function mirrorClone(from: string, to: string, options: {
  timeoutMs?: number
} = {}): Promise<GitResult> {
  const { timeoutMs = MIRROR_CLONE_TIMEOUT_MS } = options

  // `background`: an import is a job, and four simultaneous mirror clones is
  // already a saturated network - the queue holds the rest.
  const releaseSlot = await acquireGitSlot('background')

  if (!releaseSlot)
    return { ok: false, stdout: '', stderr: 'git not started: too many concurrent background git processes', code: -1 }

  return await new Promise<GitResult>((resolvePromise) => {
    const child = spawn('git', mirrorCloneArgs(from, to), { env: gitEnvironment() })

    let stderr = ''
    let settled = false

    const timer = setTimeout(() => {
      if (settled)
        return
      settled = true
      child.kill('SIGKILL')
      releaseSlot()
      resolvePromise({ ok: false, stdout: '', stderr: `${stderr}\ngit clone timed out after ${timeoutMs}ms`, code: -1 })
    }, timeoutMs)

    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      if (stderr.length < 64_000)
        stderr += chunk
    })

    child.on('error', (error) => {
      if (settled)
        return
      settled = true
      clearTimeout(timer)
      releaseSlot()
      resolvePromise({ ok: false, stdout: '', stderr: String(error), code: -1 })
    })

    child.on('close', (code) => {
      if (settled)
        return
      settled = true
      clearTimeout(timer)
      releaseSlot()
      resolvePromise({ ok: code === 0, stdout: '', stderr, code: code ?? -1 })
    })
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

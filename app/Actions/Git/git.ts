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

import { spawn } from 'node:child_process'

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

  return await new Promise<GitResult>((resolvePromise) => {
    const child = spawn('git', ['--git-dir', repositoryPath, ...args], {
      env: {
        ...process.env,
        ...env,
        // Never let a repository's own config change how we read it, and never
        // let git prompt: a hung credential prompt would hold the request open.
        GIT_TERMINAL_PROMPT: '0',
        GIT_CONFIG_NOSYSTEM: '1',
      },
    })

    let stdout = ''
    let stderr = ''
    let settled = false

    const timer = setTimeout(() => {
      if (!settled) {
        child.kill('SIGKILL')
        settled = true
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
      resolvePromise({ ok: false, stdout, stderr: String(error), code: -1 })
    })

    child.on('close', (code) => {
      if (settled)
        return
      settled = true
      clearTimeout(timer)
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
  return spawn('git', ['--git-dir', repositoryPath, ...args], {
    env: {
      ...process.env,
      ...env,
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_NOSYSTEM: '1',
    },
  })
}

/** Create a bare repository. */
export async function initBare(repositoryPath: string, defaultBranch = 'main'): Promise<GitResult> {
  return await new Promise<GitResult>((resolvePromise) => {
    const child = spawn('git', ['init', '--bare', `--initial-branch=${defaultBranch}`, repositoryPath], {
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    })

    let stderr = ''
    child.stderr.on('data', chunk => stderr += chunk)
    child.on('error', error => resolvePromise({ ok: false, stdout: '', stderr: String(error), code: -1 }))
    child.on('close', code => resolvePromise({ ok: code === 0, stdout: '', stderr, code: code ?? -1 }))
  })
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

/**
 * Fetching an action, and not fetching it twice.
 *
 * A workflow that uses six actions across four jobs asks for the same code
 * repeatedly, and a runner that clones each time turns every run into a
 * network-bound one. The cache is keyed by the **commit** rather than by the
 * reference, so `@v4` and the sha it resolved to are one entry - which is also
 * what makes a second job's "fetch" free rather than a fetch.
 *
 * **Where an action may come from is decided before this is called**
 * ([`actionRef.ts`](./actionRef.ts)). What is decided *here* is narrower and
 * still worth stating: a reference pinned to a sha is verified after the
 * checkout, so a host that answers with a different commit than the one asked
 * for is caught rather than trusted. Pinning that is not checked is a setting
 * that reads as protection and is not.
 */

import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import type { ActionReference } from './actionRef'

export interface FetchOptions {
  /** Where fetched actions are kept. One directory per commit. */
  root: string
  /**
   * Where a host's repositories actually live.
   *
   * `github.com` to `https://github.com` by default, and an operator can point
   * a host somewhere else - an internal mirror, or this instance itself. That
   * is the same mechanism [phase 13](../../../docs/todo/13-mirroring.md) wants
   * for mirroring the actions a repository uses, rather than a second one.
   */
  origins?: Record<string, string>
  /**
   * The host an unqualified `owner/name` means.
   *
   * No default. `actions/checkout@v4` names no host, and picking github.com
   * here would be the same guess the policy layer refuses to make one file
   * away - an instance that has not been told where actions come from should
   * say so, not quietly reach for the biggest one.
   */
  defaultHost?: string | null
  /** How long to allow a fetch, in milliseconds. */
  timeoutMs?: number
}

export interface FetchResult {
  ok: boolean
  /** The directory the action's files are in, when it was fetched. */
  path: string | null
  /** The commit that was checked out. */
  sha: string | null
  /** Whether this came from the cache rather than the network. */
  cached: boolean
  reason: string
}

/**
 * Fetch an action's repository at a reference, or answer why not.
 *
 * Two steps rather than one clone, because a reference can be a tag, a branch
 * or a sha, and only `git fetch` of an explicit object handles all three
 * without guessing which it was.
 */
export async function fetchAction(reference: ActionReference, options: FetchOptions): Promise<FetchResult> {
  if (reference.kind !== 'remote' || !reference.repository || !reference.ref)
    return { ok: false, path: null, sha: null, cached: false, reason: 'this is not a remote action reference' }

  const host = reference.host ?? options.defaultHost ?? null

  if (!host) {
    return {
      ok: false,
      path: null,
      sha: null,
      cached: false,
      reason: `\`${reference.raw}\` names no host, and no default action host is configured`,
    }
  }

  const origin = originFor(host, options.origins)
  const url = `${origin.replace(/\/$/, '')}/${reference.repository}.git`

  /*
   * A pinned reference can be answered from the cache without touching the
   * network at all: the sha *is* the identity, so a directory named after it
   * cannot be stale. A tag cannot - it moves - so it is resolved every time and
   * only the resulting commit is reused.
   */
  if (reference.pinned) {
    const pinned = join(options.root, host, reference.repository, String(reference.ref))

    if (existsSync(join(pinned, '.git')))
      return { ok: true, path: withSubdirectory(pinned, reference), sha: reference.ref, cached: true, reason: 'already fetched' }
  }

  const scratch = join(options.root, host, reference.repository, `.fetching-${process.pid}-${Date.now()}`)

  rmSync(scratch, { recursive: true, force: true })
  mkdirSync(scratch, { recursive: true })

  const fetched = await run(
    [
      'sh',
      '-c',
      [
        'git init --quiet .',
        `git remote add origin ${quote(url)}`,
        // `--depth 1` of one object: an action's history is not wanted, and
        // fetching it is most of the time a clone takes.
        `git fetch --quiet --depth 1 origin ${quote(String(reference.ref))}`,
        'git checkout --quiet FETCH_HEAD',
      ].join(' && '),
    ],
    scratch,
    options.timeoutMs ?? 120_000,
  )

  if (!fetched.ok) {
    rmSync(scratch, { recursive: true, force: true })

    return {
      ok: false,
      path: null,
      sha: null,
      cached: false,
      reason: `could not fetch \`${reference.repository}@${reference.ref}\` from ${host}: ${fetched.output.trim().split('\n').pop() ?? 'git failed'}`,
    }
  }

  const head = await run(['git', 'rev-parse', 'HEAD'], scratch, 15_000)
  const sha = head.output.trim()

  /*
   * The check that makes pinning mean something.
   *
   * A host answering a fetch for one sha with a different commit is either
   * broken or hostile, and a runner that checks out whatever arrived has turned
   * a pin into a decoration.
   */
  if (reference.pinned && sha.toLowerCase() !== String(reference.ref).toLowerCase()) {
    rmSync(scratch, { recursive: true, force: true })

    return {
      ok: false,
      path: null,
      sha: null,
      cached: false,
      reason: `\`${reference.repository}\` answered with ${sha.slice(0, 12)} for a reference pinned to ${String(reference.ref).slice(0, 12)}`,
    }
  }

  const final = join(options.root, host, reference.repository, sha)

  if (existsSync(join(final, '.git'))) {
    // Another job fetched the same commit while this one was working. Theirs is
    // as good as this one by definition - same sha, same bytes - so this copy
    // goes rather than racing to replace it.
    rmSync(scratch, { recursive: true, force: true })

    return { ok: true, path: withSubdirectory(final, reference), sha, cached: true, reason: 'another job had already fetched it' }
  }

  mkdirSync(join(options.root, host, reference.repository), { recursive: true })

  try {
    renameSync(scratch, final)
  }
  catch {
    // A rename across devices, or a directory that appeared underneath. The
    // scratch copy is complete and correct, so it is used where it stands
    // rather than failing the step over a filesystem detail.
    return { ok: true, path: withSubdirectory(scratch, reference), sha, cached: false, reason: 'fetched' }
  }

  return { ok: true, path: withSubdirectory(final, reference), sha, cached: false, reason: 'fetched' }
}

/** The action's own directory inside the repository, when the reference named one. */
function withSubdirectory(path: string, reference: ActionReference): string {
  return reference.subdirectory ? join(path, reference.subdirectory) : path
}

/** Where a host's repositories are, with an operator's override winning. */
function originFor(host: string, origins?: Record<string, string>): string {
  const override = origins?.[host] ?? origins?.['*']

  return override ?? `https://${host}`
}

function quote(value: string): string {
  return `'${String(value).replace(/'/g, '\'\\\'\'')}'`
}

async function run(command: string[], cwd: string, timeoutMs: number): Promise<{ ok: boolean, output: string }> {
  const child = Bun.spawn(command, {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'ignore',
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: cwd,
      // No credential helper, no prompt. An action fetch that asks for a
      // password hangs a job until its lease lapses, and the credential it
      // would be given belongs to whoever started the runner.
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_NOSYSTEM: '1',
    },
  })

  const timer = setTimeout(() => child.kill(), timeoutMs)

  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])

    return { ok: code === 0, output: `${stdout}${stderr}` }
  }
  finally {
    clearTimeout(timer)
  }
}

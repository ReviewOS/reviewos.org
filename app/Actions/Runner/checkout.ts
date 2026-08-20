/**
 * How a job's code gets into the workspace, and what a workflow may say about it.
 *
 * The checkout is the one step every job has and nobody writes. It is also the
 * step that decides how long half of them take: a monorepository with ten years
 * of history behind a two-minute test suite spends most of its wall clock
 * cloning, and the fix - depth, sparse paths, no submodules - is three words in
 * a file that most CI systems make you write a bespoke step for.
 *
 * The commands are built here, as data, for one reason: a checkout is a shell
 * command assembled from user input, and assembling it inside the executor
 * where nobody can call it means the quoting is tested by running builds.
 */

import { chmodSync, existsSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

/** What a workflow asked for. Every field optional; the defaults are today's behaviour. */
export interface CheckoutOptions {
  /** Don't check anything out. For a job that only calls an API. */
  skip?: boolean
  /** Commits of history to fetch. 0 means all of it, which is the default. */
  depth?: number
  /** `true` for the top level, `'recursive'` for submodules of submodules. */
  submodules?: boolean | 'recursive'
  /** Fetch LFS objects rather than leaving pointer files. */
  lfs?: boolean
  /** Only these paths, cone mode. The monorepository's other half. */
  sparse?: string[]
}

/**
 * What to check out, and from where.
 *
 * A named type rather than an inline one because pickier reads a multi-line
 * inline parameter type as an unused parameter - the same false positive fixed
 * upstream in `pickier` and not yet released here.
 */
export interface CheckoutRequest {
  source: string
  sha: string
  /** True when `source` is a path on this machine rather than a URL. */
  onHost: boolean
  /**
   * Whether the workspace is empty.
   *
   * `git clone` refuses a directory with anything in it, and a hook that ran
   * before the checkout may legitimately have put something there - a warmed
   * cache, a mounted volume, the runner's own bookkeeping. False switches to
   * the fetch shape, which does not care.
   */
  empty?: boolean
  options?: CheckoutOptions
}

export interface CheckoutPlan {
  /** Shell commands, in order. Empty when the workflow asked for no checkout. */
  commands: string[]
  /** What the log says this checkout is, in a phrase. */
  summary: string
}

/**
 * A value safe to put inside single quotes in a shell command.
 *
 * Single quotes and nothing else: inside them a shell interprets nothing but
 * the closing quote, so the only thing to handle is a quote in the value, and
 * `'\''` is the standard way to write one. Every path and ref below goes
 * through here - a repository called `foo'; rm -rf /` is a repository somebody
 * is allowed to create.
 */
export function shellQuote(value: string): string {
  return `'${String(value ?? '').replace(/'/g, `'\\''`)}'`
}

/**
 * The commands that put `sha` in the workspace.
 *
 * Two sources, and which one is used is a fact about *where the runner is*
 * rather than a setting: the instance's own machine has the bare repository on
 * disk, and any other machine clones over the ordinary git endpoint.
 */
export function checkoutPlan(input: CheckoutRequest): CheckoutPlan {
  const options = input.options ?? {}

  if (options.skip)
    return { commands: [], summary: 'skipped, because the workflow asked for no checkout' }

  const depth = Number.isInteger(options.depth) && Number(options.depth) > 0 ? Number(options.depth) : 0
  const sparse = (options.sparse ?? []).map(one => String(one ?? '').trim()).filter(Boolean)
  const commands: string[] = []
  const notes: string[] = []

  /*
   * `file://` when a depth is asked for on this host, and a plain path when it
   * is not.
   *
   * git ignores `--depth` on a local-path clone - it hardlinks or copies the
   * object store instead - and prints a warning most people never read. A
   * workflow that asked for a shallow clone and silently got ten years of
   * history is the sort of thing somebody debugs for an afternoon.
   */
  const source = input.onHost && depth > 0 ? `file://${input.source}` : input.source

  if (input.onHost && depth === 0 && input.empty !== false) {
    // `--no-hardlinks` so a step running `git gc` cannot write into the object
    // store everybody pushes to.
    commands.push(`git clone --no-hardlinks --quiet ${shellQuote(source)} .`)

    if (sparse.length > 0)
      commands.push(...sparseCommands(sparse))

    commands.push(`git checkout --quiet ${shellQuote(input.sha)}`)
  }
  else {
    /*
     * `init` and `fetch` rather than `clone`, which covers three cases at once:
     * a runner that is not this instance's host, a shallow clone (git ignores
     * `--depth` on a local path), and a workspace something already wrote to.
     */
    commands.push('git init --quiet .')
    commands.push(`git remote add origin ${shellQuote(source)}`)

    if (sparse.length > 0)
      commands.push(...sparseCommands(sparse))

    // A shallow fetch of the one commit is what a remote runner actually needs:
    // the history belongs to the instance, not to this machine.
    commands.push(`git fetch --quiet ${depth > 0 ? `--depth ${depth}` : '--depth 1'} origin ${shellQuote(input.sha)}`)
    commands.push('git checkout --quiet FETCH_HEAD')
  }

  if (depth > 0)
    notes.push(`depth ${depth}`)

  if (sparse.length > 0)
    notes.push(`${sparse.length} sparse path${sparse.length === 1 ? '' : 's'}`)

  if (options.submodules) {
    /*
     * Shallow submodules too. A submodule's history is history somebody asked
     * even less for than the repository's own, and `--depth 1` here is the
     * difference between a checkout that takes a minute and one that takes ten
     * on a repository with vendored dependencies in it.
     */
    commands.push(`git submodule update --init --depth 1 --quiet${options.submodules === 'recursive' ? ' --recursive' : ''}`)
    notes.push(options.submodules === 'recursive' ? 'submodules, recursive' : 'submodules')
  }

  if (options.lfs) {
    /*
     * After the checkout rather than through `git clone --recurse`, so a
     * repository whose LFS objects are missing still produces a working tree
     * with pointer files in it - a failure a person can read, rather than a
     * clone that dies with nothing on disk.
     */
    commands.push('git lfs pull')
    notes.push('LFS')
  }

  return {
    commands,
    summary: notes.length > 0 ? notes.join(', ') : 'full history',
  }
}

/**
 * Cone-mode sparse checkout, set before anything is fetched.
 *
 * Cone rather than the full pattern language: the pattern form is a gitignore
 * dialect that behaves differently from every other glob in a workflow file,
 * and a sparse checkout that silently matched the wrong set of files is a build
 * that compiles the wrong tree.
 */
function sparseCommands(paths: readonly string[]): string[] {
  return [
    'git sparse-checkout init --cone',
    `git sparse-checkout set ${paths.map(shellQuote).join(' ')}`,
  ]
}

/**
 * Check a commit out into a directory.
 *
 * Exported because the microVM path needs the same answer to "what does a
 * checkout mean here" - the depth, the sparse paths, the submodules, and the
 * two sources - and a second implementation of that would drift from this one
 * within a month.
 *
 * The credential never reaches the directory this writes into: it goes through
 * an askpass helper written to the workspace's *parent*, which is what makes it
 * safe to hand the workspace itself to somewhere less trusted.
 */
export async function checkoutCode(input: {
  reposRoot: string
  fullName: string
  sha: string
  workspace: string
  baseUrl?: string
  cloneToken?: string
  /** What the workflow asked for, when it asked. */
  options?: CheckoutOptions
  /** False when a hook has already written into the workspace. */
  empty?: boolean
  onOutput: (text: string, stream: 'stdout' | 'stderr') => Promise<void>
  /**
   * How to run the clone.
   *
   * Injected rather than imported, which is what lets the microVM path use this
   * without pulling in the host executor and everything it assumes. The host
   * passes its own `runStep`, so a clone there inherits the same ceilings and
   * timeout as any other command; the microVM path passes something plainer,
   * because none of that applies to a staging directory it is about to copy and
   * delete.
   */
  run: (options: {
    command: string
    cwd: string
    environment: Record<string, string>
    onOutput: (text: string, stream: 'stdout' | 'stderr') => Promise<void>
  }) => Promise<{ ok: boolean, exitCode: number }>
}): Promise<{ ok: boolean, reason: string }> {
  if (!input.fullName || !input.sha)
    return { ok: false, reason: 'this job does not say which commit to check out' }

  /*
   * Absolute, always. The clone runs with the workspace as its working
   * directory, so a relative repository root resolves against the workspace
   * rather than against the instance - and the failure reads as "no repository
   * on this host", which sends somebody looking in the wrong place.
   */
  const bare = resolve(input.reposRoot, `${input.fullName}.git`)
  const onHost = existsSync(bare)

  /*
   * Two sources, and which one is used is a fact about *where this runner is*
   * rather than a setting.
   *
   * On the instance's own machine the bare repository is right there:
   * `--no-hardlinks` so a step running `git gc` cannot write into the objects
   * everybody pushes to, no network, and no credential. On any other machine
   * there is nothing on disk, so it clones over the instance's ordinary git
   * endpoint - the same URL a person would.
   */
  const source = onHost ? bare : `${String(input.baseUrl ?? '').replace(/\/$/, '')}/${input.fullName}.git`

  if (!onHost && !input.baseUrl)
    return { ok: false, reason: `no repository on this host at ${bare}, and nowhere to clone it from` }

  const plan = checkoutPlan({ source, sha: input.sha, onHost, empty: input.empty, options: input.options })

  if (plan.commands.length === 0) {
    // A job that asked for no code at all - one that calls an API, or unblocks
    // something. Said out loud, because an empty workspace with no explanation
    // is the first thing somebody blames when a step cannot find a file.
    await input.onOutput(`::group::Checkout\nskipped: the workflow asked for no checkout\n::endgroup::\n`, 'stdout')

    return { ok: true, reason: 'no checkout was asked for' }
  }

  await input.onOutput(`::group::Checkout\n${input.fullName} at ${input.sha.slice(0, 8)} (${plan.summary})\n`, 'stdout')

  const clone = await input.run({
    // Joined with `&&`: each step of a checkout depends on the one before it,
    // and a sparse-checkout that failed followed by a fetch that succeeded is a
    // build against the wrong tree with a green checkout above it.
    command: plan.commands.join(' && '),
    cwd: input.workspace,
    environment: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: input.workspace,
      GIT_TERMINAL_PROMPT: '0',
      /*
       * The credential, when there is one, through an askpass helper rather
       * than in the URL: a token in a remote URL is written into
       * `.git/config`, which is inside the workspace a step can read.
       */
      ...(input.cloneToken && !onHost
        ? {
            GIT_ASKPASS: askpassFor(input.workspace, input.cloneToken),
            GIT_CONFIG_PARAMETERS: `'credential.helper='`,
          }
        : {}),
    },
    onOutput: input.onOutput,
  })

  await input.onOutput('::endgroup::\n', 'stdout')

  return clone.ok
    ? { ok: true, reason: 'checked out' }
    : { ok: false, reason: `the checkout failed (git exited ${clone.exitCode})` }
}

/**
 * A one-line askpass script holding the clone credential.
 *
 * Outside the workspace, mode 0700, and removed with the workspace's parent
 * when the job ends. The alternative - `https://token@host/...` - writes the
 * credential into `.git/config` *inside the checkout*, where the repository's
 * own steps can read it.
 */
function askpassFor(workspace: string, token: string): string {
  const path = join(workspace, '..', `.reviewos-askpass-${process.pid}`)

  writeFileSync(path, `#!/bin/sh\ncase "$1" in\n  Username*) echo "x-access-token" ;;\n  *) echo ${JSON.stringify(token)} ;;\nesac\n`)
  chmodSync(path, 0o700)

  return path
}

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

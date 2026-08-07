/**
 * Reading a diff out of git without waiting for git to finish.
 *
 * `runGit` collects stdout into a string, which is fine for a branch list and
 * wrong for a diff: a large change takes seconds to write and hundreds of
 * megabytes to hold, and the first file is complete long before the last one
 * starts. Buffering throws away both the latency and the memory.
 *
 * So this hands back an async iterable of chunks. The caller feeds them to the
 * splitter in `app/Actions/Pull/patch.ts`, parses each file as it completes,
 * and writes it onward. Nothing ever holds the whole patch.
 *
 * The child is killed when the caller stops reading, which matters more here
 * than anywhere else in the codebase: a reader who navigates away mid-diff
 * would otherwise leave `git diff` running against a large repository with
 * nobody to read its output.
 */

import { isSafeRevision, spawnGit } from './git'

export interface DiffStreamOptions {
  /** Lines of unchanged context either side of a change. */
  context?: number
  /** Restrict the diff to these paths. Passed after `--`, so they cannot be flags. */
  paths?: string[]
  /**
   * Detect renames and copies.
   *
   * On by default because a rename rendered as a delete plus an add is the
   * single most common way a diff wastes a reviewer's attention. It costs git
   * some work on very large changes, which is the only reason it is optional.
   */
  detectRenames?: boolean
}

export interface DiffStreamResult {
  /** The patch text, in whatever sized pieces git writes it. */
  chunks: AsyncIterable<string>
  /** Kill the child. Safe to call more than once, and after it has exited. */
  cancel: () => void
  /**
   * How it ended.
   *
   * Resolves rather than rejects, because a non-zero exit is information the
   * caller has to render (an unknown revision, a corrupted repository) and not
   * an exception to bubble.
   */
  done: Promise<{ ok: boolean, code: number, stderr: string }>
}

/**
 * The diff a pull request is actually asking about.
 *
 * Three dots, not two. `git diff base..head` compares the two tips, so it
 * includes every change landed on the base while the branch was open and asks
 * the reviewer to approve those too. `base...head` diffs from the commit the
 * two histories parted at, which is exactly the author's work. This is the
 * whole reason the phase 4 checklist calls it out, and it is one character.
 */
export function streamMergeBaseDiff(
  repositoryPath: string,
  base: string,
  head: string,
  options: DiffStreamOptions = {},
): DiffStreamResult | null {
  if (!isSafeRevision(base) || !isSafeRevision(head))
    return null

  return streamDiffArgs(repositoryPath, [`${base}...${head}`], options)
}

/**
 * What changed between two commits, both dots.
 *
 * The opposite choice to `streamMergeBaseDiff`, and for the opposite reason.
 * Three dots answers "what is this branch proposing", which is what a reviewer
 * reads. Two dots answers "what is different between these two commits", which
 * is what you need to carry something *from* one *to* the other - a review
 * thread written against an old head, tracked onto the current one.
 *
 * Using three dots for that would silently do nothing after a rebase, because
 * the merge base of the old head and the new one moves with the rebase and the
 * intervening change disappears from the answer.
 */
export function streamCommitRangeDiff(
  repositoryPath: string,
  from: string,
  to: string,
  options: DiffStreamOptions = {},
): DiffStreamResult | null {
  if (!isSafeRevision(from) || !isSafeRevision(to))
    return null

  return streamDiffArgs(repositoryPath, [from, to], options)
}

/** The diff a single commit introduced. */
export function streamCommitDiff(
  repositoryPath: string,
  sha: string,
  options: DiffStreamOptions = {},
): DiffStreamResult | null {
  if (!isSafeRevision(sha))
    return null

  // `--first-parent` keeps a merge commit from rendering as the whole merged
  // branch, which is a diff nobody asked for and can be enormous.
  return streamDiffArgs(repositoryPath, ['--first-parent', `${sha}^!`], options)
}

function streamDiffArgs(
  repositoryPath: string,
  revisionArgs: string[],
  options: DiffStreamOptions,
): DiffStreamResult {
  const { context = 3, paths = [], detectRenames = true } = options

  const args = [
    'diff',
    // Colour codes would have to be stripped back out before parsing, and a
    // repository config can turn them on.
    '--no-color',
    // A configured external diff driver or textconv filter would run arbitrary
    // commands from repository config on every view.
    '--no-ext-diff',
    '--no-textconv',
    `--unified=${Math.max(0, Math.min(context, 100))}`,
    // The parser reads `a/` and `b/` prefixes, and a repository can configure
    // different ones.
    '--src-prefix=a/',
    '--dst-prefix=b/',
    ...(detectRenames ? ['--find-renames', '--find-copies'] : ['--no-renames']),
    ...revisionArgs,
    // Everything after this is a path, so a branch called `--output` is a
    // branch name.
    '--',
    ...paths,
  ]

  const child = spawnGit(repositoryPath, args)

  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => {
    // Bounded: a repository that fails on every object would otherwise write
    // its complaint into memory until the request dies.
    if (stderr.length < 64_000)
      stderr += chunk
  })

  let killed = false
  let exited = false
  const cancel = () => {
    if (killed || exited)
      return
    killed = true
    child.kill('SIGKILL')
  }

  const done = new Promise<{ ok: boolean, code: number, stderr: string }>((resolvePromise) => {
    child.on('error', (error) => {
      exited = true
      resolvePromise({ ok: false, code: -1, stderr: `${stderr}${String(error)}` })
    })
    // `close` rather than `exit`, so stderr has been fully read by the time
    // this resolves and the message is complete.
    child.on('close', (code) => {
      exited = true
      resolvePromise({ ok: code === 0 && !killed, code: code ?? -1, stderr })
    })
  })

  // A StringDecoder under the hood, so a multi-byte character split across two
  // reads arrives whole rather than as two replacement characters.
  child.stdout.setEncoding('utf8')

  return {
    chunks: {
      async* [Symbol.asyncIterator]() {
        let drained = false
        try {
          // Node readables are async iterable and apply backpressure through
          // it, so a slow consumer slows git rather than filling memory.
          for await (const chunk of child.stdout)
            yield chunk as string
          drained = true
        }
        finally {
          // A `break` or a throw in the consumer lands here with `drained`
          // still false, which is the case worth killing for. Killing after a
          // clean drain would report a successful read as a failed one.
          if (!drained)
            cancel()
        }
      },
    },
    cancel,
    done,
  }
}

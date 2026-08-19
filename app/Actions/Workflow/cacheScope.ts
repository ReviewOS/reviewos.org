/**
 * Who may read a cache, and who may write one.
 *
 * Everything else about caching is an optimisation, and this is not. A cache is
 * a directory one run writes and another run executes out of, which makes it
 * the shortest path from "somebody opened a pull request" to "code of their
 * choosing ran on the default branch". Cache poisoning is the attack, and the
 * only defence that works is refusing the read - by the time a restored
 * `node_modules` has a postinstall hook in it, every later check is being run by
 * the thing it was meant to catch.
 *
 * ## The rule
 *
 * A run restores from its own scope first, and falls back to the default
 * branch. It writes only to its own scope. Which means:
 *
 * - a branch's cache is private to that branch and to nothing else,
 * - the default branch's cache is readable by everybody and writable by the
 *   default branch alone,
 * - a fork's run gets a scope of its own that no branch of this repository ever
 *   reads.
 *
 * That last one is the security boundary. A fork run may *restore* the default
 * branch's cache, because reading is how a pull request gets a fast install and
 * because the bytes came from code this repository already trusts. What it may
 * never do is put bytes anywhere a protected branch will later execute.
 *
 * ## Why the scope is a string and not a flag
 *
 * A boolean - "trusted" or not - cannot express "these two branches are both
 * trusted and still must not share a cache". Two feature branches with
 * different lockfiles are the ordinary case, and a shared scope makes the
 * second one restore the first one's `node_modules` and then wonder why the
 * build is wrong. The scope is the ref, and refs are already the thing this
 * codebase names precisely.
 */

/** What a run needs to say about itself before it may touch a cache. */
export interface RunFacts {
  /** The full ref the run is for: `refs/heads/main`, `refs/pull/12/head`. */
  ref: string
  /** The repository's default branch, short: `main`. */
  defaultBranch: string
  /**
   * Whether the code and the workflow are both this repository's.
   *
   * False for a fork's pull request, which is the case this whole module
   * exists for.
   */
  trusted: boolean
  /**
   * The pull request a fork run belongs to, when it belongs to one.
   *
   * A fork's scope is per pull request rather than per fork: two pull requests
   * from the same fork are two people's code as often as one person's, and a
   * shared scope between them is the same poisoning problem one step further
   * from anybody looking.
   */
  pullRequestNumber?: number | null
}

/** The default branch as a ref, since a scope is always a full ref. */
export function defaultRef(defaultBranch: string): string {
  const branch = String(defaultBranch ?? '').trim() || 'main'

  return branch.startsWith('refs/') ? branch : `refs/heads/${branch}`
}

/**
 * The one scope a run may write to.
 *
 * An untrusted run gets a namespace that is not a ref at all, and cannot be
 * mistaken for one: `fork/<pull request>`. Nothing in `readableScopes` ever
 * returns it for a trusted run, and the name makes that visible to whoever is
 * reading a row rather than only to whoever read this file.
 */
export function writableScope(facts: RunFacts): string {
  if (facts.trusted)
    return String(facts.ref ?? '').trim() || defaultRef(facts.defaultBranch)

  const number = Number(facts.pullRequestNumber)

  /*
   * A fork run with no pull request number gets a scope nothing reads and
   * nothing else writes. It should not happen - an untrusted run is a pull
   * request by definition - and a run that hits it losing its cache is a much
   * better outcome than one sharing a scope with every other unnumbered run.
   */
  return Number.isInteger(number) && number > 0 ? `fork/${number}` : 'fork/unknown'
}

/**
 * The scopes a run may restore from, best first.
 *
 * Order is the answer to "which entry wins" when a key exists in more than
 * one: the run's own scope, because it is the most specific thing that could
 * have been written for this branch, and then the default branch, because it is
 * the one cache every branch is entitled to start from.
 *
 * A trusted run never reads a fork scope. That is not enforced by filtering it
 * out afterwards - it is enforced by never putting it in this list, which is
 * the same thing said in the place where getting it wrong is visible.
 */
export function readableScopes(facts: RunFacts): string[] {
  const own = writableScope(facts)
  const fallback = defaultRef(facts.defaultBranch)

  return own === fallback ? [fallback] : [own, fallback]
}

/**
 * Whether a run may restore an entry that was written by `writtenBy`.
 *
 * The predicate behind the list above, kept separate because a list is what a
 * lookup wants and a predicate is what an audit wants - and because the day
 * somebody adds a third source of cache entries, this is the function that has
 * to be told about it.
 */
export function canRestore(facts: RunFacts, writtenBy: string): boolean {
  return readableScopes(facts).includes(String(writtenBy ?? ''))
}

/**
 * Whether a run may write to a scope it names.
 *
 * A runner sends the scope it thinks it has, and it is somebody else's program.
 * This is the check that makes the claim unnecessary: the answer is computed
 * from the run row on the instance, and a runner asking for anything else is
 * refused rather than believed.
 */
export function canSave(facts: RunFacts, scope: string): boolean {
  return writableScope(facts) === String(scope ?? '')
}

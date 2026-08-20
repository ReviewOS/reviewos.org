/**
 * Searching every repository somebody can see.
 *
 * The shape is: **the index narrows, git decides**. For each repository the
 * viewer may read, the shard says which files could possibly contain the query;
 * `git grep` is then run against those paths at the current ref and produces
 * the matches. Nothing here returns a line the index remembered - every result
 * is read out of the tree at the moment of asking, which is the property
 * in-repository search already has and the reason it can be trusted.
 *
 * ## What that buys, and what it costs
 *
 * A specific identifier is the case this is for: across a thousand
 * repositories the summaries answer "cannot match" for nearly all of them
 * without a process starting, and the handful left are grepped against a
 * pathspec of a few files rather than a whole tree. The cost is one 32KB read
 * per repository, and a shard read for the few that survive it.
 *
 * ## Staleness is bounded rather than assumed away
 *
 * A shard records the commit it was built from. When the ref has moved, the
 * paths changed between the two join the candidate set whatever the index says,
 * so a file written after the last build is still found. When the old commit is
 * unreachable - a force-push, history rewritten - the repository is searched in
 * full rather than narrowed. The index can be out of date; it cannot be wrong.
 */

import { MAX_RESULTS, parseMatches, SEARCH_BYTE_LIMIT, searchArgs, type SearchMatch } from '../Browse/search'
import { runGit } from '../Git/git'
import { candidatesFor, changedSince, readSummary } from './build'
import { queryTrigrams, summaryMightHold } from './trigram'

/** One repository to consider, as the caller has already authorised it. */
export interface Searchable {
  id: number
  owner: string
  name: string
  diskPath: string
  defaultBranch: string
}

export interface InstanceSearchRequest {
  pattern: string
  regex?: boolean
  caseSensitive?: boolean
  language?: string
  /** Results in total, across every repository. */
  limit?: number
  /** How many repositories may be considered at once. */
  concurrency?: number
}

export interface RepositoryMatches {
  repository: { id: number, owner: string, name: string }
  matches: SearchMatch[]
  /** True when this repository was searched without the index narrowing it. */
  unnarrowed: boolean
}

export interface InstanceSearchResult {
  results: RepositoryMatches[]
  /** How many repositories the index excluded without running git at all. */
  skippedByIndex: number
  /** How many were searched. */
  searched: number
  /** True when the result cap stopped the search early. */
  truncated: boolean
}

/** How many repositories to consider at once. Bounded: each one is a process. */
export const DEFAULT_CONCURRENCY = 4

/** How many pathspecs a single grep may carry before it is cheaper to grep all. */
export const MAX_PATHSPECS = 500

/**
 * The pathspecs to search inside one repository, or null for "all of it".
 *
 * Null whenever the index cannot honestly narrow: no shard, a query with no
 * usable trigrams, or a shard built on a commit git no longer has.
 */
export async function candidatePaths(repository: Searchable, request: InstanceSearchRequest): Promise<string[] | null> {
  const grams = queryTrigrams(request.pattern, request.regex ?? false)

  if (!grams)
    return null

  /*
   * The bitmap first, and for most repositories that is the whole answer.
   *
   * A shard is megabytes and reading one costs milliseconds; the head of it is
   * 32KB of bits and costs a fraction of one. Across a thousand repositories,
   * a search for an identifier that exists in three of them opens three shards
   * instead of a thousand - the difference between this being worth building
   * and being slower than grepping everything.
   */
  const summary = await readSummary(repository.id)

  if (!summary)
    return null

  if (!summaryMightHold(summary.bitmap, grams)) {
    // A bit never set means no indexed file holds that trigram. Still subject
    // to the staleness check: a file written since the build is not in the map.
    return changedSinceHead(repository, summary.commit)
  }

  const narrowed = await candidatesFor(repository.id, grams)

  if (narrowed === null)
    return null

  const since = await changedSinceHead(repository, summary.commit)

  if (since === null)
    return null

  return [...new Set([...narrowed, ...since])]
}

/**
 * The paths written since the shard was built, or null when that is unknowable.
 *
 * Null means the shard cannot be shown to be a subset of the truth, and the
 * caller searches the repository in full.
 */
async function changedSinceHead(repository: Searchable, from: string): Promise<string[] | null> {
  const head = await runGit(repository.diskPath, ['rev-parse', repository.defaultBranch], { timeoutMs: 10_000 })
  const current = head.ok ? head.stdout.trim() : ''

  if (!current || current === from)
    return []

  const changed = await changedSince(repository.diskPath, from, current)

  return changed.includes('*') ? null : changed
}

/**
 * Search one repository, narrowed if the index can.
 *
 * `narrowed` is passed in rather than recomputed when the caller already has
 * it: working it out costs a summary read and a `rev-parse`, and doing that
 * twice per repository would be half the cost of an instance-wide search spent
 * deciding the same thing again.
 */
export async function searchRepository(
  repository: Searchable,
  request: InstanceSearchRequest,
  narrowed?: string[] | null,
): Promise<RepositoryMatches | null> {
  const paths = narrowed === undefined ? await candidatePaths(repository, request) : narrowed

  // Narrowed to nothing is a complete answer: no file here can contain the
  // query, and no process needs to start to say so.
  if (paths !== null && paths.length === 0)
    return null

  /*
   * Past a few hundred pathspecs the argument list costs more than it saves,
   * and git's own limit is a failure that reads as a git error rather than as
   * too much narrowing.
   *
   * And a path git would read as something other than a path sends the whole
   * repository to the grep instead. `pathspecs()` drops anything beginning with
   * `:` - correctly, because that is magic to git and a query string should not
   * be able to write `:(exclude)` - but a *file* legitimately named that way
   * exists in the tree, and dropping it here would quietly exclude it from its
   * own repository's search. A glob character is the same problem in reverse: a
   * file called `a[1].ts` is a pattern rather than a name once git reads it.
   * Both are rare and both fail in the one direction this index may not fail
   * in, so either one gives up narrowing rather than narrowing wrongly.
   */
  const routable = paths?.every(path => !path.startsWith(':') && !/[*?[\]]/.test(path)) ?? true
  const usable = paths && routable && paths.length <= MAX_PATHSPECS ? paths : null

  const args = searchArgs({
    pattern: request.pattern,
    ref: repository.defaultBranch,
    regex: request.regex ?? false,
    caseSensitive: request.caseSensitive ?? false,
    paths: usable ?? [],
    language: request.language ?? '',
    context: 0,
  })

  const result = await runGit(repository.diskPath, args, {
    timeoutMs: 10_000,
    maxBytes: SEARCH_BYTE_LIMIT,
    // Background: an instance-wide search is a batch of processes and must not
    // crowd out somebody loading a diff.
    priority: 'background',
  })

  // Exit 1 is "no matches", which is an answer rather than a failure.
  if (!result.ok && result.code !== 1)
    return null

  const matches = parseMatches(result.stdout, request.limit ?? MAX_RESULTS, repository.defaultBranch)

  if (matches.length === 0)
    return null

  return {
    repository: { id: repository.id, owner: repository.owner, name: repository.name },
    matches,
    unnarrowed: usable === null,
  }
}

/**
 * Search them all, in bounded batches, stopping at the cap.
 *
 * Repositories are taken in the order given - the caller sorts, usually by
 * recent activity - so a truncated search returns the most likely answers
 * rather than the alphabetically first ones.
 */
export async function searchInstance(
  repositories: readonly Searchable[],
  request: InstanceSearchRequest,
): Promise<InstanceSearchResult> {
  const limit = request.limit ?? MAX_RESULTS
  const concurrency = Math.max(1, Math.min(request.concurrency ?? DEFAULT_CONCURRENCY, 16))
  const results: RepositoryMatches[] = []

  let found = 0
  let searched = 0
  let skippedByIndex = 0
  let truncated = false

  for (let offset = 0; offset < repositories.length; offset += concurrency) {
    if (found >= limit) {
      truncated = true
      break
    }

    const batch = repositories.slice(offset, offset + concurrency)

    const answers = await Promise.all(batch.map(async (repository) => {
      const paths = await candidatePaths(repository, request)

      if (paths !== null && paths.length === 0) {
        skippedByIndex += 1

        return null
      }

      searched += 1

      return searchRepository(repository, { ...request, limit: limit - found }, paths)
    }))

    for (const answer of answers) {
      if (!answer)
        continue

      const room = limit - found

      if (room <= 0) {
        truncated = true
        break
      }

      const kept = answer.matches.slice(0, room)

      found += kept.length
      results.push({ ...answer, matches: kept })

      if (kept.length < answer.matches.length)
        truncated = true
    }
  }

  return { results, skippedByIndex, searched, truncated }
}

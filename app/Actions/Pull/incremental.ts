/**
 * What changed in a pull request since one particular reviewer last looked.
 *
 * The reviewer with eleven of these waiting and forty minutes does not want the
 * whole diff again. They want the answer to one question: of the three hundred
 * files I read last week, which ones do I have to read a second time.
 *
 * ## Why not `git diff lastSeen head`
 *
 * Because it is wrong the moment the base moves, and it is completely wrong
 * after a rebase. Two tips compared directly include every commit that landed
 * on the base in between, so a reviewer who looked on Monday is shown a hundred
 * files somebody else changed on Tuesday. After a force-push the two tips share
 * no history at all and the answer is the entire branch, twice over. This is
 * where GitHub gives up and shows the whole diff again.
 *
 * ## What is compared instead
 *
 * Each head against **its own merge base**, which is the three-dot diff the
 * pull request is already rendered from - the author's work, with the base's
 * movement removed. Do that for the head the reviewer saw and for the head as
 * it stands now, and compare the two *patches* file by file:
 *
 *   - the same patch for a path means the proposal for that file is unchanged,
 *     whatever happened to the branch underneath it;
 *   - a different patch means the reviewer's conclusion about that file may no
 *     longer hold, and it is put back in front of them.
 *
 * That is rebase-proof by construction rather than by special-casing. A rebase
 * moves both merge bases; a file the rebase did not touch has the same base
 * content and the same result, so it produces the same patch, byte for byte,
 * and drops out. A file the rebase *did* touch produces a different patch,
 * which is correct: the change now applies to different surrounding code, and
 * that is exactly the situation worth a second read.
 *
 * ## What is held
 *
 * A digest per path, never a patch. The whole point of the diff engine is that
 * nothing holds a large patch, and a comparison that buffered two of them to
 * answer a question about which files to read would be the one place that broke
 * the rule.
 */

import { createHash } from 'node:crypto'
import { diskPathFor } from '../Git/access'
import { streamMergeBaseDiff } from '../Git/diffStream'
import { createPatchSplitter } from './patch'

/** A path, and a digest of the patch proposed for it. */
export type Fingerprints = Map<string, string>

export interface SinceLastLook {
  /** Paths whose proposed change differs from the one the reviewer read. */
  changed: string[]
  /** Paths the pull request did not touch when they looked, and does now. */
  added: string[]
  /** Paths it touched when they looked, and no longer does. */
  removed: string[]
  /** How many are identical, which is the number worth telling them. */
  unchanged: number
}

/**
 * The lines of a file's patch that say what it proposes.
 *
 * `index 1a2b3c4..5d6e7f8` names blob shas, and the abbreviation length git
 * chooses grows with the object count of the repository - so the same content
 * can be printed two ways in one repository's lifetime, and every file would
 * read as changed the day it crosses the threshold. The blobs carry no
 * information the rest of the patch does not: identical content is identical
 * lines.
 *
 * Everything else is kept, including the hunk headers. Their line numbers
 * shifting is not noise: it means the base moved this file's content under the
 * change, which is a thing to re-read.
 */
export function patchSignature(fileText: string): string {
  const kept: string[] = []

  for (const line of fileText.split('\n')) {
    if (line.startsWith('index '))
      continue

    kept.push(line)
  }

  return createHash('sha1').update(kept.join('\n')).digest('hex')
}

/**
 * The path a patch for one file is about.
 *
 * Read from `+++ b/path` when there is one, and from `--- a/path` when there is
 * not, which is a deletion. Quoted when git had to quote it, and the prefix is
 * *inside* the quotes - stripping it before the unquote is how every path with
 * a space in it came out as `b/my file.ts` once already.
 */
export function pathInPatch(fileText: string): string | null {
  let minus: string | null = null

  for (const line of fileText.split('\n')) {
    if (line.startsWith('+++ ')) {
      const target = unprefix(line.slice(4))
      if (target !== null)
        return target
    }
    else if (line.startsWith('--- ')) {
      minus = unprefix(line.slice(4))
    }
    else if (line.startsWith('@@')) {
      // Past the headers. Anything later is content that may well begin with
      // `+++`, and reading it as a header would name the wrong file.
      break
    }
  }

  return minus
}

/** `b/src/a.ts`, or `"b/my file.ts"`, as a plain path. `/dev/null` as null. */
function unprefix(raw: string): string | null {
  const trimmed = raw.trim()

  if (trimmed === '/dev/null')
    return null

  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      // The prefix is inside the quotes, so it comes off after the unquote.
      const unquoted = JSON.parse(trimmed) as string
      return unquoted.length > 2 && (unquoted[1] === '/') ? unquoted.slice(2) : unquoted
    }
    catch {
      return trimmed
    }
  }

  return trimmed.length > 2 && trimmed[1] === '/' ? trimmed.slice(2) : trimmed
}

/**
 * A digest per changed path, for one head, without holding the patch.
 *
 * Returns null when git could not produce the diff, which is an ordinary state
 * rather than an exception: the sha a reviewer last saw may have been garbage
 * collected after a force-push, and the caller renders "we cannot tell you what
 * changed" rather than a stack trace.
 */
export async function fingerprintProposal(
  diskPath: string,
  base: string,
  head: string,
): Promise<Fingerprints | null> {
  const diff = streamMergeBaseDiff(diskPath, base, head)
  if (!diff)
    return null

  const splitter = createPatchSplitter()
  const prints: Fingerprints = new Map()

  const record = (fileText: string): void => {
    const path = pathInPatch(fileText)
    if (path !== null)
      prints.set(path, patchSignature(fileText))
  }

  try {
    for await (const chunk of diff.chunks) {
      splitter.push(chunk)

      for (let file = splitter.take(); file !== undefined; file = splitter.take())
        record(file)
    }
  }
  catch {
    diff.cancel()
    return null
  }

  for (const file of splitter.finish().files)
    record(file)

  const ended = await diff.done
  return ended.ok ? prints : null
}

/**
 * The two proposals, compared.
 *
 * Pure over the two maps, so the interesting cases are testable without a
 * repository on disk - and the interesting cases are all about a file being in
 * one side and not the other, which is where an implementation that only walks
 * the new side quietly loses every file the author reverted.
 */
export function compareProposals(before: Fingerprints, after: Fingerprints): SinceLastLook {
  const changed: string[] = []
  const added: string[] = []
  const removed: string[] = []
  let unchanged = 0

  for (const [path, print] of after) {
    const was = before.get(path)

    if (was === undefined)
      added.push(path)
    else if (was === print)
      unchanged += 1
    else
      changed.push(path)
  }

  for (const path of before.keys()) {
    if (!after.has(path))
      removed.push(path)
  }

  changed.sort()
  added.sort()
  removed.sort()

  return { changed, added, removed, unchanged }
}

/** A file the reviewer has ticked, and the head they read it at. */
export interface TickedFile {
  path: string
  headSha: string | null
}

export interface StaleTicks {
  /** Ticks whose file no longer proposes what the reviewer read. */
  stale: string[]
  /**
   * Ticks that cannot be checked rather than ticks that are fine.
   *
   * A force push can leave the sha somebody read unreachable, and a row written
   * before `head_sha` existed carries no sha at all. Neither is evidence that
   * the file is unchanged, and reporting them as fresh would be the interface
   * telling a reviewer they have read something nobody can confirm they have.
   */
  unverifiable: string[]
}

/**
 * Which ticks no longer describe the file in front of the reviewer.
 *
 * **Per file, and that is the whole difficulty.** The obvious implementation -
 * the head moved, so unmark everything - clears the tick on every file the push
 * did not touch, and looks exactly like the feature working. `head_sha` has
 * been stored and deliberately unused for precisely that reason.
 *
 * The question asked instead is the one the incremental diff already answers:
 * each head fingerprinted against **its own merge base**, compared per path. So
 * a file is stale when what it proposes differs from what was read, whatever
 * happened underneath it - and a rebase that did not touch a file leaves its
 * digest identical and its tick alone.
 *
 * Pure over the maps, because the interesting cases are all about a path being
 * on one side and not the other, and none of them need a repository.
 */
export function staleTicks(
  ticked: readonly TickedFile[],
  head: string,
  atHead: Fingerprints,
  atSha: ReadonlyMap<string, Fingerprints>,
): StaleTicks {
  const stale: string[] = []
  const unverifiable: string[] = []

  for (const tick of ticked) {
    // Not in the diff any more. There is nothing left to re-read, and the
    // sidebar has no row to mark, so it is neither.
    if (!atHead.has(tick.path))
      continue

    // Read at the head they are looking at: the tick is exactly as good as it
    // was when they made it, and no git ran to find that out.
    if (tick.headSha != null && tick.headSha === head)
      continue

    if (tick.headSha == null) {
      unverifiable.push(tick.path)
      continue
    }

    const before = atSha.get(tick.headSha)
    if (before == null) {
      unverifiable.push(tick.path)
      continue
    }

    const was = before.get(tick.path)

    // Ticked when the pull request did not touch this file at all, and it does
    // now: they have not read what it proposes, because it proposed nothing.
    if (was === undefined || was !== atHead.get(tick.path))
      stale.push(tick.path)
  }

  stale.sort()
  unverifiable.sort()

  return { stale, unverifiable }
}

/**
 * The head this reader was looking at last time, or null.
 *
 * Two records count as having looked, and the most recent of them wins:
 *
 *   - a review they submitted, whose `commit_sha` is the head they read;
 *   - a file they marked as read, whose `head_sha` is the same thing at a
 *     finer grain.
 *
 * The second is what makes this work for the reviewer who never submits. Most
 * of a long review is reading, and somebody who ticked forty files on Monday
 * and did not send a verdict has told us exactly as much about where they got
 * to as somebody who left a comment. Taking only the submitted review would
 * hand them the whole diff again, which is the thing this exists to stop.
 *
 * The third is the explicit one: a checkpoint, "I have read this round", from
 * the reviewer who read everything and had nothing to add. They left neither
 * of the other two records, and without this row the incremental diff keeps
 * offering them a round they have already read.
 */
export async function lastSeenHead(pullRequestId: number, reviewerId: number): Promise<string | null> {
  const [review, viewed, checkpoint] = await Promise.all([
    db
      .selectFrom('pull_request_reviews')
      .select(['commit_sha', 'created_at'])
      .where('pull_request_id', '=', pullRequestId)
      .where('reviewer_id', '=', reviewerId)
      .orderBy('id', 'desc')
      .executeTakeFirst(),
    db
      .selectFrom('reviewed_files')
      .select(['head_sha', 'updated_at'])
      .where('pull_request_id', '=', pullRequestId)
      .where('reviewer_id', '=', reviewerId)
      .orderBy('updated_at', 'desc')
      .executeTakeFirst(),
    db
      .selectFrom('review_checkpoints')
      .select(['head_sha', 'updated_at', 'created_at'])
      .where('pull_request_id', '=', pullRequestId)
      .where('reviewer_id', '=', reviewerId)
      .executeTakeFirst(),
  ])

  const candidates: Array<{ sha: string, at: number }> = []

  const push = (sha: unknown, at: unknown) => {
    const value = String(sha ?? '').trim()
    if (value)
      candidates.push({ sha: value, at: Date.parse(String(at ?? '')) || 0 })
  }

  push(review?.commit_sha, review?.created_at)
  push(viewed?.head_sha, viewed?.updated_at)
  // Updated in place, so updated_at is when they last said it - but the first
  // saying leaves updated_at null, and created_at is the honest time then.
  push(checkpoint?.head_sha, checkpoint?.updated_at ?? checkpoint?.created_at)

  if (candidates.length === 0)
    return null

  candidates.sort((a, b) => b.at - a.at)
  return candidates[0]!.sha
}

/**
 * What changed between two heads of one pull request, for one reader.
 *
 * `null` when either side could not be diffed. Both are streamed in parallel
 * because they are independent reads of the same object database and the reader
 * is waiting on the slower one either way.
 */
export async function sinceLastLook(options: {
  owner: string
  repository: string
  base: string
  head: string
  lastSeen: string
}): Promise<SinceLastLook | null> {
  const diskPath = diskPathFor(options.owner, options.repository)
  if (!diskPath)
    return null

  if (options.lastSeen === options.head)
    return { changed: [], added: [], removed: [], unchanged: 0 }

  const [before, after] = await Promise.all([
    fingerprintProposal(diskPath, options.base, options.lastSeen),
    fingerprintProposal(diskPath, options.base, options.head),
  ])

  if (before === null || after === null)
    return null

  return compareProposals(before, after)
}

/**
 * How many distinct heads' worth of ticks are checked in one request.
 *
 * Each one is a full streamed diff of the pull request, so this is the cost
 * ceiling. Ticks cluster by review round - a reviewer reads a batch of files at
 * one head, comes back after a push and reads more - so a handful covers every
 * real case, and a pull request with more rounds than this reports the rest as
 * unverifiable rather than quietly leaving them ticked.
 */
export const STALE_TICK_HEAD_LIMIT = 8

/**
 * Which of this reviewer's ticks are stale, asked of the repository.
 *
 * The ticks are grouped by the head they were made at, because that is the
 * expensive axis: one streamed diff per distinct sha, however many files were
 * ticked at it. The head's own fingerprints are read once alongside them.
 *
 * `null` when the head itself cannot be read, which is the only case where
 * there is no answer rather than an empty one.
 */
export async function staleTickedFiles(options: {
  owner: string
  repository: string
  base: string
  head: string
  ticked: readonly TickedFile[]
}): Promise<(StaleTicks & { checkedHeads: number, uncheckedHeads: number }) | null> {
  const diskPath = diskPathFor(options.owner, options.repository)
  if (!diskPath)
    return null

  const atHead = await fingerprintProposal(diskPath, options.base, options.head)
  if (atHead === null)
    return null

  // Distinct, and the head itself is not among them: a tick made at the head
  // is fresh by definition and costs nothing to say so.
  const shas = [...new Set(
    options.ticked
      .map(tick => tick.headSha)
      .filter((sha): sha is string => sha != null && sha !== options.head),
  )]

  const checked = shas.slice(0, STALE_TICK_HEAD_LIMIT)
  const fingerprints = await Promise.all(
    checked.map(sha => fingerprintProposal(diskPath, options.base, sha)),
  )

  const atSha = new Map<string, Fingerprints>()
  for (let index = 0; index < checked.length; index++) {
    const prints = fingerprints[index]
    // A sha that cannot be read is left out of the map on purpose: the decision
    // reports its ticks as unverifiable, which is what "the commit you read is
    // gone" honestly is.
    if (prints !== null)
      atSha.set(checked[index]!, prints)
  }

  return {
    ...staleTicks(options.ticked, options.head, atHead, atSha),
    checkedHeads: checked.length,
    uncheckedHeads: shas.length - checked.length,
  }
}

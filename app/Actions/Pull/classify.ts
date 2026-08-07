/**
 * Telling the decisions in a diff apart from their consequences.
 *
 * A four thousand line change is usually two hundred lines of decision inside
 * three thousand eight hundred lines of consequence: the rename that touched
 * ninety files, the formatter that rewrote every line it passed, the block that
 * moved from one file to another without a character changing. Reading it
 * linearly is why large changes get approved unread - by the time the reviewer
 * reaches the part that matters, they have spent their attention on the part
 * that does not.
 *
 * So each hunk is classified, and the mechanical ones are folded away with the
 * count said out loud. **Said out loud** is the whole safety argument: a
 * reviewer who is told "eleven hunks hidden, all formatting" can open them, and
 * a reviewer who is silently shown less has been lied to. Nothing here ever
 * removes anything from the diff.
 *
 * Every rule below is conservative in the same direction. When a hunk could be
 * mechanical or could be logic, it is logic. A false "this is just a rename"
 * hides a real change inside a diff the reviewer has been told is safe to skim,
 * which is the one failure this feature can cause and the reason the tests are
 * mostly about what it declines to classify.
 */

import type { DiffFile, DiffHunk, DiffLine } from './diff'
import { isWhitespaceOnly } from './diff'

export type HunkKind =
  /** Only whitespace moved. The formatter ran. */
  | 'formatting'
  /** Every changed line is the same one identifier swapped for another. */
  | 'renamed-symbol'
  /** These lines exist unchanged elsewhere in this file. */
  | 'moved'
  /** Something a person has to read. */
  | 'logic'

export interface HunkClassification {
  kind: HunkKind
  /** What to say about it, when there is something worth saying. */
  detail?: string
}

/** Below this, a run of identical lines moving is a coincidence, not a move. */
export const MOVED_RUN_MINIMUM = 3

/**
 * Below this, one substitution is one edit rather than a find-and-replace.
 *
 * Two lines changed the same way is a pattern; one line changed is somebody
 * renaming a thing, and the reviewer wants to see it.
 */
export const SUBSTITUTION_MINIMUM = 2

/**
 * The removed and added lines of a hunk, paired.
 *
 * git writes a change as a run of removed lines followed by a run of added
 * lines, so a hunk that replaced three lines with three lines pairs one to one.
 * Anything else - a run of two replaced by a run of five, an addition with no
 * removal - does not pair, and this answers null rather than guessing. Every
 * classification below needs a pairing to say anything at all, so null means
 * `logic` and that is the right default.
 */
export function pairChanges(lines: readonly DiffLine[]): Array<{ before: string, after: string }> | null {
  const pairs: Array<{ before: string, after: string }> = []

  let removed: string[] = []
  let added: string[] = []
  let sawChange = false

  const closeRun = (): boolean => {
    if (removed.length === 0 && added.length === 0)
      return true

    if (removed.length !== added.length)
      return false

    for (let index = 0; index < removed.length; index++)
      pairs.push({ before: removed[index]!, after: added[index]! })

    removed = []
    added = []
    return true
  }

  for (const line of lines) {
    if (line.origin === 'removed') {
      // An added line followed by a removed one starts a new run rather than
      // continuing this one, because git never writes them in that order
      // within a single change.
      if (added.length > 0 && !closeRun())
        return null

      removed.push(line.content)
      sawChange = true
    }
    else if (line.origin === 'added') {
      added.push(line.content)
      sawChange = true
    }
    else if (!closeRun()) {
      return null
    }
  }

  if (!closeRun())
    return null

  return sawChange ? pairs : null
}

/**
 * The one substring that turns `before` into `after`, or null.
 *
 * Found by taking the common prefix and the common suffix off both sides; what
 * is left in the middle is the substitution. Null when either side is empty
 * (that is an insertion or a deletion, not a swap) or when either side is not
 * identifier-shaped - `1` becoming `2` is a change of behaviour that happens to
 * be one character, and calling a hunk of those a rename would hide exactly the
 * kind of edit a reviewer is looking for.
 */
export function singleSubstitution(before: string, after: string): { from: string, to: string } | null {
  if (before === after)
    return null

  let start = 0
  const limit = Math.min(before.length, after.length)
  while (start < limit && before[start] === after[start])
    start += 1

  let end = 0
  while (
    end < limit - start
    && before[before.length - 1 - end] === after[after.length - 1 - end]
  ) {
    end += 1
  }

  const from = before.slice(start, before.length - end)
  const to = after.slice(start, after.length - end)

  if (from === '' || to === '')
    return null

  // Identifier-shaped on both sides, and each segment has to *begin* like an
  // identifier rather than merely be made of word characters. `\w` includes
  // digits, so a looser rule accepts `1` becoming `2` - a change of behaviour
  // one character wide, folded away as a rename, inside a diff the reviewer was
  // told to skim. That is the one failure this feature can cause.
  const identifier = /^[A-Z_$][\w$]*(?:\.[A-Z_$][\w$]*)*$/i
  if (!identifier.test(from) || !identifier.test(to))
    return null

  return { from, to }
}

/**
 * Whether every pair in a hunk is the same identifier swapped for the same one.
 *
 * The rename that touched ninety files. Requires the swap to be consistent
 * across at least two lines, and requires *every* changed line to be an
 * instance of it - one unrelated edit hidden among ninety renames is precisely
 * what this must not fold away.
 */
export function sharedSubstitution(pairs: readonly { before: string, after: string }[]): { from: string, to: string } | null {
  if (pairs.length < SUBSTITUTION_MINIMUM)
    return null

  let shared: { from: string, to: string } | null = null

  for (const pair of pairs) {
    const swap = singleSubstitution(pair.before, pair.after)
    if (!swap)
      return null

    if (shared === null)
      shared = swap
    else if (shared.from !== swap.from || shared.to !== swap.to)
      return null
  }

  return shared
}

/** A line as it counts for a move: content, with the indentation ignored. */
function movedKey(content: string): string {
  return content.trim()
}

/**
 * The lines that left one part of this file and arrived in another, unchanged.
 *
 * Runs rather than lines, and a minimum length, because a single `}` leaving
 * one place and appearing in another is not a move, it is a brace. Compared on
 * trimmed content, so a block that moved into or out of a conditional and was
 * re-indented still reads as the same block - which is the common case and the
 * one worth catching.
 *
 * Whole runs only. A five line run that matches three lines of an eight line
 * run somewhere else is not obviously a move, and answering "moved" for it
 * would hide two lines nobody has read.
 */
/**
 * Every changed run of one origin in a file, as (key, hunk, length).
 *
 * The one definition of a run - trimmed lines, joined, minimum length - so
 * within-file and cross-file detection cannot disagree about what a block is.
 */
export function changedRuns(
  file: DiffFile,
  origin: 'removed' | 'added',
): Array<{ key: string, hunk: number, lines: number }> {
  const runs: Array<{ key: string, hunk: number, lines: number }> = []

  for (const [index, hunk] of file.hunks.entries()) {
    let run: string[] = []

    const close = () => {
      if (run.length >= MOVED_RUN_MINIMUM)
        runs.push({ key: run.join('\n'), hunk: index, lines: run.length })
      run = []
    }

    for (const line of hunk.lines) {
      if (line.origin === origin)
        run.push(movedKey(line.content))
      else
        close()
    }

    close()
  }

  return runs
}

export function movedRuns(file: DiffFile): { removed: Set<string>, added: Set<string> } {
  const removedRuns = new Map<string, number>()
  const addedRuns = new Map<string, number>()

  for (const run of changedRuns(file, 'removed'))
    removedRuns.set(run.key, (removedRuns.get(run.key) ?? 0) + 1)
  for (const run of changedRuns(file, 'added'))
    addedRuns.set(run.key, (addedRuns.get(run.key) ?? 0) + 1)

  const moved = new Set<string>()
  for (const [key, count] of removedRuns) {
    // The same run appearing on both sides, as many times on each. A run that
    // left twice and arrived once is not a clean move and is left alone.
    if (addedRuns.get(key) === count)
      moved.add(key)
  }

  return { removed: moved, added: moved }
}

/**
 * What one hunk is, given what the whole file knows about moves.
 *
 * Ordered by how much it lets a reviewer skip. Formatting is the strongest
 * claim and the easiest to check; a move is the weakest, because a block that
 * moved may also have been placed somewhere that changes what it does, and the
 * reviewer is told it moved rather than told it is fine.
 */
export function classifyHunk(hunk: DiffHunk, moved?: ReadonlySet<string>): HunkClassification {
  if (isWhitespaceOnly(hunk))
    return { kind: 'formatting', detail: 'whitespace only' }

  const pairs = pairChanges(hunk.lines)

  if (pairs) {
    const swap = sharedSubstitution(pairs)
    if (swap)
      return { kind: 'renamed-symbol', detail: `${swap.from} to ${swap.to}` }
  }

  if (moved && moved.size > 0 && everyRunMoved(hunk, moved))
    return { kind: 'moved', detail: 'moved within this file' }

  return { kind: 'logic' }
}

/** Whether every changed run in this hunk is one that moved. */
function everyRunMoved(hunk: DiffHunk, moved: ReadonlySet<string>): boolean {
  let run: string[] = []
  let origin: 'removed' | 'added' | null = null
  let sawRun = false
  let allMoved = true

  const close = () => {
    if (run.length === 0)
      return

    sawRun = true
    if (run.length < MOVED_RUN_MINIMUM || !moved.has(run.join('\n')))
      allMoved = false

    run = []
    origin = null
  }

  for (const line of hunk.lines) {
    if (line.origin === 'context') {
      close()
      continue
    }

    if (origin !== null && line.origin !== origin)
      close()

    origin = line.origin
    run.push(movedKey(line.content))
  }

  close()

  return sawRun && allMoved
}

export interface FileClassification {
  /** Every hunk, in order. */
  hunks: HunkClassification[]
  /** How many hunks are mechanical, which is the number worth printing. */
  mechanical: number
  /** True when nothing in this file needs reading line by line. */
  allMechanical: boolean
  /**
   * The single reason, when there is one.
   *
   * A file whose hunks are all formatting says so; a file that is half
   * formatting and half logic says nothing, because the honest summary of it is
   * the diff.
   */
  reason: HunkKind | null
}

/**
 * The whole file, classified.
 *
 * A rename with no content change is the extreme case and falls out of the
 * counting rather than being special-cased: it has no hunks, so nothing needs
 * reading, and `allMechanical` is true with no reason attached beyond the
 * status the header already shows.
 */
/**
 * Which hunks fold by default.
 *
 * Mixed files only - `reason === null` - because a file that is mechanical
 * for one reason folds whole, at the file level, and already does. Inside a
 * mixed file, every hunk the classifier is confident about folds; anything
 * `logic` stays open, and a hunk carrying a review thread stays open whatever
 * it is, because a conversation is never mechanical.
 *
 * One function, shared by the manifest, the renderer, and the rows endpoint,
 * so three callers cannot hold three opinions about what is folded - the
 * numbering the virtual scroller lives on is arithmetic over exactly this
 * set.
 */
export function foldedHunkIndexes(
  classification: FileClassification,
  threadBearingHunks?: ReadonlySet<number>,
): Set<number> {
  const folded = new Set<number>()

  if (classification.reason !== null)
    return folded

  classification.hunks.forEach((hunk, index) => {
    if (hunk.kind === 'logic')
      return

    if (threadBearingHunks?.has(index))
      return

    folded.add(index)
  })

  return folded
}

export function classifyFile(file: DiffFile): FileClassification {
  const moved = movedRuns(file).removed
  const hunks = file.hunks.map(hunk => classifyHunk(hunk, moved))
  const mechanical = hunks.filter(one => one.kind !== 'logic').length
  const allMechanical = hunks.every(one => one.kind !== 'logic')

  const kinds = new Set(hunks.map(one => one.kind))
  const reason = allMechanical && kinds.size === 1 ? [...kinds][0]! : null

  return { hunks, mechanical, allMechanical, reason }
}

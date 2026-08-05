/**
 * What changed *within* a line.
 *
 * A diff that only says "this line went, that line arrived" makes the reader do
 * the comparison themselves, character by character, on every line. On a line
 * where one argument moved or one word changed, almost all of the colour is
 * noise and the actual change is three characters somewhere in the middle.
 *
 * So a removed line and the added line that replaced it are compared word by
 * word, and only the parts that differ are marked.
 *
 * Reported as character ranges rather than as pieces of text, because the line
 * has already been split into syntax tokens by the time anything renders it.
 * Ranges can be intersected with those tokens; a second list of substrings
 * could not be, without one of the two winning and the other being dropped.
 */

export interface CharRange {
  start: number
  /** Exclusive. */
  end: number
}

export interface InlineDiff {
  before: CharRange[]
  after: CharRange[]
}

/** Nothing marked, which is what every bail-out returns. */
const NOTHING: InlineDiff = { before: [], after: [] }

/**
 * Past this, the two lines are treated as wholly different.
 *
 * The word diff is quadratic in the size of the differing middle, and a pair of
 * minified lines is tens of thousands of tokens. Above the ceiling the reader
 * gets the plain line-level colouring, which is what they would have had
 * anyway.
 */
const MAX_TOKENS = 320

/**
 * Split a line into the units a reader compares.
 *
 * Words, runs of whitespace, and single punctuation characters. Splitting on
 * whitespace alone marks `foo(bar)` as entirely changed when only `bar` moved;
 * splitting per character marks half the alphabet and reads as static.
 */
export function splitWords(line: string): string[] {
  return line.match(/[A-Z0-9_$]+|\s+|[^A-Z0-9_$\s]/gi) ?? []
}

/**
 * The parts of two lines that differ.
 *
 * Common prefix and suffix are trimmed first, which handles the ordinary case -
 * one word changed in the middle of a long line - without the quadratic step
 * running at all.
 */
export function inlineChangedRanges(before: string, after: string): InlineDiff {
  if (before === after || before === '' || after === '')
    return NOTHING

  const beforeWords = splitWords(before)
  const afterWords = splitWords(after)

  let prefix = 0
  while (
    prefix < beforeWords.length
    && prefix < afterWords.length
    && beforeWords[prefix] === afterWords[prefix]
  ) {
    prefix++
  }

  let suffix = 0
  while (
    suffix < beforeWords.length - prefix
    && suffix < afterWords.length - prefix
    && beforeWords[beforeWords.length - 1 - suffix] === afterWords[afterWords.length - 1 - suffix]
  ) {
    suffix++
  }

  const beforeMiddle = beforeWords.slice(prefix, beforeWords.length - suffix)
  const afterMiddle = afterWords.slice(prefix, afterWords.length - suffix)

  // Identical lines are caught above, so at least one middle has something in
  // it. When only one does, the whole of it is an insertion or a deletion.
  if (beforeMiddle.length === 0 && afterMiddle.length === 0)
    return NOTHING

  const beforeStart = offsetOf(beforeWords, prefix)
  const afterStart = offsetOf(afterWords, prefix)

  if (beforeMiddle.length > MAX_TOKENS || afterMiddle.length > MAX_TOKENS) {
    return {
      before: spanOf(beforeStart, beforeMiddle),
      after: spanOf(afterStart, afterMiddle),
    }
  }

  const { beforeChanged, afterChanged } = alignWords(beforeMiddle, afterMiddle)

  return {
    before: rangesFrom(beforeMiddle, beforeChanged, beforeStart),
    after: rangesFrom(afterMiddle, afterChanged, afterStart),
  }
}

/**
 * Which words in each middle are not part of the longest common subsequence.
 *
 * The subsequence is what the two lines still share once the easy prefix and
 * suffix are gone; everything else is what changed. Bounded by `MAX_TOKENS`
 * above, so the table is at most 320 by 320.
 */
function alignWords(before: string[], after: string[]): { beforeChanged: boolean[], afterChanged: boolean[] } {
  const rows = before.length
  const columns = after.length
  const table: number[][] = Array.from({ length: rows + 1 }, () => Array.from({ length: columns + 1 }, () => 0))

  for (let i = rows - 1; i >= 0; i--) {
    for (let j = columns - 1; j >= 0; j--) {
      table[i]![j] = before[i] === after[j]
        ? table[i + 1]![j + 1]! + 1
        : Math.max(table[i + 1]![j]!, table[i]![j + 1]!)
    }
  }

  const beforeChanged = Array.from({ length: rows }, () => true)
  const afterChanged = Array.from({ length: columns }, () => true)

  let i = 0
  let j = 0
  while (i < rows && j < columns) {
    if (before[i] === after[j]) {
      beforeChanged[i] = false
      afterChanged[j] = false
      i++
      j++
    }
    else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      i++
    }
    else {
      j++
    }
  }

  return { beforeChanged, afterChanged }
}

/** Where a word sits in the line it came from. */
function offsetOf(words: string[], index: number): number {
  let offset = 0
  for (let i = 0; i < index; i++)
    offset += words[i]!.length

  return offset
}

/** One range covering every word in `middle`. */
function spanOf(start: number, middle: string[]): CharRange[] {
  const length = middle.reduce((sum, word) => sum + word.length, 0)
  return length === 0 ? [] : [{ start, end: start + length }]
}

/**
 * Turn per-word flags into character ranges, merging neighbours.
 *
 * Merged because a changed word followed by a changed space followed by another
 * changed word is one edit to a reader, and three separate marks on it look
 * like three.
 */
function rangesFrom(words: string[], changed: boolean[], start: number): CharRange[] {
  const ranges: CharRange[] = []
  let offset = start
  let open: CharRange | null = null

  for (let index = 0; index < words.length; index++) {
    const length = words[index]!.length

    if (changed[index]) {
      if (open && open.end === offset)
        open.end = offset + length
      else
        ranges.push(open = { start: offset, end: offset + length })
    }

    offset += length
  }

  return ranges
}

/**
 * Whether a pair of lines is worth comparing at all.
 *
 * Two lines that share almost nothing are a deletion and an unrelated addition
 * that happen to be adjacent, and marking nine tenths of both is worse than
 * marking neither: it says "everything changed" in a way that hides the lines
 * where something specific did.
 */
export function worthComparing(before: string, after: string, diff: InlineDiff): boolean {
  const changed = (ranges: CharRange[]) => ranges.reduce((sum, range) => sum + (range.end - range.start), 0)
  const total = before.length + after.length
  if (total === 0)
    return false

  return (changed(diff.before) + changed(diff.after)) / total <= 0.7
}

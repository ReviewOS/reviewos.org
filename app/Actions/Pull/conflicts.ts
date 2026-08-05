/**
 * Conflict markers, parsed into regions.
 *
 * When a merge fails, git writes both versions into the file separated by
 * markers and leaves it there. That file is not a diff and it is not source
 * either: it is two files interleaved, and reading it as one is exactly why
 * conflicts are unpleasant to resolve in a browser.
 *
 * Everything here is pure over a string. The markers are recognised only at the
 * start of a line and only in git's exact form - seven characters followed by a
 * space or the end of the line - because the alternative is a heuristic, and a
 * heuristic that fires inside a string literal turns a working file into a
 * mangled one.
 *
 * The four markers, in the order git writes them:
 *
 *     <<<<<<< ours
 *     our version
 *     ||||||| base          (only with merge.conflictStyle = diff3 or zdiff3)
 *     the common ancestor
 *     =======
 *     their version
 *     >>>>>>> theirs
 */

/** Exactly seven of the character, then a space or the end of the line. */
const OURS = /^<{7}(?: (.*))?$/
const BASE = /^\|{7}(?: (.*))?$/
const SPLIT = /^={7}$/
const THEIRS = /^>{7}(?: (.*))?$/

export interface ConflictSide {
  /** What git wrote beside the marker: a branch, a commit, `HEAD`. */
  label: string
  lines: string[]
}

export interface ConflictRegion {
  type: 'conflict'
  ours: ConflictSide
  /** Present only in diff3 style, where git includes the common ancestor. */
  base: ConflictSide | null
  theirs: ConflictSide
  /** Where the region starts in the file, counting from one. */
  startLine: number
}

export interface TextRegion {
  type: 'text'
  lines: string[]
  startLine: number
}

export type FileRegion = TextRegion | ConflictRegion

/**
 * Split a conflicted file into ordinary text and conflict regions.
 *
 * A file with no markers comes back as one text region, which is the same shape
 * a caller handles anyway - there is no separate "not conflicted" answer to
 * forget to handle.
 *
 * Malformed input is treated as text rather than guessed at. A `<<<<<<<` with
 * no `=======` after it is not a conflict git wrote; it is a line of somebody's
 * code, or a file that has already been half-resolved by hand, and inventing a
 * region around it would offer to "accept" one side of something that has no
 * sides.
 */
export function parseConflicts(text: string): FileRegion[] {
  const lines = text.split('\n')
  const regions: FileRegion[] = []

  let plain: string[] = []
  let plainStart = 1

  const flush = () => {
    if (plain.length > 0) {
      regions.push({ type: 'text', lines: plain, startLine: plainStart })
      plain = []
    }
  }

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!
    const opens = OURS.exec(line)

    if (!opens) {
      if (plain.length === 0)
        plainStart = index + 1
      plain.push(line)
      continue
    }

    const region = readConflict(lines, index)

    if (region == null) {
      // No closing marker: not a conflict, whatever it looks like.
      if (plain.length === 0)
        plainStart = index + 1
      plain.push(line)
      continue
    }

    flush()
    regions.push(region.conflict)
    index = region.end
  }

  flush()

  return regions
}

/**
 * Read one conflict starting at `start`, or null if it never closes.
 *
 * Nested markers are not a thing git produces, and a `<<<<<<<` appearing inside
 * a conflict body is treated as content: taking it as the start of an inner
 * conflict would mean the outer one never closes and the whole rest of the file
 * disappears into a region nobody can resolve.
 */
function readConflict(
  lines: readonly string[],
  start: number,
): { conflict: ConflictRegion, end: number } | null {
  const ours: ConflictSide = { label: OURS.exec(lines[start]!)?.[1] ?? '', lines: [] }
  let base: ConflictSide | null = null
  const theirs: ConflictSide = { label: '', lines: [] }

  let side: 'ours' | 'base' | 'theirs' = 'ours'

  for (let index = start + 1; index < lines.length; index++) {
    const line = lines[index]!

    const startsBase = BASE.exec(line)
    if (startsBase && side === 'ours') {
      base = { label: startsBase[1] ?? '', lines: [] }
      side = 'base'
      continue
    }

    if (SPLIT.test(line) && side !== 'theirs') {
      side = 'theirs'
      continue
    }

    const closes = THEIRS.exec(line)
    if (closes) {
      // A `>>>>>>>` before any `=======` is not a close, it is content: the
      // region has no second side yet.
      if (side !== 'theirs')
        return null

      theirs.label = closes[1] ?? ''
      return {
        conflict: { type: 'conflict', ours, base, theirs, startLine: start + 1 },
        end: index,
      }
    }

    if (side === 'ours')
      ours.lines.push(line)
    else if (side === 'base')
      base!.lines.push(line)
    else
      theirs.lines.push(line)
  }

  return null
}

/** Whether a file has anything left to resolve. */
export function hasConflicts(regions: readonly FileRegion[]): boolean {
  return regions.some(region => region.type === 'conflict')
}

/** How many regions are still conflicted. */
export function countConflicts(regions: readonly FileRegion[]): number {
  return regions.filter(region => region.type === 'conflict').length
}

export type ConflictChoice = 'ours' | 'theirs' | 'both'

/**
 * Resolve one conflict region and give back the whole file.
 *
 * By position among the *conflict* regions rather than among all regions, which
 * is how a reader counts them: "the third conflict", not "the seventh region".
 *
 * The base is never part of an answer. It is context - what the line looked
 * like before either side touched it - and a resolution that included it would
 * be a third version nobody wrote.
 */
export function resolveConflict(
  regions: readonly FileRegion[],
  conflictIndex: number,
  choice: ConflictChoice,
): string {
  let seen = -1

  const out: string[] = []

  for (const region of regions) {
    if (region.type === 'text') {
      out.push(...region.lines)
      continue
    }

    seen += 1

    if (seen !== conflictIndex) {
      // Left exactly as it was, markers and all, so resolving one conflict does
      // not quietly commit to an answer on the others.
      out.push(...conflictLines(region))
      continue
    }

    if (choice === 'ours')
      out.push(...region.ours.lines)
    else if (choice === 'theirs')
      out.push(...region.theirs.lines)
    else
      out.push(...region.ours.lines, ...region.theirs.lines)
  }

  return out.join('\n')
}

/** A conflict region written back out exactly as git had it. */
function conflictLines(region: ConflictRegion): string[] {
  const lines = [region.ours.label ? `<<<<<<< ${region.ours.label}` : '<<<<<<<']
  lines.push(...region.ours.lines)

  if (region.base != null) {
    lines.push(region.base.label ? `||||||| ${region.base.label}` : '|||||||')
    lines.push(...region.base.lines)
  }

  lines.push('=======')
  lines.push(...region.theirs.lines)
  lines.push(region.theirs.label ? `>>>>>>> ${region.theirs.label}` : '>>>>>>>')

  return lines
}

/** The file as it stands, markers included. The inverse of `parseConflicts`. */
export function writeConflicts(regions: readonly FileRegion[]): string {
  const out: string[] = []

  for (const region of regions) {
    if (region.type === 'text')
      out.push(...region.lines)
    else
      out.push(...conflictLines(region))
  }

  return out.join('\n')
}

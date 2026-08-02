/**
 * The references that make issue text useful: `#12`, `@handle`,
 * `owner/repo#12`, and bare commit SHAs, plus the closing keywords that link a
 * commit or a pull request to the issue it resolves.
 *
 * Pure parsing over a string. Turning a reference into a link needs the
 * database (does that issue exist? is it visible to this reader?), and that is
 * the caller's job; what a reference *is* lives here so it can be tested
 * against the ways text lies.
 */

/** Keywords git hosts have taught people to write. */
export const CLOSING_KEYWORDS = [
  'close',
  'closes',
  'closed',
  'fix',
  'fixes',
  'fixed',
  'resolve',
  'resolves',
  'resolved',
] as const

export interface IssueReference {
  /** Null when the reference is to an issue in the same repository. */
  owner: string | null
  repository: string | null
  number: number
}

export interface UserReference {
  handle: string
}

export interface ClosingReference extends IssueReference {
  keyword: string
}

/**
 * A reference together with where it sits in the text.
 *
 * The renderer needs the position to replace the reference with a link and
 * leave the rest of the run alone; everything else only cares what the
 * reference means, which is why the plain functions below drop it.
 */
export interface Located<T> {
  value: T
  index: number
  length: number
}

/**
 * Spans that are not prose: fenced blocks, indented blocks, and inline code.
 *
 * Everything below ignores these. `#1` inside a code sample is a comment or a
 * shell argument, and turning it into a link is both wrong and, for closing
 * keywords, destructive: a commit that quotes `fixes #12` in an example would
 * otherwise close issue 12.
 */
export function codeSpans(text: string): Array<[number, number]> {
  const spans: Array<[number, number]> = []
  const lines = text.split('\n')

  let offset = 0
  let fenceMarker: string | null = null
  let fenceStart = 0

  // Scanned a line at a time rather than by regex: a fence is a line-oriented
  // construct, and a regex that has to cope with an unterminated one either
  // stops early or swallows the rest of the document. Both were wrong here in
  // ways that only showed up on text with a fence in the middle.
  for (const line of lines) {
    const lineEnd = offset + line.length
    const opening = /^[ \t]*(`{3,}|~{3,})/.exec(line)

    if (fenceMarker === null) {
      if (opening) {
        fenceMarker = opening[1]![0]!
        fenceStart = offset
      }
    }
    else {
      // A fence closes on a line of the same character, at least as long.
      const closing = /^[ \t]*(`{3,}|~{3,})[ \t]*$/.exec(line)
      if (closing && closing[1]![0] === fenceMarker) {
        spans.push([fenceStart, lineEnd])
        fenceMarker = null
      }
    }

    offset = lineEnd + 1
  }

  // An unterminated fence runs to the end, which is how a renderer treats it.
  if (fenceMarker !== null)
    spans.push([fenceStart, text.length])

  const inline = /`+[^`\n]*`+/g
  for (const match of text.matchAll(inline)) {
    const start = match.index!
    if (!spans.some(([from, to]) => start >= from && start < to))
      spans.push([start, start + match[0].length])
  }

  return spans
}

/**
 * Whether the whitespace-delimited token containing `index` is a URL.
 *
 * `https://example.com/page#12` is an anchor and `owner/repo#12` is a
 * reference, and they are the same shape once the scheme is out of view.
 */
function inUrl(text: string, index: number): boolean {
  let start = index
  while (start > 0 && !/\s/.test(text[start - 1]!))
    start -= 1

  let end = index
  while (end < text.length && !/\s/.test(text[end]!))
    end += 1

  return text.slice(start, end).includes('://')
}

function inCode(spans: Array<[number, number]>, index: number): boolean {
  return spans.some(([from, to]) => index >= from && index < to)
}

/**
 * Issue references: `#12` and `owner/repo#12`.
 *
 * A `#` immediately after a word character is skipped: `abc#12` is part of a
 * URL fragment or an anchor far more often than it is a reference.
 */
export function scanIssueReferences(text: string): Array<Located<IssueReference>> {
  const spans = codeSpans(text)
  const found: Array<Located<IssueReference>> = []
  const pattern = /(?:([A-Za-z0-9][\w.-]*)\/([A-Za-z0-9][\w.-]*))?#(\d+)\b/g

  for (const match of text.matchAll(pattern)) {
    const index = match.index!

    if (inCode(spans, index) || inUrl(text, index))
      continue

    const before = index > 0 ? text[index - 1]! : ''
    // Only skip when the character before the `#` itself is a word character
    // and there is no owner/repo prefix.
    if (!match[1] && /[\w]/.test(before))
      continue

    const number = Number(match[3])
    if (number === 0)
      continue

    found.push({
      value: {
        owner: match[1] ?? null,
        repository: match[2] ?? null,
        number,
      },
      index,
      length: match[0].length,
    })
  }

  return found
}

export function issueReferences(text: string): IssueReference[] {
  return scanIssueReferences(text).map(found => found.value)
}

/** Mentions: `@handle`, with their positions. */
export function scanUserReferences(text: string): Array<Located<UserReference>> {
  const spans = codeSpans(text)
  const found: Array<Located<UserReference>> = []
  const pattern = /@([A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?)\b/g

  for (const match of text.matchAll(pattern)) {
    const index = match.index!

    if (inCode(spans, index))
      continue

    // `user@example.com` is an email address, not a mention.
    const before = index > 0 ? text[index - 1]! : ''
    if (/[\w.-]/.test(before))
      continue

    found.push({
      value: { handle: match[1]!.toLowerCase() },
      index,
      length: match[0].length,
    })
  }

  return found
}

/** Mentions: `@handle`. */
export function userReferences(text: string): UserReference[] {
  return scanUserReferences(text).map(found => found.value)
}

/** Bare commit SHAs, at least 7 hex characters, with their positions. */
export function scanCommitReferences(text: string): Array<Located<string>> {
  const spans = codeSpans(text)
  const found: Array<Located<string>> = []
  const pattern = /\b([0-9a-f]{7,40})\b/g

  for (const match of text.matchAll(pattern)) {
    if (inCode(spans, match.index!))
      continue

    // A run of decimal digits is a number, not a SHA.
    if (/^\d+$/.test(match[1]!))
      continue

    found.push({ value: match[1]!, index: match.index!, length: match[0].length })
  }

  return found
}

/** Bare commit SHAs, at least 7 hex characters. */
export function commitReferences(text: string): string[] {
  return scanCommitReferences(text).map(found => found.value)
}

/**
 * Issues a piece of text says it closes.
 *
 * Used on push and on merge, so a false positive closes somebody's issue: the
 * keyword must be its own word, and the reference must follow it directly.
 */
export function closingReferences(text: string): ClosingReference[] {
  const spans = codeSpans(text)
  const found: ClosingReference[] = []
  const keywords = CLOSING_KEYWORDS.join('|')
  const pattern = new RegExp(
    `\\b(${keywords})\\b\\s*:?\\s+(?:([A-Za-z0-9][\\w.-]*)\\/([A-Za-z0-9][\\w.-]*))?#(\\d+)\\b`,
    'gi',
  )

  for (const match of text.matchAll(pattern)) {
    if (inCode(spans, match.index!) || inUrl(text, match.index!))
      continue

    const number = Number(match[4])
    if (number === 0)
      continue

    found.push({
      keyword: match[1]!.toLowerCase(),
      owner: match[2] ?? null,
      repository: match[3] ?? null,
      number,
    })
  }

  return found
}

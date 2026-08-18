/**
 * Finding a line in a run's output.
 *
 * A failed job prints ten thousand lines and the one that matters says
 * `error TS2345`. Scrolling is what people do instead of searching, and the
 * reason they do it is that the search box does not exist - so this is a small
 * feature that removes a large amount of scrolling.
 *
 * **Line numbers run across the whole job**, not per chunk and not per group.
 * A chunk is how the log arrived and a group is how it is displayed; neither is
 * something a reader counts, and a link that lands on "line 12 of the fourth
 * chunk" lands nowhere a person can check.
 */

/** One line that matched, and where to find it. */
export interface LogMatch {
  jobId: number
  jobName: string
  /** The line's number within this job's whole log, counting from one. */
  line: number
  text: string
}

/** The most matches to report. Past this, the query is the thing to change. */
export const MAX_MATCHES = 50

/**
 * The lines of one job's log that contain `query`.
 *
 * Case-insensitive and plain text, deliberately: a regular expression box on a
 * log search is a way to hang the server on a pattern somebody pasted, and the
 * thing people type is a symbol name or an error code.
 */
export function searchLog(input: {
  jobId: number
  jobName: string
  text: string
  query: string
  limit?: number
}): LogMatch[] {
  const query = String(input.query ?? '').trim().toLowerCase()

  if (!query)
    return []

  const limit = Math.max(1, Math.min(input.limit ?? MAX_MATCHES, MAX_MATCHES))
  const matches: LogMatch[] = []
  const lines = String(input.text ?? '').split('\n')

  for (const [index, line] of lines.entries()) {
    if (!line.toLowerCase().includes(query))
      continue

    matches.push({
      jobId: input.jobId,
      jobName: input.jobName,
      // Counting from one, because that is what an editor, a compiler and a
      // person all mean by a line number.
      line: index + 1,
      /*
       * Trimmed, and clipped in the middle rather than at the end: a match on a
       * minified line is a thousand characters of noise around six that matter,
       * and clipping at the end usually cuts off the part somebody searched for.
       */
      text: clip(line.trim(), query),
    })

    if (matches.length >= limit)
      break
  }

  return matches
}

/** At most 200 characters, centred on what matched. */
function clip(line: string, query: string): string {
  if (line.length <= 200)
    return line

  const at = line.toLowerCase().indexOf(query)
  const from = Math.max(0, at - 80)
  const to = Math.min(line.length, at + query.length + 80)

  return `${from > 0 ? '…' : ''}${line.slice(from, to)}${to < line.length ? '…' : ''}`
}

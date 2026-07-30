/**
 * Suggested changes inside review comments.
 *
 * A ```suggestion block is a review comment that can be committed with one
 * click, which means a parser being loose here writes the wrong thing into
 * somebody's branch. It is deliberately strict: the fence must open the block
 * on its own line and close it on its own line.
 */

/**
 * The replacement text of the first suggestion block, or null if there is none.
 *
 * An empty block is a real suggestion: it means delete these lines.
 */
export function suggestionIn(body: string): string | null {
  const lines = body.split('\n')

  let start = -1
  for (let index = 0; index < lines.length; index += 1) {
    if (/^[ \t]*```suggestion[ \t]*$/.test(lines[index]!)) {
      start = index
      break
    }
  }

  if (start === -1)
    return null

  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^[ \t]*```[ \t]*$/.test(lines[index]!))
      return lines.slice(start + 1, index).join('\n')
  }

  // Unterminated: the author is probably still typing, and committing a
  // half-written block would be worse than showing none.
  return null
}

/**
 * Apply a suggestion to the lines of a file.
 *
 * `from` and `to` are 1-based and inclusive, matching how a thread records the
 * lines it covers. Returns null when the range does not fit the file, which is
 * what a suggestion on an outdated thread looks like.
 */
export function applySuggestion(fileLines: string[], from: number, to: number, replacement: string): string[] | null {
  if (from < 1 || to < from || to > fileLines.length)
    return null

  const replacementLines = replacement === '' ? [] : replacement.split('\n')

  return [...fileLines.slice(0, from - 1), ...replacementLines, ...fileLines.slice(to)]
}

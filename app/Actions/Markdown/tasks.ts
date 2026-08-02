/**
 * Ticking a task list item from the rendered issue.
 *
 * The rendered HTML is not the document; the markdown source is. So a checkbox
 * in the browser sends "item N changed to checked" and the source is edited
 * here, character for character, leaving everything else exactly as it was.
 *
 * That last part is the whole job. Round-tripping through a markdown parser
 * would reformat somebody's carefully spaced list, and a regex replace over the
 * whole body would tick the wrong box the moment two items share a line prefix.
 * This finds the Nth item and rewrites three characters of it.
 */

/** A task list item, in source order, as the renderer numbers them. */
export interface TaskItem {
  /** Zero-based, matching the index the rendered checkbox carries. */
  index: number
  /** Zero-based line the item is on. */
  line: number
  checked: boolean
  /** The text after the checkbox, trimmed. */
  label: string
}

/**
 * A task list item is a list marker, then `[ ]` or `[x]`, then a space.
 *
 * The trailing space is required by the same rule the renderers use: `- [x]foo`
 * is not a task item, it is a list item whose text starts with a bracket. Any
 * indentation is allowed, because nested task lists are ordinary.
 */
const TASK_LINE = /^(\s*(?:[-*+]|\d+[.)])\s+\[)([ xX])(\]\s)/

/** Spans of the text that are fenced code, which the renderer does not read as lists. */
function fencedLines(lines: string[]): Set<number> {
  const inside = new Set<number>()
  let marker: string | null = null

  for (let index = 0; index < lines.length; index++) {
    const opening = /^\s*(`{3,}|~{3,})/.exec(lines[index]!)

    if (marker === null) {
      if (opening) {
        marker = opening[1]![0]!
        inside.add(index)
      }
      continue
    }

    inside.add(index)
    const closing = /^\s*(`{3,}|~{3,})\s*$/.exec(lines[index]!)
    if (closing && closing[1]![0] === marker)
      marker = null
  }

  return inside
}

/**
 * Every task item in a body, in the order the renderer emits them.
 *
 * The order is the contract: the browser sends an index, and it has to mean the
 * same item on both sides. Items inside fenced code are skipped here for the
 * same reason the renderer does not turn them into checkboxes.
 */
export function taskItems(source: string): TaskItem[] {
  const lines = source.split('\n')
  const fenced = fencedLines(lines)
  const items: TaskItem[] = []

  for (let line = 0; line < lines.length; line++) {
    if (fenced.has(line))
      continue

    const match = TASK_LINE.exec(lines[line]!)
    if (!match)
      continue

    items.push({
      index: items.length,
      line,
      checked: match[2]!.toLowerCase() === 'x',
      label: lines[line]!.slice(match[0].length).trim(),
    })
  }

  return items
}

export type ToggleResult =
  | { ok: true, source: string, changed: boolean }
  | { ok: false, error: string }

/**
 * Set one item's state, by index.
 *
 * Refuses an index it cannot find rather than doing nothing quietly: a stale
 * page ticking item 4 of a list that now has three is a person about to think
 * they changed something.
 *
 * `expected` guards the same staleness from the other direction. Two people on
 * the same issue, one ticking and one unticking, should not have the second
 * write silently undo a state the second person never saw - so the caller sends
 * what it believed the item was, and a mismatch is reported rather than
 * overwritten.
 */
export function toggleTask(source: string, index: number, checked: boolean, expected?: boolean): ToggleResult {
  if (!Number.isInteger(index) || index < 0)
    return { ok: false, error: 'That is not a task' }

  const items = taskItems(source)
  const item = items[index]

  if (!item)
    return { ok: false, error: 'That task is no longer in this text' }

  if (expected !== undefined && item.checked !== expected)
    return { ok: false, error: 'Somebody else changed that task first' }

  if (item.checked === checked)
    return { ok: true, source, changed: false }

  const lines = source.split('\n')
  const match = TASK_LINE.exec(lines[item.line]!)!
  const rest = lines[item.line]!.slice(match[0].length)

  // Rebuilt from the captured pieces, so the marker, the indentation and the
  // spacing after the bracket are all exactly what the author typed.
  lines[item.line] = `${match[1]}${checked ? 'x' : ' '}${match[3]}${rest}`

  return { ok: true, source: lines.join('\n'), changed: true }
}

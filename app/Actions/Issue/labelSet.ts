/**
 * The rules for managing a repository's set of labels and milestones.
 *
 * Pure, so they can be tested without a database, and shared so the create and
 * update paths cannot drift apart: the second one is where validation is
 * usually forgotten, because the value "was already valid once".
 */

import { normalizeColor, normalizeLabelName } from './labels'

export interface LabelInput {
  name?: unknown
  color?: unknown
  description?: unknown
}

export interface LabelFields {
  name: string
  color: string
  description: string | null
}

export type Validated<T> = { ok: true, value: T } | { ok: false, error: string }

/** Descriptions are optional, and an empty one is stored as absent rather than as `''`. */
function description(raw: unknown): { ok: true, value: string | null } | { ok: false, error: string } {
  if (raw === undefined || raw === null)
    return { ok: true, value: null }

  const text = String(raw).trim()
  if (text.length > 200)
    return { ok: false, error: 'That description is too long' }

  return { ok: true, value: text || null }
}

/**
 * A label as it will be stored.
 *
 * The name and colour go through the same normalizers the default label set
 * uses, so a hand-made label and a seeded one are the same shape: `#FFF`
 * becomes `#ffffff`, and a name is trimmed and collapsed.
 */
export function labelFields(input: LabelInput): Validated<LabelFields> {
  const name = normalizeLabelName(String(input.name ?? ''))
  if (!name)
    return { ok: false, error: 'A label needs a name' }

  const color = normalizeColor(String(input.color ?? ''))
  if (!color)
    return { ok: false, error: 'That is not a colour' }

  const text = description(input.description)
  if (!text.ok)
    return { ok: false, error: text.error }

  return { ok: true, value: { name, color, description: text.value } }
}

export interface MilestoneInput {
  title?: unknown
  description?: unknown
  due_on?: unknown
}

export interface MilestoneFields {
  title: string
  description: string | null
  due_on: string | null
}

/**
 * A due date, as a plain calendar day.
 *
 * Stored as `YYYY-MM-DD` rather than as an instant: a milestone is due on a
 * day, and attaching a time to it means the day changes depending on who is
 * reading. Anything else is rejected rather than guessed at, because a date
 * parser that accepts everything is how `01/02` becomes the wrong month.
 */
export function dueOn(raw: unknown): { ok: true, value: string | null } | { ok: false, error: string } {
  if (raw === undefined || raw === null || String(raw).trim() === '')
    return { ok: true, value: null }

  const text = String(raw).trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text))
    return { ok: false, error: 'A due date looks like 2026-08-02' }

  const [year, month, day] = text.split('-').map(Number) as [number, number, number]
  const date = new Date(Date.UTC(year, month - 1, day))

  // Round-tripping catches the dates that parse but do not exist: `2026-02-30`
  // rolls forward to March rather than failing.
  const valid = date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day

  return valid ? { ok: true, value: text } : { ok: false, error: 'There is no such date' }
}

export function milestoneFields(input: MilestoneInput): Validated<MilestoneFields> {
  const title = String(input.title ?? '').trim().replace(/\s+/g, ' ')
  if (!title)
    return { ok: false, error: 'A milestone needs a title' }

  if (title.length > 120)
    return { ok: false, error: 'That title is too long' }

  const text = description(input.description)
  if (!text.ok)
    return { ok: false, error: text.error }

  const due = dueOn(input.due_on)
  if (!due.ok)
    return { ok: false, error: due.error }

  return { ok: true, value: { title, description: text.value, due_on: due.value } }
}

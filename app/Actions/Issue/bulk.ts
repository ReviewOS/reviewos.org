/**
 * What a bulk operation from the issue list is allowed to be.
 *
 * Pure, and deliberately small. Bulk actions are the ones that go wrong at
 * scale: a mis-parsed selection closes forty issues instead of four, and the
 * only person who notices is whoever gets forty notifications.
 */

/** Operations the list offers. Anything else is refused rather than guessed at. */
export const BULK_OPERATIONS = ['close', 'reopen', 'label', 'unlabel', 'milestone'] as const

export type BulkOperation = typeof BULK_OPERATIONS[number]

export function isBulkOperation(value: unknown): value is BulkOperation {
  return typeof value === 'string' && (BULK_OPERATIONS as readonly string[]).includes(value)
}

/**
 * How many issues one request may touch.
 *
 * A page of the list is fifty, so this covers "select all on this page" and
 * nothing beyond it. A request naming five hundred is either a mistake or
 * somebody scripting against the endpoint, and both are better refused than
 * half-applied.
 */
export const BULK_LIMIT = 50

export type SelectionResult =
  | { ok: true, numbers: number[] }
  | { ok: false, error: string }

/**
 * The issue numbers a request selected.
 *
 * A form sends one value when one box is ticked and an array when several are,
 * so both shapes arrive here. Anything that is not a positive whole number is
 * refused rather than dropped: silently ignoring an unparseable entry means
 * acting on a smaller set than the person chose, and they are looking at a
 * confirmation that says otherwise.
 */
export function selectedNumbers(raw: unknown): SelectionResult {
  const values = Array.isArray(raw) ? raw : (raw === undefined || raw === null ? [] : [raw])

  if (values.length === 0)
    return { ok: false, error: 'Nothing was selected' }

  if (values.length > BULK_LIMIT)
    return { ok: false, error: `That is more than ${BULK_LIMIT} issues` }

  const numbers: number[] = []
  for (const value of values) {
    const number = Number(String(value).trim())

    if (!Number.isInteger(number) || number <= 0)
      return { ok: false, error: 'That is not an issue number' }

    if (!numbers.includes(number))
      numbers.push(number)
  }

  return { ok: true, numbers }
}

/** The ability a given operation needs, so the check cannot be forgotten per branch. */
export function abilityFor(operation: BulkOperation): 'issue:close' | 'issue:label' | 'issue:milestone' {
  if (operation === 'close' || operation === 'reopen')
    return 'issue:close'

  if (operation === 'milestone')
    return 'issue:milestone'

  return 'issue:label'
}

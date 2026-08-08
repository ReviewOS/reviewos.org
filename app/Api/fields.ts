/**
 * Ask for the fields you need.
 *
 * **A pull request list that always carries every body is expensive on both
 * ends.** A repository with four hundred open pull requests, each with a
 * paragraph of description, is a megabyte of prose to build a list of titles -
 * and the caller building that list throws every body away.
 *
 * The cost is not only bytes. A field nobody asked for is a field the server
 * had to read, and the expensive ones tend to be exactly the ones a list does
 * not need: the body, the label set, the review state, the check summary. Each
 * is a query.
 *
 * So `?fields=number,title,state` narrows the response, and a caller that asks
 * for nothing gets everything - because breaking every existing client to save
 * bytes for the ones that opt in would be the wrong trade.
 */

/**
 * The requested field set, or null for "everything".
 *
 * Null rather than an empty set, because the two mean opposite things and
 * conflating them is how `?fields=` with a typo returns an empty object instead
 * of the whole resource.
 */
export function readFields(raw: unknown): Set<string> | null {
  const text = String(raw ?? '').trim()
  if (!text)
    return null

  const wanted = text
    .split(',')
    .map(field => field.trim())
    .filter(Boolean)

  return wanted.length > 0 ? new Set(wanted) : null
}

/**
 * One object, narrowed.
 *
 * **Unknown field names are ignored rather than refused.** A client asking for
 * `titel` gets the fields it spelled correctly and nothing for the one it did
 * not, which is recoverable; a 422 for a typo in an optional optimisation is a
 * client that stops using the optimisation. The absence of the field in the
 * response is the feedback.
 */
export function pick<T extends Record<string, unknown>>(row: T, fields: Set<string> | null): Partial<T> {
  if (!fields)
    return row

  const narrowed: Record<string, unknown> = {}

  for (const field of fields) {
    if (field in row)
      narrowed[field] = row[field]
  }

  return narrowed as Partial<T>
}

/** The same, over a list. */
export function pickAll<T extends Record<string, unknown>>(rows: readonly T[], fields: Set<string> | null): Array<Partial<T>> {
  if (!fields)
    return [...rows]

  return rows.map(row => pick(row, fields))
}

/**
 * Fields a caller cannot drop.
 *
 * An identifier is not optional even when it was not asked for: a list of
 * objects with no id is a list nothing can be done with, and a client that
 * omitted it did so by accident every time. Merged into the set rather than
 * appended to the response, so the ordering of the object stays whatever the
 * serializer chose.
 */
export function withRequired(fields: Set<string> | null, required: readonly string[]): Set<string> | null {
  if (!fields)
    return null

  const complete = new Set(fields)
  for (const field of required)
    complete.add(field)

  return complete
}

/**
 * Whether an expensive field was asked for.
 *
 * The point of the whole feature: a serializer that narrows *after* reading
 * every column has saved the transfer and none of the work. Callers ask this
 * before running the query that produces a field, so `?fields=number,title`
 * genuinely skips the body read rather than reading and discarding it.
 */
export function wants(fields: Set<string> | null, field: string): boolean {
  return fields === null || fields.has(field)
}

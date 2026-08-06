/**
 * Writing to many rows at once.
 *
 * These exist because of one defect in the query builder, and they exist in one
 * place so that defect is worked around once rather than remembered at every
 * call site.
 *
 * `where(column, operator, value)` splices the operator into the statement and
 * puts a single placeholder after it. On a `SELECT` that is fine, because the
 * select path renders `IN` itself and expands the array. On an `UPDATE` or a
 * `DELETE` it is not: the array becomes one parameter and the statement reads
 *
 *     DELETE FROM "issue_labels" WHERE "issue_id" in $1
 *
 * which Postgres answers with `syntax error at or near "$1"`. So every bulk
 * update and every bulk delete in this application failed, and failed in the
 * way that is hardest to notice - the same call spelled the same way *does*
 * work everywhere it is a read, so the pattern looks proven.
 *
 * The statements below are built by hand and every value is bound. Table and
 * column names are supplied by this codebase rather than by a request, and are
 * quoted rather than trusted, so a name with a quote in it is a syntax error
 * here rather than a statement somewhere else.
 *
 * When the builder renders `IN` on writes, these become one-line wrappers and
 * then go away.
 */

/** How many values one `IN (…)` may carry. Postgres tolerates more; drivers vary. */
export const IN_CHUNK = 1000

/**
 * Delete every row whose `column` is one of `values`. Returns rows deleted.
 *
 * `RETURNING` rather than a driver row count, because `execute()` hands back an
 * empty array for a plain `DELETE` and there is no count on it to read. This
 * used to return `values.length` - the number of ids it was *asked* about - so
 * a caller reporting "removed 2 reactions" was reporting how many ids it had
 * looked for, and said 2 just as readily when the answer was none.
 */
export async function deleteWhereIn(
  table: string,
  column: string,
  values: Array<number | string>,
  and: Record<string, number | string | boolean | null> = {},
): Promise<number> {
  if (values.length === 0)
    return 0

  let deleted = 0

  for (const chunk of chunks(values)) {
    const extra = Object.entries(and)
    const bound: Array<number | string | boolean | null> = [...chunk, ...extra.map(([, value]) => value)]

    const placeholders = chunk.map((_, index) => `$${index + 1}`).join(', ')
    const conditions = extra
      .map(([name], index) => `${quote(name)} = $${chunk.length + index + 1}`)
      .join(' AND ')

    const where = [`${quote(column)} IN (${placeholders})`, conditions].filter(Boolean).join(' AND ')

    const rows: any = await db
      .unsafe(`DELETE FROM ${quote(table)} WHERE ${where} RETURNING ${quote('id')}`, bound)
      .execute()

    deleted += Array.isArray(rows) ? rows.length : 0
  }

  return deleted
}

/** Set the same columns on every row whose `column` is one of `values`. */
export async function updateWhereIn(
  table: string,
  column: string,
  values: Array<number | string>,
  set: Record<string, number | string | boolean | null>,
): Promise<number> {
  const assignments = Object.entries(set)

  if (values.length === 0 || assignments.length === 0)
    return 0

  for (const chunk of chunks(values)) {
    const bound: Array<number | string | boolean | null> = [
      ...assignments.map(([, value]) => value),
      ...chunk,
    ]

    const sets = assignments.map(([name], index) => `${quote(name)} = $${index + 1}`).join(', ')
    const placeholders = chunk.map((_, index) => `$${assignments.length + index + 1}`).join(', ')

    await db.unsafe(
      `UPDATE ${quote(table)} SET ${sets} WHERE ${quote(column)} IN (${placeholders})`,
      bound,
    ).execute()
  }

  return values.length
}

/**
 * An identifier, quoted, with embedded quotes doubled.
 *
 * Not the boundary that stops an attacker - these names come from this
 * codebase and from `information_schema`, never from a request - but the one
 * that stops a table called `order` from producing a syntax error.
 */
function quote(name: string): string {
  return `"${name.replace(/"/g, '""')}"`
}

function* chunks<T>(values: T[]): Generator<T[]> {
  for (let index = 0; index < values.length; index += IN_CHUNK)
    yield values.slice(index, index + IN_CHUNK)
}

/**
 * Writing to many rows at once.
 *
 * These used to hand-build their SQL, because `where(column, 'in', values)`
 * bound the whole array to one placeholder on writes and produced
 *
 *     DELETE FROM "issue_labels" WHERE "issue_id" in $1
 *
 * which Postgres answers with `syntax error at or near "$1"`. So every bulk
 * update and every bulk delete in this application failed, and failed in the
 * way that is hardest to notice - the same call spelled the same way *does*
 * work on a read, so the pattern looks proven. Fixed in the builder in
 * bun-query-builder 0.2.24 rather than worked around here any longer, and the
 * statements below now go through it like everything else.
 *
 * They still exist, for two reasons that are not defects:
 *
 * **Chunking.** A list of ids is however long the caller's selection was, and
 * every driver has a parameter ceiling somewhere. Splitting at `IN_CHUNK` here
 * means no call site has to remember there is one.
 *
 * **An honest count.** `deleteWhereIn` returns rows actually deleted, via
 * `RETURNING`, rather than the number of ids it was asked about. It used to
 * return `values.length`, so a caller reporting "removed 2 reactions" was
 * reporting how many it had looked for, and said 2 just as readily when the
 * answer was none.
 */

/** How many values one `IN (…)` may carry. Postgres tolerates more; drivers vary. */
export const IN_CHUNK = 1000

/**
 * Delete every row whose `column` is one of `values`. Returns rows deleted.
 *
 * `and` narrows further, as equality on each entry - the label case needs both
 * "these issues" and "this label", and a delete that honoured only the first
 * would strip every label off them.
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
    let query = db.deleteFrom(table as any).where(column, 'in', chunk)

    for (const [name, value] of Object.entries(and))
      query = query.where(name, '=', value)

    // `RETURNING` rather than a driver row count: `execute()` on a plain
    // `DELETE` hands back an empty array with no count to read, and the count
    // is the whole reason a caller can say what it did.
    const rows: any = await (query as any).returning('id').execute()

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
  if (values.length === 0 || Object.keys(set).length === 0)
    return 0

  for (const chunk of chunks(values)) {
    await db
      .updateTable(table as any)
      .set(set as any)
      .where(column, 'in', chunk)
      .execute()
  }

  return values.length
}

function* chunks<T>(values: T[]): Generator<T[]> {
  for (let index = 0; index < values.length; index += IN_CHUNK)
    yield values.slice(index, index + IN_CHUNK)
}

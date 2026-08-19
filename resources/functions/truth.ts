/**
 * Reading a column that means yes or no, in a view.
 *
 * MySQL has no boolean type - `BOOLEAN` is a spelling of `TINYINT(1)` - so a
 * column Postgres hands back as `true` arrives as the number `1`. Every
 * `row.flag === true` in a template therefore renders the wrong branch when the
 * engine changes, and renders it silently: the control simply is not there, and
 * nothing anywhere says why. The dispatch button on the workflows page went
 * missing exactly that way.
 *
 * The same rule lives in `app/Actions/Support/sql.ts` for server code. It is
 * repeated here rather than imported because a view resolves its imports from
 * `resources/`, and because everything under `resources/functions/` is
 * auto-imported into templates - which is what makes this usable in a `.stx`
 * file at all.
 */
export function isTrue(value: unknown): boolean {
  if (typeof value === 'boolean')
    return value

  if (typeof value === 'number')
    return value !== 0

  if (typeof value === 'string')
    return value === '1' || value.toLowerCase() === 'true' || value.toLowerCase() === 't'

  return false
}

/** The other half, for the `!== false` shape: null and undefined are not "no". */
export function isNotFalse(value: unknown): boolean {
  return value === null || value === undefined ? true : isTrue(value)
}

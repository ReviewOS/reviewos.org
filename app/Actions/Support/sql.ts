/**
 * Raw SQL that survives the engine changing under it.
 *
 * Almost everything here goes through the query builder, which renders for
 * whichever dialect it is configured with. What does not is a handful of
 * statements the builder has no vocabulary for - a correlated count, a
 * three-way join with an aggregate - and those were written in Postgres:
 * `$1` placeholders and `"double quoted"` identifiers.
 *
 * Phase 17 moves the metadata database to MySQL, where both of those are
 * syntax errors. So a statement written by hand goes through `portable()` on
 * its way to the driver, which spells it for the connection that is actually
 * open. The alternative was to leave the rewrite until the migration and do it
 * under time pressure, on the day when everything else is also moving.
 *
 * **This is a spelling change, not a translation.** It moves placeholders and
 * quotes; it cannot rescue a statement that uses a construct the target engine
 * does not have. `DISTINCT ON`, `RETURNING`, `ILIKE` and `ON CONFLICT` are
 * Postgres', and the rule is that they do not appear in this codebase at all -
 * held by `tests/unit/sql-portability.test.ts` rather than by memory.
 */

import { config } from '@stacksjs/config'

/** The dialect the connection is configured for, lowercased. */
export function currentDialect(): string {
  return String(config.database?.default ?? 'postgres').toLowerCase()
}

/** Whether the open connection speaks MySQL - which includes Vitess and its relatives. */
export function speaksMysql(dialect = currentDialect()): boolean {
  return dialect === 'mysql' || dialect === 'mariadb' || dialect === 'singlestore' || dialect === 'vitess' || dialect === 'planetscale'
}

/**
 * One statement, spelled for the connection that is open.
 *
 * Two transformations and no others:
 *
 * - **`$1` becomes `?`**, in order. MySQL's driver has positional parameters
 *   with no numbers, and the arguments array is already in that order.
 * - **`"identifier"` becomes `` `identifier` ``.** MySQL reads a double-quoted
 *   word as a string literal unless `ANSI_QUOTES` is set, so leaving them would
 *   turn `WHERE "state" = 'open'` into a comparison of two strings that is
 *   always false - a query that returns nothing and raises nothing, which is
 *   the worst kind of wrong.
 *
 * String literals are left alone. They are single-quoted in every statement
 * this codebase writes, which is what makes the identifier rule safe to apply
 * with a scan: the two are lexically distinct, and the scan below tracks which
 * one it is inside rather than matching a pattern across the whole string.
 */
export function portable(sql: string, dialect = currentDialect()): string {
  if (!speaksMysql(dialect))
    return sql

  const source = String(sql ?? '')
  let out = ''
  let index = 0

  while (index < source.length) {
    const character = source[index]!

    // A single-quoted literal, copied through untouched - including the
    // doubled `''` escape, which is why this consumes rather than searches.
    if (character === '\'') {
      let cursor = index + 1

      while (cursor < source.length) {
        if (source[cursor] === '\'' && source[cursor + 1] === '\'') {
          cursor += 2
          continue
        }

        if (source[cursor] === '\'') {
          cursor += 1
          break
        }

        cursor += 1
      }

      out += source.slice(index, cursor)
      index = cursor
      continue
    }

    if (character === '"') {
      const end = source.indexOf('"', index + 1)

      // An unterminated quote is left as written: rewriting half a statement
      // to make it look finished is worse than handing the driver what the
      // author actually wrote and letting it say so.
      if (end === -1) {
        out += source.slice(index)
        break
      }

      out += `\`${source.slice(index + 1, end)}\``
      index = end + 1
      continue
    }

    if (character === '$' && /\d/.test(source[index + 1] ?? '')) {
      let cursor = index + 1

      while (/\d/.test(source[cursor] ?? ''))
        cursor += 1

      out += '?'
      index = cursor
      continue
    }

    out += character
    index += 1
  }

  return out
}

/**
 * The database's own wall clock, in the spelling each engine has.
 *
 * `LOCALTIMESTAMP` is standard and both engines have it, which is the point:
 * this used to be `CURRENT_TIMESTAMP::timestamp` in one place and
 * `LOCALTIMESTAMP` in another, measuring the same thing two ways, one of them
 * Postgres-only.
 *
 * What is being measured is the *naive* clock - no offset - because that is
 * what a defaulted timestamp column stores, and the whole point of reading it
 * is to compare it against what this process would have written.
 */
export const DATABASE_WALL_CLOCK = 'SELECT LOCALTIMESTAMP AS wall'

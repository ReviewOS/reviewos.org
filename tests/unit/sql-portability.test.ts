// The dialect audit, held as a test rather than as a memory.
//
// Phase 17 moves the metadata database to MySQL. Almost everything here goes
// through the query builder, which renders for whichever dialect it is
// configured with; what does not is a handful of hand-written statements, and
// those were written in Postgres. The audit found them, they were fixed, and
// this is what stops the next one landing quietly - because the failure mode is
// not a crash on the day of the migration. It is a `WHERE "state" = 'open'`
// that MySQL reads as comparing two string literals: a query that returns
// nothing and raises nothing.

import { describe, expect, test } from 'bun:test'
import { DATABASE_WALL_CLOCK, portable, speaksMysql } from '../../app/Actions/Support/sql'

/** Every file that could hold SQL: the application, the routes, the views. */
async function sources(): Promise<Array<{ path: string, text: string }>> {
  const found: Array<{ path: string, text: string }> = []

  for (const directory of ['app', 'routes', 'resources']) {
    for await (const path of new Bun.Glob(`${directory}/**/*.{ts,stx}`).scan({ cwd: process.cwd() }))
      found.push({ path, text: await Bun.file(path).text() })
  }

  return found
}

/**
 * Comments stripped, because the interesting half of this codebase is prose.
 *
 * A rule that fired on a comment explaining why `ON CONFLICT` was replaced is a
 * rule people satisfy by deleting the explanation.
 */
function code(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, match => match.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (match, before) => before + ' '.repeat(match.length - before.length))
    .split('\n')
    .filter(line => !line.trim().startsWith('*'))
    .join('\n')
}

/**
 * Constructs with no MySQL equivalent, or a different one.
 *
 * Each entry says what to do instead, because a failing test that only names
 * the sin sends somebody to search the roadmap for the remedy.
 */
/*
 * Matched case-sensitively, in the upper case SQL is written in here.
 *
 * The builder's own methods are the same words in camel case - `.returning()`,
 * `.distinctOn()` - and those are the portable path rather than the sin: the
 * builder knows what MySQL has. A case-insensitive rule flagged sixty call
 * sites that were already doing the right thing, which is how a guard test
 * teaches people to disable it.
 */
const FORBIDDEN: Array<{ pattern: RegExp, what: string, instead: string }> = [
  { pattern: /\bDISTINCT\s+ON\b/, what: '`DISTINCT ON`', instead: 'MySQL has no equivalent: group and aggregate, as `Pull/queue.ts` does with `MIN(created_at)`.' },
  { pattern: /\bON\s+CONFLICT\b/, what: '`ON CONFLICT`', instead: 'use `db.upsert(table, rows, conflictColumns, mergeColumns)`, which spells it for the dialect.' },
  { pattern: /\bILIKE\b/, what: '`ILIKE`', instead: 'MySQL has no `ILIKE`: compare `LOWER(column)` against a lowercased pattern.' },
  { pattern: /\bRETURNING\b/, what: '`RETURNING` written into a statement', instead: 'use the builder\'s `.returning([...])`, which knows MySQL has none and reads the row back.' },
  { pattern: /::\s*(?:text|int|integer|bigint|timestamp|jsonb|boolean|numeric)\b/, what: 'a `::` cast', instead: 'use `CAST(x AS type)`, or a spelling both engines share.' },
  { pattern: /\bEXCLUDED\./, what: '`EXCLUDED.`', instead: 'that is the `ON CONFLICT` form; `db.upsert` handles both engines.' },
  { pattern: /\bpg_(?:advisory|try_advisory|sleep|catalog)\b/, what: 'a `pg_` function', instead: 'phase 18 names the portable locking primitive; do not reach for Postgres advisory locks.' },
  { pattern: /\bCURRENT_TIMESTAMP\s*::/, what: 'a cast on `CURRENT_TIMESTAMP`', instead: 'use `LOCALTIMESTAMP`, which both engines have and which is what a naive column stores.' },
]

describe('the hand-written SQL', () => {
  test('uses no construct MySQL does not have', async () => {
    const problems: string[] = []

    for (const file of await sources()) {
      // The audit itself, and this test, name these constructs on purpose.
      if (file.path === 'app/Actions/Support/sql.ts' || file.path.startsWith('tests/'))
        continue

      const text = code(file.text)

      for (const rule of FORBIDDEN) {
        if (rule.pattern.test(text))
          problems.push(`${file.path}: ${rule.what} - ${rule.instead}`)
      }
    }

    expect(problems).toEqual([])
  })

  test('and every raw statement is spelled for the connection that is open', async () => {
    const problems: string[] = []

    for (const file of await sources()) {
      if (file.path === 'app/Actions/Support/sql.ts')
        continue

      const text = code(file.text)

      /*
       * A raw statement is fine; a raw statement handed straight to the driver
       * is not. `portable()` moves `$1` to `?` and `"ident"` to backticks,
       * which are the two things MySQL spells differently and the two that fail
       * silently rather than loudly.
       */
      for (const match of text.matchAll(/\.unsafe\(\s*([A-Za-z_][\w.]*\(?)/g)) {
        const argument = String(match[1] ?? '')

        /*
         * Either wrapped here, or a constant this module owns - the wall-clock
         * read is one statement with nothing dialect-specific left in it, and
         * wrapping it would say there was.
         */
        if (argument.startsWith('portable(') || argument.startsWith('DATABASE_'))
          continue

        problems.push(`${file.path}: a raw statement goes to the driver without \`portable()\` (\`${argument}\`)`)
      }
    }

    expect(problems).toEqual([])
  })
})

describe('portable', () => {
  test('moves numbered placeholders to the positional ones MySQL takes', () => {
    expect(portable('SELECT * FROM t WHERE a = $1 AND b = $2', 'mysql'))
      .toBe('SELECT * FROM t WHERE a = ? AND b = ?')

    // Two digits, because a statement with ten parameters is where a naive
    // replacement turns `$10` into `?0`.
    expect(portable('SELECT $10, $2', 'mysql')).toBe('SELECT ?, ?')
  })

  test('and identifiers to backticks, which is the one that fails silently', () => {
    // MySQL reads a double-quoted word as a string literal, so this comparison
    // would be two constants and always false: no rows, no error.
    expect(portable('WHERE "state" = \'open\'', 'mysql')).toBe('WHERE `state` = \'open\'')
  })

  test('and leaves string literals alone, including their doubled quotes', () => {
    expect(portable('SELECT \'a "quoted" word\' AS "label"', 'mysql'))
      .toBe('SELECT \'a "quoted" word\' AS `label`')

    expect(portable('SELECT \'it\'\'s $1 fine\' AS "x", $1', 'mysql'))
      .toBe('SELECT \'it\'\'s $1 fine\' AS `x`, ?')
  })

  test('and changes nothing at all on Postgres', () => {
    const statement = 'SELECT "a" FROM "t" WHERE "b" = $1'

    expect(portable(statement, 'postgres')).toBe(statement)
  })

  test('and an unterminated quote is handed over as written', () => {
    // Rewriting half a statement to make it look finished is worse than
    // letting the driver say what is wrong with it.
    expect(portable('SELECT "unfinished', 'mysql')).toBe('SELECT "unfinished')
  })

  test('and every MySQL-family dialect counts, including Vitess', () => {
    for (const dialect of ['mysql', 'mariadb', 'vitess', 'planetscale', 'singlestore'])
      expect(speaksMysql(dialect)).toBe(true)

    expect(speaksMysql('postgres')).toBe(false)
    expect(speaksMysql('sqlite')).toBe(false)
  })
})

describe('the database clock', () => {
  test('is read the same way in both places, in a spelling both engines have', () => {
    expect(DATABASE_WALL_CLOCK).toContain('LOCALTIMESTAMP')
    expect(DATABASE_WALL_CLOCK).not.toContain('::')
    // Unchanged by the rewrite: there is nothing dialect-specific left in it.
    expect(portable(DATABASE_WALL_CLOCK, 'mysql')).toBe(DATABASE_WALL_CLOCK)
  })
})

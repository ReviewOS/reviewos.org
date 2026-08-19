// The MySQL schema, checked for the things MySQL accepts and then ignores.
//
// Phase 17 generates a second migration corpus, `database/migrations/mysql`,
// from the same models as the Postgres one. Regenerating it is a command; what
// this holds is the *review* of it - and the reason a review was needed is that
// the interesting MySQL failures are not errors.
//
// A column-level `REFERENCES` clause is the case that motivated this file:
// MySQL parses it, discards it, and creates the table. The corpus applied
// cleanly, said so, and left a database with no foreign keys in it at all. The
// generator now emits table-level constraints (fixed in bun-query-builder
// 0.2.48), and this is what notices if a regeneration ever silently loses them
// again.
//
// The rules read the corpus rather than the generator, deliberately. What
// matters is what an operator's database ends up with.

import { describe, expect, test } from 'bun:test'

const DIRECTORY = 'database/migrations/mysql'

interface Migration {
  file: string
  sql: string
}

async function corpus(): Promise<Migration[]> {
  const found: Migration[] = []

  for await (const file of new Bun.Glob('*.sql').scan({ cwd: DIRECTORY }))
    found.push({ file, sql: await Bun.file(`${DIRECTORY}/${file}`).text() })

  return found.sort((a, b) => a.file.localeCompare(b.file))
}

/** Every `CREATE TABLE` in the corpus, as (table, body) pairs. */
function createStatements(sql: string): Array<{ table: string, body: string }> {
  return [...sql.matchAll(/CREATE TABLE IF NOT EXISTS `(\w+)` \(([\s\S]*?)\n\)/g)]
    .map(match => ({ table: match[1]!, body: match[2]! }))
}

/** The column definitions of a create body: the lines that are not constraints. */
function columnLines(body: string): string[] {
  return body.split('\n').map(line => line.trim()).filter(line => line.startsWith('`'))
}

describe('the MySQL migration corpus', () => {
  test('exists, and covers every table the models declare', async () => {
    const files = await corpus()

    // The Postgres corpus is the older one and carries alter-* history, so the
    // two counts are not comparable; what matters is that this one is whole.
    expect(files.length).toBeGreaterThan(90)
  })

  test('puts foreign keys in the table body, where MySQL acts on them', async () => {
    const inline: string[] = []
    let constraints = 0

    for (const { file, sql } of await corpus()) {
      for (const { table, body } of createStatements(sql)) {
        constraints += (body.match(/CONSTRAINT `\w+` FOREIGN KEY/g) ?? []).length

        for (const line of columnLines(body)) {
          // A column line ending in REFERENCES is the inline form: parsed,
          // discarded, and no constraint created.
          if (/\bREFERENCES\b/.test(line))
            inline.push(`${file}: ${table}: ${line}`)
        }
      }
    }

    expect(inline).toEqual([])
    expect(constraints).toBeGreaterThan(100)
  })

  test('names utf8mb4 on every table rather than inheriting the server default', async () => {
    const missing: string[] = []

    for (const { file, sql } of await corpus()) {
      for (const [, table, charset] of sql.matchAll(/CREATE TABLE IF NOT EXISTS `(\w+)` \([\s\S]*?\n\)([^;]*);/g)) {
        if (!/DEFAULT CHARSET=utf8mb4/.test(charset ?? ''))
          missing.push(`${file}: ${table}`)
      }
    }

    // A server still defaulting to latin1 - MySQL 5.7's default, and what a
    // great many my.cnf files still say - would otherwise create latin1 tables
    // and reject the first four-byte character years later.
    expect(missing).toEqual([])
  })

  test('gives every TEXT column in an index a key prefix', async () => {
    const unprefixed: string[] = []

    for (const { file, sql } of await corpus()) {
      const texts = new Set<string>()

      for (const { body } of createStatements(sql)) {
        for (const line of columnLines(body)) {
          const column = /^`(\w+)`\s+(\w+)/.exec(line)
          if (column && (column[2] === 'text' || column[2] === 'json'))
            texts.add(column[1]!)
        }
      }

      for (const [, keyParts] of sql.matchAll(/CREATE (?:UNIQUE )?INDEX `\w+` ON `\w+` \(([^;]*)\);/g)) {
        for (const part of keyParts!.split(',')) {
          const name = /`(\w+)`/.exec(part)?.[1]

          // MySQL cannot index a TEXT column without a length: it raises
          // "BLOB/TEXT column used in key specification without a key length"
          // and refuses the statement.
          if (name && texts.has(name) && !/\(\d+\)/.test(part))
            unprefixed.push(`${file}: ${part.trim()}`)
        }
      }
    }

    expect(unprefixed).toEqual([])
  })

  test('keeps every key within InnoDB\'s 3072 bytes', async () => {
    const BYTES_PER_CHARACTER = 4
    const MAX_KEY_BYTES = 3072
    const over: string[] = []

    for (const { file, sql } of await corpus()) {
      const widths = new Map<string, number>()

      for (const { table, body } of createStatements(sql)) {
        for (const line of columnLines(body)) {
          const column = /^`(\w+)`\s+([a-z]+(?:\(\d+(?:,\d+)?\))?)/i.exec(line)
          if (!column)
            continue

          const type = column[2]!.toLowerCase()
          const characters = /^(?:var)?char\((\d+)\)$/.exec(type)?.[1]

          widths.set(`${table}.${column[1]}`, characters
            ? Number(characters) * BYTES_PER_CHARACTER
            // Anything else is a fixed-width scalar or an enum; eight bytes
            // covers the widest of them.
            : 8)
        }
      }

      for (const [, name, table, keyParts] of sql.matchAll(/CREATE (?:UNIQUE )?INDEX `(\w+)` ON `(\w+)` \(([^;]*)\);/g)) {
        let bytes = 0

        for (const part of keyParts!.split(',')) {
          const column = /`(\w+)`/.exec(part)?.[1]
          const prefix = /\((\d+)\)/.exec(part)?.[1]

          bytes += prefix
            ? Number(prefix) * BYTES_PER_CHARACTER
            : widths.get(`${table}.${column}`) ?? 8
        }

        if (bytes > MAX_KEY_BYTES)
          over.push(`${file}: ${name} needs ${bytes} bytes`)
      }
    }

    // A composite key can overrun with no single column near the limit:
    // (bigint, varchar(500), varchar(500)) is 4008. The server rejects it at
    // apply time, halfway through the corpus.
    expect(over).toEqual([])
  })

  test('has no Postgres left in it', async () => {
    const found: string[] = []

    for (const { file, sql } of await corpus()) {
      for (const [construct, pattern] of [
        ['BIGSERIAL', /\bBIGSERIAL\b/i],
        ['a double-quoted identifier', /"\w+"/],
        ['a named enum type', /CREATE TYPE\b/i],
        ['DISTINCT ON', /DISTINCT ON\b/i],
      ] as const) {
        if (pattern.test(sql))
          found.push(`${file}: ${construct}`)
      }
    }

    expect(found).toEqual([])
  })
})

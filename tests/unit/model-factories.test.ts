// Every model's factories, against the faker the seeder actually passes them.
//
// This file exists because of a real morning. A dependency bump moved the
// underlying faker, and the two disagree: no `helpers.arrayElement`, `address`
// rather than `location`, `catchphrase` rather than `catchPhrase`, options
// objects where a bare number used to do.
//
// Nothing failed, and nothing could: `@stacksjs/database`'s seeder catches a
// factory that throws, logs a line, and writes the attribute's default
// instead. So a broken factory is a column full of defaults in a database
// nobody looks at closely, discovered weeks later.
//
// `faker` here is the same object the seeder passes - the enhanced one from
// `@stacksjs/faker`, not the library underneath it.
//
// So: call every factory this application declares, with the faker the seeder
// builds, and require a value back. It needs no database, and it catches the
// whole class.

import { describe, expect, test } from 'bun:test'
import { Glob } from 'bun'
import { faker } from '@stacksjs/faker'

interface Attribute {
  factory?: (faker: any) => unknown
}

interface Definition {
  name?: string
  attributes?: Record<string, Attribute>
}

async function models(): Promise<Array<{ file: string, definition: Definition }>> {
  const found: Array<{ file: string, definition: Definition }> = []

  for await (const file of new Glob('*.ts').scan({ cwd: 'app/Models' })) {
    const imported: any = await import(`../../app/Models/${file}`)
    const definition = imported.default ?? imported

    if (definition?.attributes)
      found.push({ file, definition })
  }

  return found.sort((left, right) => left.file.localeCompare(right.file))
}

describe('the factories the seeder will call', () => {
  test('every model declares some, because a seeder with nothing to make is not one', async () => {
    const found = await models()

    expect(found.length).toBeGreaterThan(50)

    const withoutFactories = found
      .filter(({ definition }) => !Object.values(definition.attributes ?? {}).some(attribute => attribute.factory))
      .map(({ file }) => file)

    // Join tables and rows that only ever exist alongside a parent are the
    // exception, and there are few enough to name if this ever grows.
    expect(withoutFactories.length).toBeLessThanOrEqual(20)
  })

  test('and every one of them returns a value rather than throwing', async () => {
    const broken: string[] = []

    for (const { file, definition } of await models()) {
      for (const [name, attribute] of Object.entries(definition.attributes ?? {})) {
        if (!attribute.factory)
          continue

        try {
          const value = attribute.factory(faker)

          if (value === undefined)
            broken.push(`${file}:${name} returned undefined`)
        }
        catch (error) {
          broken.push(`${file}:${name} threw ${(error as Error).message}`)
        }
      }
    }

    // Reported as a list rather than a count: the names are what somebody fixes.
    expect(broken).toEqual([])
  })
})

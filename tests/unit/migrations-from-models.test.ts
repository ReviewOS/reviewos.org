import { describe, expect, it } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Every migration comes from a model.
 *
 * The models are the schema. `buddy migrate:regenerate` rebuilds
 * `database/migrations/` from them, so a hand-written file in there is a change
 * the next regeneration silently deletes - and worse, a rule the models do not
 * know about, which means the schema and the source of truth disagree with
 * nothing reporting it.
 *
 * This got written after a hand-written migration was needed to drop foreign
 * keys the models had superseded. It was a real repair, and it was also a sign
 * the *models* were wrong rather than the generator: once every relation was
 * declared, the whole corpus regenerated with the constraints inline and the
 * repair had nothing left to do.
 *
 * Two of those relations were missing entirely. `issues.milestone_id` and
 * `access_tokens.organization_id` were declared as plain attributes, so no
 * constraint was generated and nothing stopped a row pointing at a milestone or
 * an organization that had been deleted.
 */

const MIGRATIONS = 'database/migrations'
const MODELS = 'app/Models'

const files = readdirSync(MIGRATIONS).filter(name => name.endsWith('.sql'))
const corpus = files.map(name => readFileSync(join(MIGRATIONS, name), 'utf8')).join('\n')

function snake(value: string): string {
  return value
    .replace(/([a-z\d])([A-Z])/g, '$1_$2')
    .toLowerCase()
}

describe('the migration corpus', () => {
  it('has migrations at all, so a passing run means something', () => {
    expect(files.length).toBeGreaterThan(50)
  })

  /**
   * The generator writes `<number>-<verb>-<subject>.sql` and nothing else. A
   * name it would not produce is a file it did not produce.
   */
  it('contains only files the generator names', () => {
    const strange = files.filter(name => !/^\d{10}-(?:create|alter|drop|auto-misc)/.test(name))

    expect(strange).toEqual([])
  })

  /**
   * The generator emits no commentary. A comment is a person explaining
   * something to the next person, which is worth doing - in the model, where it
   * survives a regeneration.
   */
  it('contains no hand-written commentary', () => {
    const annotated = files.filter(name => /^\s*--/m.test(readFileSync(join(MIGRATIONS, name), 'utf8')))

    expect(annotated).toEqual([])
  })
})

describe('what the models declare reaches the SQL', () => {
  const modelFiles = readdirSync(MODELS).filter(name => name.endsWith('.ts'))

  it('reads the models', () => {
    expect(modelFiles.length).toBeGreaterThan(10)
  })

  /**
   * An `onDelete` that never reaches a constraint is worse than none: the model
   * says the database will clean up, the database does nothing, and the rows
   * that outlive their parent are found by whoever hits the orphan.
   *
   * Read from source rather than by importing the models - a model file pulls
   * in framework globals, and this needs to run in a bare `bun test`.
   */
  it('emits a constraint for every relation that declares an onDelete', () => {
    const missing: string[] = []

    for (const name of modelFiles) {
      const source = readFileSync(join(MODELS, name), 'utf8')
      const table = source.match(/\btable:\s*'([^']+)'/)?.[1]
      if (!table)
        continue

      // `{ model: 'X', foreignKey?: 'y_id', onDelete: 'cascade' }`, in any
      // order - the field order in a model is the author's choice.
      for (const entry of source.matchAll(/\{[^{}]*\bmodel:\s*'(\w+)'[^{}]*\bonDelete:\s*'([^']+)'[^{}]*\}/g)) {
        const [whole, model, action] = entry
        const column = whole.match(/foreignKey:\s*'([^']+)'/)?.[1] ?? `${snake(model!)}_id`
        const expected = new RegExp(
          `"${column}"[^,\\n]*REFERENCES[^,\\n]*ON DELETE ${action!.toUpperCase()}`,
          'i',
        )

        if (!expected.test(corpus))
          missing.push(`${table}.${column} -> ${model} ON DELETE ${action!.toUpperCase()}`)
      }
    }

    expect(missing).toEqual([])
  })

  /**
   * The two that were missing, named. The rule above would catch them again,
   * but only once somebody had already declared the relation - and the bug was
   * that nobody had.
   */
  it('constrains the foreign keys that were only ever attributes', () => {
    expect(corpus).toMatch(/"milestone_id"[^,\n]*REFERENCES "milestones"\("id"\) ON DELETE SET NULL/)
    expect(corpus).toMatch(/"organization_id"[^,\n]*REFERENCES "organizations"\("id"\) ON DELETE CASCADE/)
  })
})

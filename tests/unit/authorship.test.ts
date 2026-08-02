/**
 * Who wrote a thing, when they have no account here.
 *
 * Mirrored conversations are written by people who mostly do not have an
 * account on this forge. Attaching their words to a local user because the
 * handles happen to match puts words in somebody's mouth, and two people with
 * the same name is ordinary - so the rule is that `author_id` and
 * `external_author` move together, and exactly one of them is ever set.
 *
 * Three models followed it and two did not. `IssueComment.author_id` and
 * `PullRequestReview.reviewer_id` were required and had no upstream name to
 * fall back on, which made importing an issue's conversation or a review
 * impossible, and left the column dangling for every seeded row whose user
 * later went away.
 *
 * This test reads the model definitions, so a new model that gets it wrong -
 * or an old one that regresses - fails here rather than at the point somebody
 * tries to mirror something.
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** Model, and the column naming whoever wrote the thing. */
const AUTHORED = [
  { model: 'Issue', column: 'author_id' },
  { model: 'IssueComment', column: 'author_id' },
  { model: 'PullRequest', column: 'author_id' },
  { model: 'PullRequestReview', column: 'reviewer_id' },
  { model: 'ReviewComment', column: 'author_id' },
] as const

function source(model: string): string {
  return readFileSync(join(process.cwd(), 'app', 'Models', `${model}.ts`), 'utf8')
}

/** The `validation.rule` line for one attribute. */
function ruleFor(text: string, column: string): string {
  const declaration = new RegExp(`\\n\\s{4}${column}:\\s*\\{([\\s\\S]*?)\\n\\s{4}\\},`).exec(text)
  expect(declaration, `${column} is declared`).not.toBeNull()

  const rule = /validation:\s*\{\s*rule:\s*([^\n]*)/.exec(declaration![1]!)
  expect(rule, `${column} has a validation rule`).not.toBeNull()

  return rule![1]!
}

describe('authorship', () => {
  for (const { model, column } of AUTHORED) {
    /**
     * Required would mean a row cannot exist without a local account, which is
     * exactly the case mirroring has to represent.
     */
    test(`${model}.${column} is optional`, () => {
      expect(ruleFor(source(model), column)).not.toContain('required()')
    })

    test(`${model} carries an upstream name to fall back on`, () => {
      expect(source(model)).toContain('external_author:')
    })

    test(`${model}.external_author is optional too`, () => {
      expect(ruleFor(source(model), 'external_author')).not.toContain('required()')
    })

    /** A name, not an identity: it is displayed, never joined on. */
    test(`${model}.external_author is a bounded string`, () => {
      expect(ruleFor(source(model), 'external_author')).toContain('string()')
      expect(ruleFor(source(model), 'external_author')).toContain('max(120)')
    })
  }

  /** The whole point of the pair: neither half is any use without the other. */
  test('every authored model has both halves', () => {
    for (const { model, column } of AUTHORED) {
      const text = source(model)
      expect(text, `${model} declares ${column}`).toContain(`${column}:`)
      expect(text, `${model} declares external_author`).toContain('external_author:')
    }
  })
})

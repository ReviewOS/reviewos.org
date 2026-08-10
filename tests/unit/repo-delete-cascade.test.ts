import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'

/**
 * Deleting a repository is one statement.
 *
 * It used to be three hundred lines: read the foreign keys out of
 * `information_schema`, sort the tables so nothing was deleted before the rows
 * pointing at it, collect the ids level by level, empty them deepest first,
 * then null the `parent_id` of every fork. All of it a second implementation of
 * rules the database already holds - and the kind that goes wrong quietly, when
 * somebody adds a table and only one of the two learns about it.
 *
 * `app/Actions/Repo/purge.ts` and `dependents.ts` are gone. What replaces them
 * is `ON DELETE CASCADE` on the fifteen tables that hang off a repository and
 * `ON DELETE SET NULL` on `repositories.parent_id`, declared on the models and
 * verified against a real database in `tests/unit/migrations-from-models.test.ts`.
 *
 * This pins the part that could regress silently: the action doing the work
 * itself again. A reintroduced walk would still pass every other test in the
 * suite, because it would produce the right answer - slowly, and from a second
 * copy of the truth.
 */

const ACTION = 'app/Actions/Repo/DeleteRepositoryAction.ts'
const source = readFileSync(ACTION, 'utf8')

// The action explains at length what it no longer does, and naming the old
// machinery in a comment is not doing it again.
const code = source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\/\/.*$/gm, '')

describe('deleting a repository', () => {
  it('removes the row and lets the schema do the rest', () => {
    expect(code).toContain('deleteFrom(\'repositories\')')

    // One delete, not a loop over tables.
    expect(code.match(/deleteFrom\(/g)?.length).toBe(1)
  })

  /**
   * The ordering that survives: a failure to delete the row has to leave the
   * repository working, which it only does if the directory has not moved yet.
   * The other order produces a repository that is gone from disk and still
   * listed, and there is no way back from it.
   */
  it('does the database work before the directory moves', () => {
    const deleted = code.indexOf('deleteFrom(\'repositories\')')
    const moved = code.indexOf('rename(')

    expect(deleted).toBeGreaterThan(0)
    expect(moved).toBeGreaterThan(deleted)
  })

  /** Afterwards there is no id to look up and no name to report. */
  it('writes the audit record before the row goes', () => {
    // `auditEvent` rather than `recordAudit`: the log is written by a listener
    // now, so the action emits and the listener inserts. The ordering this
    // asserts is unchanged and is the whole point - the emit is awaited.
    const audited = code.indexOf('auditEvent(')
    const deleted = code.indexOf('deleteFrom(\'repositories\')')

    expect(audited).toBeGreaterThan(0)
    expect(deleted).toBeGreaterThan(audited)
  })

  /**
   * Deleting a fork is one fewer fork, and the count is recomputed rather than
   * decremented for the reason every counter here is.
   */
  it('recounts the parent forks when a fork is deleted', () => {
    expect(code).toContain('recountForks')
  })

  it('no longer walks the schema to work out an order', () => {
    for (const gone of ['purgeRepository', 'information_schema', 'deletionOrder', 'planPurge'])
      expect(code).not.toContain(gone)
  })
})

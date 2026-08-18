// What a job's `if:` may read.
//
// The sandbox is the feature: an expression here reads facts about *this
// event* - the branch or tag, the trigger, the commit and its message, the
// changed paths, the matrix combination, the declared inputs - and nothing
// else. It cannot reach a step's outcome, because nothing has run yet, and it
// cannot reach the control plane at all.
//
// Two of these were missing until now, and both are things people write on the
// first day: `github.ref_type == 'tag'` for a release job, and
// `contains(github.event.head_commit.message, '[skip ci]')` for the filter
// `on:` cannot express per job.

import { describe, expect, test } from 'bun:test'
import { shouldRun } from '../../app/Actions/Workflow/expression'
import { conditionContextForTest } from '../../app/Actions/Workflow/dispatch'

function context(over: Record<string, unknown> = {}): any {
  return conditionContextForTest({
    workflow: 'CI',
    eventName: 'push',
    ref: 'refs/heads/main',
    sha: 'a'.repeat(40),
    changed: ['src/app.ts'],
    message: 'fix: the thing\n\n[skip ci]',
    ...over,
  } as any, null)
}

describe('the documented set', () => {
  test('carries the branch, the trigger and the commit', () => {
    const built = context()

    expect((built.github as any).ref_name).toBe('main')
    expect((built.github as any).ref_type).toBe('branch')
    expect((built.github as any).event_name).toBe('push')
    expect((built.github as any).sha).toHaveLength(40)
  })

  test('a tag says so, which is how a release job is written', () => {
    const built = context({ ref: 'refs/tags/v1.2.0' })

    expect((built.github as any).ref_type).toBe('tag')
    expect(shouldRun("github.ref_type == 'tag'", built).run).toBe(true)
  })

  test('the commit message is readable, whole', () => {
    /*
     * `%B`, not the subject: half the people who write `[skip ci]` put it on
     * the second line, and a condition that only saw the subject would be
     * right most of the time - which is the worst kind of wrong.
     */
    expect(shouldRun("contains(github.event.head_commit.message, '[skip ci]')", context()).run).toBe(true)
    expect(shouldRun("contains(github.event.head_commit.message, 'release')", context()).run).toBe(false)
  })

  test('and the changed paths, under this instance\'s own name', () => {
    /*
     * `reviewos.changed` rather than smuggled into `github`, because a workflow
     * that reads it would not run on GitHub - and a reader deserves to see that
     * in the expression rather than discover it on migration.
     */
    const built = context()

    expect((built as any).reviewos.changed).toEqual(['src/app.ts'])
    expect(shouldRun("contains(reviewos.changed, 'src/app.ts')", built).run).toBe(true)
  })

  test('inputs are there for a dispatched run', () => {
    expect(shouldRun("inputs.environment == 'production'", context({ inputs: { environment: 'production' } })).run).toBe(true)
  })
})

describe('what it may not read', () => {
  test('a step outcome cannot be answered before anything has run, and is refused', () => {
    /*
     * The safe direction, and the reason this is a sandbox rather than a
     * subset: the other way runs a deployment because a condition could not be
     * read.
     */
    const decision = shouldRun("steps.build.outputs.ready == 'yes'", context())

    expect(decision.run).toBe(false)
    expect(decision.reason.length).toBeGreaterThan(0)
  })

  test('and nothing about the instance is in scope at all', () => {
    const built = context()

    expect(Object.keys(built).sort()).toEqual(['github', 'inputs', 'matrix', 'reviewos'])
    expect(JSON.stringify(built)).not.toContain('secret')
  })
})

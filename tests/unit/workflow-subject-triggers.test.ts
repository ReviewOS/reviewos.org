// `on: issues`, `on: issue_comment`, `on: release`.
//
// One shape for all three, because they filter on one thing: the activity type.
// There is no branch on an issue and no path on a release. What is worth
// pinning is the defaults, since a workflow that names no `types:` is the
// common case and the default decides whether labelling an issue starts a run.

import { describe, expect, test } from 'bun:test'
import { subjectStartsRun } from '../../app/Actions/Workflow/triggers'

describe('issues', () => {
  test('a workflow that did not ask does not run', () => {
    expect(subjectStartsRun({}, 'issues', 'opened').run).toBe(false)
  })

  test('and one that did runs on every activity type by default', () => {
    // Actions' default, and the reason a naive `on: issues` workflow fires on
    // labelling as well as opening.
    const version = { on_issues: true }

    for (const activity of ['opened', 'closed', 'labeled', 'assigned'])
      expect(subjectStartsRun(version, 'issues', activity).run).toBe(true)
  })

  test('naming types narrows it to those', () => {
    const version = { on_issues: true, issue_types: 'opened' }

    expect(subjectStartsRun(version, 'issues', 'opened').run).toBe(true)
    expect(subjectStartsRun(version, 'issues', 'labeled').run).toBe(false)
    expect(subjectStartsRun(version, 'issues', 'labeled').reason).toContain('activity types')
  })
})

describe('issue comments', () => {
  test('created by default, with edited and deleted available', () => {
    const version = { on_issue_comment: true }

    expect(subjectStartsRun(version, 'issue_comment', 'created').run).toBe(true)
    expect(subjectStartsRun(version, 'issue_comment', 'deleted').run).toBe(true)
  })

  test('and the events do not cross: an issue event is not a comment event', () => {
    expect(subjectStartsRun({ on_issues: true }, 'issue_comment', 'created').run).toBe(false)
    expect(subjectStartsRun({ on_issue_comment: true }, 'issues', 'opened').run).toBe(false)
  })
})

describe('releases', () => {
  /*
   * Deliberately not Actions' default of every type. A draft release starting
   * a deployment is the surprise nobody wants, and `published` is what people
   * mean when they write `on: release`.
   */
  test('published only, unless the workflow names more', () => {
    const version = { on_release: true }

    expect(subjectStartsRun(version, 'release', 'published').run).toBe(true)
    expect(subjectStartsRun(version, 'release', 'created').run).toBe(false)
    expect(subjectStartsRun(version, 'release', 'prereleased').run).toBe(false)
  })

  test('and naming them opts in explicitly', () => {
    const version = { on_release: true, release_types: 'published\nprereleased' }

    expect(subjectStartsRun(version, 'release', 'prereleased').run).toBe(true)
  })
})

// What has to go when a repository goes, and in what order.
//
// The plan is derived from the database's own foreign keys rather than from a
// list in the source, so what is tested here is the walk: that it goes deep
// enough, that it comes back in an order nothing can be deleted too early in,
// and that the two shapes which would otherwise be quietly wrong - a fork
// pointing at its parent, and a table reachable by two paths - come out right.

import type { ForeignKeyEdge } from '../../app/Actions/Repo/dependents'
import { describe, expect, test } from 'bun:test'
import { deletionOrder, planPurge } from '../../app/Actions/Repo/dependents'

/**
 * The real graph, as Postgres reports it for this schema. Copied rather than
 * queried so the test runs without a database, and kept honest by the fact that
 * the code under test reads the live version: this is here to pin the *walk*,
 * not the schema.
 */
const EDGES: ForeignKeyEdge[] = [
  { child: 'access_token_repositories', column: 'repository_id', parent: 'repositories' },
  { child: 'attachments', column: 'repository_id', parent: 'repositories' },
  { child: 'check_runs', column: 'repository_id', parent: 'repositories' },
  { child: 'issue_assignees', column: 'issue_id', parent: 'issues' },
  { child: 'issue_comments', column: 'commentable_id', parent: 'issues' },
  { child: 'issue_labels', column: 'issue_id', parent: 'issues' },
  { child: 'issue_labels', column: 'label_id', parent: 'repository_labels' },
  // Reported twice by information_schema, which is exactly what it does.
  { child: 'issue_labels', column: 'label_id', parent: 'repository_labels' },
  { child: 'issues', column: 'milestone_id', parent: 'milestones' },
  { child: 'issues', column: 'repository_id', parent: 'repositories' },
  { child: 'milestones', column: 'repository_id', parent: 'repositories' },
  { child: 'protected_branches', column: 'repository_id', parent: 'repositories' },
  { child: 'pull_request_reviewers', column: 'pull_request_id', parent: 'pull_requests' },
  { child: 'pull_request_reviews', column: 'pull_request_id', parent: 'pull_requests' },
  { child: 'pull_requests', column: 'repository_id', parent: 'repositories' },
  { child: 'repo_collaborators', column: 'repository_id', parent: 'repositories' },
  { child: 'repository_labels', column: 'repository_id', parent: 'repositories' },
  { child: 'repository_mirrors', column: 'repository_id', parent: 'repositories' },
  { child: 'review_comments', column: 'review_id', parent: 'pull_request_reviews' },
  { child: 'review_comments', column: 'review_thread_id', parent: 'review_threads' },
  { child: 'review_threads', column: 'pull_request_id', parent: 'pull_requests' },
  { child: 'stars', column: 'repository_id', parent: 'repositories' },
  { child: 'watches', column: 'repository_id', parent: 'repositories' },
  { child: 'webhook_deliveries', column: 'webhook_id', parent: 'webhooks' },
  { child: 'webhooks', column: 'repository_id', parent: 'repositories' },
  // The one that must never be followed.
  { child: 'repositories', column: 'parent_id', parent: 'repositories' },
]

const steps = planPurge(EDGES, 'repositories')
const tables = steps.map(step => step.table)

describe('planPurge', () => {
  test('reaches the direct children', () => {
    for (const table of ['stars', 'watches', 'issues', 'pull_requests', 'repository_labels', 'webhooks'])
      expect(tables, table).toContain(table)
  })

  test('reaches through issues and pull requests to their own children', () => {
    for (const table of ['issue_comments', 'issue_labels', 'review_comments', 'webhook_deliveries'])
      expect(tables, table).toContain(table)
  })

  /**
   * A fork points at the repository it came from. Following that edge would
   * delete somebody else's repository as a side effect of deleting yours, which
   * is the single worst thing this function could do.
   */
  test('never follows a table to itself', () => {
    expect(tables).not.toContain('repositories')
  })

  test('leaves the repository row to the caller', () => {
    expect(steps.every(step => step.table !== 'repositories')).toBe(true)
  })

  test('a duplicated edge is one step', () => {
    const labelSteps = steps.filter(step => step.table === 'issue_labels' && step.column === 'label_id')

    expect(labelSteps).toHaveLength(1)
  })

  test('a table with two different parents gets a step for each', () => {
    const columns = steps.filter(step => step.table === 'issue_labels').map(step => step.column).sort()

    expect(columns).toEqual(['issue_id', 'label_id'])
  })

  /**
   * The forward order is what lets a caller collect ids in one pass: by the
   * time a step names a parent, every step that fills that parent has run.
   */
  test('a table is never used as a parent before it has been filled', () => {
    const filledAt = new Map<string, number>()

    steps.forEach((step, index) => {
      filledAt.set(step.table, index)
    })

    steps.forEach((step, index) => {
      if (step.parent === 'repositories')
        return

      const last = steps.map((other, at) => other.table === step.parent ? at : -1).filter(at => at >= 0).pop()!
      expect(last, `${step.table} reads ${step.parent} too early`).toBeLessThan(index)
    })
  })

  /**
   * `issues` is a direct child of `repositories` *and* a child of `milestones`.
   * Taking the short path would put it at the same depth as milestones, and
   * milestones would then be emptied while issues still pointed at them.
   */
  test('a table reachable two ways takes the longer distance', () => {
    const depthOf = (table: string) =>
      Math.max(...steps.filter(step => step.table === table).map(step => step.parentDepth))

    expect(depthOf('issues')).toBeGreaterThan(depthOf('milestones'))
  })

  test('does not loop forever on a cycle between two tables', () => {
    const cyclic: ForeignKeyEdge[] = [
      { child: 'a', column: 'repository_id', parent: 'repositories' },
      { child: 'b', column: 'a_id', parent: 'a' },
      { child: 'a', column: 'b_id', parent: 'b' },
    ]

    const walked = planPurge(cyclic, 'repositories')

    expect(walked.length).toBeLessThan(30)
    expect(walked.map(step => step.table)).toContain('b')
  })

  test('a schema with nothing hanging off the root plans nothing', () => {
    expect(planPurge([], 'repositories')).toEqual([])
  })
})

describe('deletionOrder', () => {
  const order = deletionOrder(steps)
  const position = (table: string) => order.findIndex(step => step.table === table)

  test('children go before the rows that own them', () => {
    expect(position('issue_comments')).toBeLessThan(position('issues'))
    expect(position('review_comments')).toBeLessThan(position('pull_request_reviews'))
    expect(position('pull_request_reviews')).toBeLessThan(position('pull_requests'))
    expect(position('webhook_deliveries')).toBeLessThan(position('webhooks'))
  })

  test('a grandchild goes before its grandparent', () => {
    expect(position('review_comments')).toBeLessThan(position('pull_requests'))
  })

  /** The case that made the first version of this wrong. */
  test('issues go before the milestones they point at', () => {
    expect(position('issues')).toBeLessThan(position('milestones'))
  })

  test('one delete per table, however many columns reach it', () => {
    expect(new Set(order.map(step => step.table)).size).toBe(order.length)
    expect(steps.filter(step => step.table === 'issue_labels')).toHaveLength(2)
    expect(order.filter(step => step.table === 'issue_labels')).toHaveLength(1)
  })

  test('covers every table the plan found', () => {
    expect(new Set(order.map(step => step.table))).toEqual(new Set(steps.map(step => step.table)))
  })

  /**
   * The property the whole ordering exists for, checked against the graph
   * rather than against a handful of named pairs.
   */
  test('no table is emptied while something still points at it', () => {
    const emptied = new Set<string>()

    for (const step of order) {
      for (const edge of EDGES) {
        if (edge.parent !== step.table || edge.child === edge.parent)
          continue

        // A child that is not part of this plan cannot be pointing at these
        // rows, because it was never reachable from the repository.
        if (!steps.some(other => other.table === edge.child))
          continue

        expect(emptied.has(edge.child), `${step.table} emptied before ${edge.child}`).toBe(true)
      }

      emptied.add(step.table)
    }
  })
})

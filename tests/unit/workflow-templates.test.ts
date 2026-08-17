// Starter workflows, for a repository that has none.
//
// The empty state is where somebody decides whether CI here is worth the
// afternoon. The tests that matter are not about the copy: they are that every
// starter is a real workflow this instance would actually run, because a
// starter that does not parse is worse than no starter at all.

import { describe, expect, test } from 'bun:test'
import { STARTERS, starter, startersFor } from '../../app/Actions/Workflow/templates'
import { parseWorkflow } from '../../app/Actions/Workflow/parse'
import { pushStartsRun } from '../../app/Actions/Workflow/triggers'

describe('every starter', () => {
  test('parses with no errors', () => {
    const problems: Array<{ id: string, errors: unknown[] }> = []

    for (const template of STARTERS) {
      const result = parseWorkflow(template.content, template.path)

      if (!result.ok || result.errors.length > 0)
        problems.push({ id: template.id, errors: result.errors })
    }

    // Named rather than counted: a starter that does not parse is worse than
    // no starter, and the failure should say which one.
    expect(problems).toEqual([])
  })

  test('and would actually start a run', () => {
    /*
     * The difference between a file that parses and a file that does
     * something. A starter whose triggers this instance does not dispatch
     * would sit on the workflows page saying "runs on nothing", which is a
     * worse first impression than an empty state.
     */
    for (const template of STARTERS) {
      const result = parseWorkflow(template.content, template.path)
      const triggers = result.workflow!.triggers

      const dispatches = triggers.push !== null
        || triggers.pullRequest !== null
        || triggers.dispatch
        || triggers.schedule.length > 0

      expect({ id: template.id, dispatches }).toEqual({ id: template.id, dispatches: true })
    }
  })

  test('a push to main starts the ones that say they run on push', () => {
    for (const template of STARTERS) {
      const parsed = parseWorkflow(template.content, template.path).workflow!

      if (!parsed.triggers.push)
        continue

      const decision = pushStartsRun(
        {
          on_push: true,
          push_branches: parsed.triggers.push.branches.join('\n'),
          push_tags: parsed.triggers.push.tags.join('\n'),
          push_paths: parsed.triggers.push.paths.join('\n'),
        },
        { ref: 'refs/heads/main', changed: ['src/a.ts'] },
      )

      expect({ id: template.id, run: decision.run }).toEqual({ id: template.id, run: true })
    }
  })

  test('has a name, a description and somewhere to go', () => {
    for (const template of STARTERS) {
      expect(template.name.length).toBeGreaterThan(0)
      expect(template.description.length).toBeGreaterThan(20)
      expect(template.path.startsWith('.github/workflows/')).toBe(true)
      expect(template.content.endsWith('\n')).toBe(true)
    }
  })

  test('and a unique id', () => {
    const ids = STARTERS.map(template => template.id)

    expect(new Set(ids).size).toBe(ids.length)
  })

  /*
   * A starter that needs editing before it works is an editing task, and an
   * editing task is a decision, and a decision is where people stop. Nothing
   * here should carry a placeholder somebody has to notice.
   */
  test('carries no placeholder anybody has to fill in', () => {
    for (const template of STARTERS) {
      expect(template.content).not.toContain('TODO')
      expect(template.content).not.toContain('<your')
      expect(template.content).not.toContain('CHANGEME')
    }
  })
})

describe('choosing one', () => {
  test('by id', () => {
    expect(starter('node')?.name).toBe('Node')
    expect(starter('NODE')?.id).toBe('node')
    expect(starter('nothing')).toBeNull()
  })

  test('a repository\'s languages reorder them without hiding any', () => {
    // A suggestion that removes options is a suggestion that is wrong at
    // somebody's expense.
    const ordered = startersFor(['bun'])

    expect(ordered[0]?.id).toBe('bun')
    expect(ordered).toHaveLength(STARTERS.length)
  })

  test('and knowing nothing about a repository keeps the default order', () => {
    expect(startersFor([]).map(template => template.id)).toEqual(STARTERS.map(template => template.id))
  })
})

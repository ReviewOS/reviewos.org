// Deployment environments: what holds a job, what refuses it, and who may say
// go.
//
// `environment: production` is the line everybody writes and almost nobody
// checks. Parsing the key and running the job anyway is worse than refusing it
// outright: the workflow says the deploy is protected, the run screen shows an
// environment, and nothing at all is enforced.

import { describe, expect, test } from 'bun:test'
import { decideGate, matchesBranch, mayApprove } from '../../app/Actions/Workflow/environments'
import { parseWorkflow } from '../../app/Actions/Workflow/parse'

const NOW = new Date('2026-03-01T12:00:00.000Z')

function rules(over: Partial<Parameters<typeof decideGate>[0]['rules'] & object> = {}): any {
  return { id: 1, name: 'production', waitMinutes: 0, reviewers: [], branches: [], ...over }
}

describe('reading the key', () => {
  test('a name, and Actions\' object form, both give the name', () => {
    const plain = parseWorkflow(`
name: ship
on: push
jobs:
  deploy:
    runs-on: ubuntu-latest
    environment: production
    steps:
      - run: ./deploy
`)

    expect(plain.workflow?.jobs?.[0]?.environment).toBe('production')

    /*
     * The object form carries a url this instance does not record. Read for
     * the name rather than refused: a workflow that already runs elsewhere
     * should not have to be edited to run here, and the url is a fact about a
     * finished deploy rather than a rule about whether one may happen.
     */
    const detailed = parseWorkflow(`
name: ship
on: push
jobs:
  deploy:
    runs-on: ubuntu-latest
    environment:
      name: production
      url: https://example.com
    steps:
      - run: ./deploy
`)

    expect(detailed.workflow?.jobs?.[0]?.environment).toBe('production')
  })
})

describe('what an environment does to a job', () => {
  test('an environment nobody configured is not protection', () => {
    /*
     * `environment: staging` in a repository with no `staging` is a label a
     * workflow author used for their own documentation. Refusing to run it
     * would break most workflows that use the key at all.
     */
    expect(decideGate({ rules: null, ref: 'refs/heads/main', readyAt: NOW, now: NOW, approved: false }))
      .toEqual({ verdict: 'run' })
  })

  test('a reviewer requirement holds the job', () => {
    const decision = decideGate({
      rules: rules({ reviewers: [7] }),
      ref: 'refs/heads/main',
      readyAt: NOW,
      now: NOW,
      approved: false,
    })

    expect(decision.verdict).toBe('hold')
    expect((decision as any).needsReviewer).toBe(true)
  })

  test('and lets it go once somebody has approved', () => {
    expect(decideGate({
      rules: rules({ reviewers: [7] }),
      ref: 'refs/heads/main',
      readyAt: NOW,
      now: NOW,
      approved: true,
    })).toEqual({ verdict: 'run' })
  })

  test('a wait timer holds it until the clock says otherwise, and says when', () => {
    const held = decideGate({
      rules: rules({ waitMinutes: 10 }),
      ref: 'refs/heads/main',
      readyAt: NOW,
      now: new Date(NOW.getTime() + 4 * 60_000),
      approved: false,
    })

    expect(held.verdict).toBe('hold')
    expect((held as any).until).toBe(new Date(NOW.getTime() + 10 * 60_000).toISOString())

    expect(decideGate({
      rules: rules({ waitMinutes: 10 }),
      ref: 'refs/heads/main',
      readyAt: NOW,
      now: new Date(NOW.getTime() + 11 * 60_000),
      approved: false,
    })).toEqual({ verdict: 'run' })
  })

  test('the timer runs from when the job was ready, not from the approval', () => {
    /*
     * A reviewer who approves immediately should not restart the clock. The
     * window exists so somebody can catch a mistake, and an approval is
     * evidence the deploy is wanted rather than a reason to wait longer.
     */
    expect(decideGate({
      rules: rules({ reviewers: [7], waitMinutes: 10 }),
      ref: 'refs/heads/main',
      readyAt: NOW,
      now: new Date(NOW.getTime() + 11 * 60_000),
      approved: true,
    })).toEqual({ verdict: 'run' })
  })

  test('a branch outside the policy is refused, not held', () => {
    /*
     * Waiting for an approval that must not be given is worse than a clear no,
     * and a reviewer repeatedly asked to approve deploys from the wrong branch
     * will eventually approve one.
     */
    const decision = decideGate({
      rules: rules({ branches: ['main', 'release/*'], reviewers: [7] }),
      ref: 'refs/heads/spike',
      readyAt: NOW,
      now: NOW,
      approved: false,
    })

    expect(decision.verdict).toBe('refuse')
    expect((decision as any).reason).toContain('may not deploy to production')
    expect((decision as any).reason).toContain('release/*')
  })

  test('and the policy matches the shapes people write', () => {
    expect(matchesBranch('main', 'main')).toBe(true)
    expect(matchesBranch('main', 'maintenance')).toBe(false)
    expect(matchesBranch('release/*', 'release/2.1')).toBe(true)
    expect(matchesBranch('release/*', 'hotfix/2.1')).toBe(false)
    expect(matchesBranch('*', 'anything')).toBe(true)
  })
})

describe('who may open the gate', () => {
  test('a listed reviewer may', () => {
    expect(mayApprove(rules({ reviewers: [7, 9] }), 9, 4).ok).toBe(true)
  })

  test('somebody who is not on the list may not, and is told why', () => {
    const answer = mayApprove(rules({ reviewers: [7] }), 9, 4)

    expect(answer.ok).toBe(false)
    expect(String(answer.reason)).toContain('you are not one of them')
  })

  test('and the person who started the run may not, even on the list', () => {
    /*
     * The failure nobody notices because the list looks right: a required
     * reviewer who can approve their own deploy is a rule that reads as two
     * people and behaves as one.
     */
    const answer = mayApprove(rules({ reviewers: [7] }), 7, 7)

    expect(answer.ok).toBe(false)
    expect(String(answer.reason)).toContain('Somebody else has to approve')
  })

  test('an environment with no reviewers is opened by anybody who may approve at all', () => {
    // The endpoint already required `workflow:approve` to get here. A wait
    // timer with no reviewer list is a pause, not a permission.
    expect(mayApprove(rules(), 7, 7).ok).toBe(true)
  })
})

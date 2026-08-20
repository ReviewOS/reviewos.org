// Who is told when a run ends.
//
// The matcher is where this feature is decided, so it is where the tests are:
// these are the rules that make somebody's phone buzz at three in the morning,
// and the case every implementation gets wrong is `recovery` - "not failed" is
// not the same as "fixed".

import { describe, expect, test } from 'bun:test'
import { conditionHolds, globMatches, matchRules, notificationTitle } from '../../app/Actions/Workflow/notifyRules'

const rule = (over: Partial<Parameters<typeof matchRules>[0][number]> = {}) => ({
  userId: 1,
  workflow: '*',
  branch: '*',
  jobKey: '',
  condition: 'failure' as const,
  ...over,
})

const outcome = (over: Partial<Parameters<typeof matchRules>[1]> = {}) => ({
  workflowPath: '.github/workflows/deploy.yml',
  workflowName: 'Deploy',
  branch: 'main',
  state: 'failed',
  previousState: 'succeeded',
  jobs: [{ key: 'build', state: 'succeeded', previousState: 'succeeded' }, { key: 'publish', state: 'failed', previousState: 'succeeded' }],
  ...over,
})

describe('naming a workflow', () => {
  test('works by path, by file name, and by the workflow\'s own name', () => {
    // All three are what somebody has to hand: the path is what the repository
    // shows, the file name is what people type, the name is what the runs page
    // says.
    for (const named of ['.github/workflows/deploy.yml', 'deploy.yml', 'Deploy'])
      expect(matchRules([rule({ workflow: named })], outcome())).toHaveLength(1)

    expect(matchRules([rule({ workflow: 'nightly.yml' })], outcome())).toEqual([])
  })

  test('and a glob is as narrow as it needs to be', () => {
    expect(globMatches('*', 'anything')).toBe(true)
    expect(globMatches('release/*', 'release/2.1')).toBe(true)
    expect(globMatches('release/*', 'main')).toBe(false)
    // Not a full glob library on purpose: the two shapes above are what a
    // person writes here, and a matcher with more surprises than that has them
    // land as a missed alert.
    expect(globMatches('main', 'main')).toBe(true)
    expect(globMatches('main', 'maintenance')).toBe(false)
  })
})

describe('recovery', () => {
  test('is a success after something that was not one', () => {
    expect(conditionHolds('recovery', 'succeeded', 'failed')).toBe(true)
    expect(conditionHolds('recovery', 'succeeded', 'cancelled')).toBe(true)
    expect(conditionHolds('recovery', 'succeeded', 'succeeded')).toBe(false)
    expect(conditionHolds('recovery', 'failed', 'failed')).toBe(false)
  })

  test('and a first run going green is not one', () => {
    // Nothing was broken. Treating this as a recovery is how a new workflow's
    // first success wakes somebody up.
    expect(conditionHolds('recovery', 'succeeded', null)).toBe(false)
  })

  test('so a rule for it fires exactly once, on the run that fixed it', () => {
    const rules = [rule({ condition: 'recovery' })]

    expect(matchRules(rules, outcome({ state: 'succeeded', previousState: 'failed' }))).toHaveLength(1)
    expect(matchRules(rules, outcome({ state: 'succeeded', previousState: 'succeeded' }))).toEqual([])
  })
})

describe('a rule about one job', () => {
  test('fires on that job rather than on the run', () => {
    const matched = matchRules([rule({ jobKey: 'publish' })], outcome({ state: 'failed' }))

    expect(matched).toHaveLength(1)
    expect(matched[0]!.jobKey).toBe('publish')
    expect(matched[0]!.state).toBe('failed')
  })

  test('and stays quiet when that job passed, however the run ended', () => {
    // The nightly with forty green jobs and one red deploy: the person who
    // cares about `build` should not hear about `publish` breaking.
    expect(matchRules([rule({ jobKey: 'build' })], outcome({ state: 'failed' }))).toEqual([])
  })

  test('and a job the run does not have matches nothing', () => {
    expect(matchRules([rule({ jobKey: 'nonexistent' })], outcome())).toEqual([])
  })
})

describe('one person, one notification', () => {
  test('however many of their rules matched', () => {
    /*
     * A repository with a rule for the run and one for each of three jobs would
     * otherwise send four messages about one push, which is how somebody ends
     * up muting the repository.
     */
    const matched = matchRules([
      rule({ condition: 'failure' }),
      rule({ jobKey: 'publish', condition: 'failure' }),
      rule({ condition: 'always' }),
    ], outcome())

    expect(matched).toHaveLength(1)
  })

  test('and the narrower rule is the one that decides what it says', () => {
    const matched = matchRules([
      rule({ condition: 'failure' }),
      rule({ jobKey: 'publish', condition: 'failure' }),
    ], outcome())

    // Whoever wrote the rule naming a job said what they cared about.
    expect(matched[0]!.jobKey).toBe('publish')
  })

  /*
   * The case that was wrong, and the shape it takes in real life: somebody has
   * a targeted rule for the thing they own and a blanket one because they like
   * to keep an eye on the repository. Both match. Only one of them answers the
   * question the reason line exists to answer.
   */
  test('a rule naming a workflow beats a blanket one, whichever came first', () => {
    const targeted = rule({ workflow: 'deploy.yml', branch: 'main', condition: 'failure' })
    const blanket = rule({ workflow: '*', branch: '*', condition: 'always' })

    for (const order of [[targeted, blanket], [blanket, targeted]]) {
      const matched = matchRules(order, outcome({ state: 'failed' }))

      expect(matched).toHaveLength(1)
      expect(matched[0]!.rule.workflow).toBe('deploy.yml')
    }
  })

  test('naming a branch beats not naming one', () => {
    const matched = matchRules([
      rule({ workflow: '*', branch: '*', condition: 'always' }),
      rule({ workflow: '*', branch: 'main', condition: 'always' }),
    ], outcome())

    expect(matched[0]!.rule.branch).toBe('main')
  })

  /*
   * `always` fires on every outcome, so a rule that names one is about
   * something. Ranked below the workflow and the branch, which is the order
   * people describe their own rules in.
   */
  test('naming a condition beats always, and loses to naming a workflow', () => {
    expect(matchRules([
      rule({ workflow: '*', branch: '*', condition: 'always' }),
      rule({ workflow: '*', branch: '*', condition: 'failure' }),
    ], outcome({ state: 'failed' }))[0]!.rule.condition).toBe('failure')

    expect(matchRules([
      rule({ workflow: '*', branch: '*', condition: 'failure' }),
      rule({ workflow: 'deploy.yml', branch: '*', condition: 'always' }),
    ], outcome({ state: 'failed' }))[0]!.rule.workflow).toBe('deploy.yml')
  })

  /**
   * The rule the whole weighting exists to protect: naming a job outranks every
   * combination of the other three, so the most specific run-wide rule still
   * loses to a job.
   */
  test('naming a job still beats the narrowest run-wide rule there is', () => {
    const matched = matchRules([
      rule({ workflow: 'deploy.yml', branch: 'main', condition: 'failure' }),
      rule({ jobKey: 'publish', workflow: '*', branch: '*', condition: 'always' }),
    ], outcome({ state: 'failed' }))

    expect(matched[0]!.jobKey).toBe('publish')
  })

  /**
   * Two rules of the same shape say the same thing, so the first stands. This
   * is what stops the sentence depending on which row came back first -
   * `rulesFor` orders by id for the same reason.
   */
  test('equally narrow rules leave the first one standing', () => {
    const first = rule({ id: 1, workflow: 'deploy.yml', branch: 'main', condition: 'failure' })
    const second = rule({ id: 2, workflow: 'deploy.yml', branch: 'main', condition: 'failure' })

    expect(matchRules([first, second], outcome({ state: 'failed' }))[0]!.rule.id).toBe(1)
  })

  test('but two people both hear', () => {
    const matched = matchRules([rule({ userId: 1 }), rule({ userId: 2 })], outcome())

    expect(matched.map(one => one.rule.userId).sort()).toEqual([1, 2])
  })
})

describe('what it says', () => {
  test('names the workflow, the job when there is one, and the run', () => {
    expect(notificationTitle({ repository: 'acme/widgets', runNumber: 12, workflowName: 'Deploy', jobKey: 'publish', state: 'failed', recovered: false }))
      .toBe('Deploy / publish failed in acme/widgets run #12')
  })

  test('and a recovery reads as one rather than as another success', () => {
    // "Deploy succeeded" after four failures is a sentence somebody has to
    // work out. "Passing again" is the thing they wanted to know.
    expect(notificationTitle({ repository: 'acme/widgets', runNumber: 13, workflowName: 'Deploy', jobKey: '', state: 'succeeded', recovered: true }))
      .toBe('Deploy is passing again in acme/widgets run #13')
  })
})

// A deployment that arrives in stages, and the rule that moves it.
//
// The alternative every provider offers is one opaque operation: you call
// `deploy --canary`, something happens for eleven minutes, and either it worked
// or a support ticket begins. What is missing there is not features, it is
// legibility - nobody can say which stage it reached or why it went back.
//
// So the decision is pure and tested here, because "promote, hold, or go back"
// is the rule people argue about at the worst possible moment: during an
// incident, reading a history.

import { describe, expect, test } from 'bun:test'
import { decideStage, stagesFrom } from '../../app/Actions/Deploy/stages'

const plan = stagesFrom('canary:10, half:50, all:100')

describe('reading a plan', () => {
  test('takes the short form, because a list of percentages is what people mean', () => {
    expect(stagesFrom('10,50,100').map(one => one.percent)).toEqual([10, 50, 100])
    // A stage with no name is named for its share, so a screen has something
    // to show.
    expect(stagesFrom('10').map(one => one.name)).toEqual(['10%', 'all'])
  })

  test('and names them when the names are worth having', () => {
    expect(plan.map(one => one.name)).toEqual(['canary', 'half', 'all'])
  })

  test('orders by share rather than as written', () => {
    // A plan listing 50 before 10 is a typo, and running it in that order puts
    // half the users on an untested build in the name of being careful.
    expect(stagesFrom('50,10,100').map(one => one.percent)).toEqual([10, 50, 100])
  })

  test('and completes a plan that stops short', () => {
    /*
     * A rollout that ends at 50% and calls itself finished is a deployment half
     * the users never receive, and nobody writes that on purpose.
     */
    expect(stagesFrom('10,50').map(one => one.percent)).toEqual([10, 50, 100])
  })

  test('ignoring anything that is not a share', () => {
    expect(stagesFrom('soon,10,500,-2')).toEqual([{ name: '10%', percent: 10 }, { name: 'all', percent: 100 }])
    expect(stagesFrom('')).toEqual([])
  })
})

describe('what happens next', () => {
  test('a healthy stage promotes to the next one, by name', () => {
    const verdict = decideStage({ stages: plan, current: 0, health: 'healthy' })

    expect(verdict.action).toBe('promote')
    expect((verdict as any).stage.name).toBe('half')
    expect(String(verdict.reason)).toContain('50%')
  })

  test('and the last one completes rather than promoting into nothing', () => {
    expect(decideStage({ stages: plan, current: 2, health: 'healthy' }).action).toBe('complete')
  })

  test('an unhealthy stage goes back', () => {
    const verdict = decideStage({ stages: plan, current: 1, health: 'unhealthy' })

    expect(verdict.action).toBe('roll-back')
  })

  test('and a check that has not answered holds, rather than guessing either way', () => {
    /*
     * The value that matters. Treating "unknown" as failure rolls back every
     * deployment whose probe is a second slow; treating it as success promotes
     * on no evidence at all.
     */
    expect(decideStage({ stages: plan, current: 0, health: 'unknown' }).action).toBe('hold')
  })
})

describe('a person holding the rollout', () => {
  test('beats a healthy check, because that is what pause is for', () => {
    // Somebody watching a graph they do not like is the reason the button
    // exists, and a rollout that promoted anyway would be a button that does
    // nothing.
    expect(decideStage({ stages: plan, current: 0, health: 'healthy', held: true }).action).toBe('hold')
  })

  test('but does not keep a failing deployment serving traffic', () => {
    /*
     * A held rollout that has gone unhealthy is not a decision anybody is still
     * weighing: holding would leave the bad build serving while somebody
     * decides about a question that has already been answered.
     */
    expect(decideStage({ stages: plan, current: 1, health: 'unhealthy', held: true }).action).toBe('roll-back')
  })
})

describe('a deployment with no plan', () => {
  test('is complete, because there is nothing to promote through', () => {
    expect(decideStage({ stages: [], current: 0, health: 'healthy' }).action).toBe('complete')
  })
})

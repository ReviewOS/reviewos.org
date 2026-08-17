// Monitors: a rule that fires when the answer changes, and not otherwise.
//
// The state machine is the feature. "Is the failure rate above 5%" is true
// every hour it is true, and a rule that acted on the answer would send the
// same alarm twenty-four times a day - which is how a channel becomes one
// people mute, and the muted channel is the one that has to work the day it
// matters.

import { describe, expect, test } from 'bun:test'
import { CONDITIONS, decideTransition } from '../../app/Actions/Tests/monitors'

describe('deciding whether to say anything', () => {
  test('crossing the line raises an alarm', () => {
    // Percentages throughout: `5` is five percent, which is what somebody
    // typing 5 into a failure-rate field meant.
    expect(decideTransition({ state: 'ok', measurement: 9, threshold: 5 })).toBe('alarm')
  })

  test('and staying over it says nothing at all', () => {
    // The whole point. A monitor in alarm for a month sends one message.
    expect(decideTransition({ state: 'alarm', measurement: 31, threshold: 5 })).toBeNull()
  })

  test('coming back under recovers, once', () => {
    /*
     * The recovery is not a courtesy: somebody told a suite is unreliable has
     * no way to learn it is fine again, and a dashboard that only ever goes
     * red is one people stop reading.
     */
    expect(decideTransition({ state: 'alarm', measurement: 1, threshold: 5 })).toBe('recovered')
    expect(decideTransition({ state: 'ok', measurement: 1, threshold: 5 })).toBeNull()
  })

  test('exactly at the threshold is not over it', () => {
    // `> threshold`, not `>=`. "Alarm above five percent" is what somebody
    // wrote down, and a rule that fires at exactly five is a rule that
    // disagrees with its own description.
    expect(decideTransition({ state: 'ok', measurement: 5, threshold: 5 })).toBeNull()
  })

  test('and a measurement it could not take is not a recovery', () => {
    /*
     * The dangerous one. A suite nobody reported for this week has no failure
     * rate, and reading that as "back to normal" would clear an alarm because
     * the *reporting* broke - exactly when somebody needs the alarm to still
     * be there.
     */
    expect(decideTransition({ state: 'alarm', measurement: null, threshold: 5 })).toBeNull()
    expect(decideTransition({ state: 'ok', measurement: null, threshold: 5 })).toBeNull()
  })
})

describe('the conditions', () => {
  test('are three, each with a unit somebody can set a number against', () => {
    // No expression language, deliberately: a general one is a second product
    // to document, test and get wrong.
    expect(Object.keys(CONDITIONS).sort()).toEqual(['duration', 'fail_rate', 'flaky'])

    /*
     * A failure rate is a percentage, and the unit is the point. A field that
     * wants a share turns somebody's `5` into five hundred percent - a monitor
     * that can never fire, which reads as covered.
     */
    expect(CONDITIONS.fail_rate.unit).toBe('%')

    for (const definition of Object.values(CONDITIONS)) {
      expect(definition.unit.length).toBeGreaterThan(0)
      expect(definition.describes.length).toBeGreaterThan(10)
    }
  })
})

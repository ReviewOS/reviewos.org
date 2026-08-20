// The two numbers whose right value depends on the disk somebody bought.
//
// Both were constants with a comment saying they belonged in configuration.
// The tests here are about the defaults and the refusals, because a
// configuration setting that silently accepts nonsense is worse than one that
// does not exist: the operator believes they set it.

import { describe, expect, test } from 'bun:test'
import { logRetentionDays, maxJobLogBytes } from '../../config/ci-logs'

describe('the ceiling on one job\'s output', () => {
  test('defaults to two megabytes, which is an enormous build log', () => {
    expect(maxJobLogBytes({})).toBe(2 * 1024 * 1024)
  })

  test('takes an operator\'s number', () => {
    expect(maxJobLogBytes({ CI_LOG_MAX_BYTES: String(8 * 1024 * 1024) })).toBe(8 * 1024 * 1024)
  })

  test('and refuses one below a single chunk, which would discard every append', () => {
    /*
     * A ceiling smaller than the largest chunk a runner may send is a
     * configuration that turns logs off without saying so - every append past
     * the first would be accepted and thrown away.
     */
    expect(maxJobLogBytes({ CI_LOG_MAX_BYTES: '1024' })).toBe(2 * 1024 * 1024)
    expect(maxJobLogBytes({ CI_LOG_MAX_BYTES: 'lots' })).toBe(2 * 1024 * 1024)
    expect(maxJobLogBytes({ CI_LOG_MAX_BYTES: '-1' })).toBe(2 * 1024 * 1024)
  })
})

describe('how long output is kept', () => {
  test('is forever unless somebody says otherwise', () => {
    /*
     * The default is the decision. The first time anybody wants a build log is
     * usually weeks after they stopped caring about the run, so an instance
     * that has never thought about this should still have it.
     */
    expect(logRetentionDays({})).toBe(0)
    expect(logRetentionDays({ CI_LOG_RETENTION_DAYS: '0' })).toBe(0)
  })

  test('and a number of days when they do', () => {
    expect(logRetentionDays({ CI_LOG_RETENTION_DAYS: '30' })).toBe(30)
  })

  test('with anything unreadable meaning forever rather than nothing', () => {
    // The safe direction for a typo: keeping too much costs disk, and deleting
    // on a misread number costs the logs.
    expect(logRetentionDays({ CI_LOG_RETENTION_DAYS: 'thirty' })).toBe(0)
    expect(logRetentionDays({ CI_LOG_RETENTION_DAYS: '-5' })).toBe(0)
  })
})

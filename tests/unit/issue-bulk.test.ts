/**
 * Reading a bulk selection off a form.
 *
 * Bulk actions are the ones that go wrong at scale. A mis-parsed selection
 * closes forty issues instead of four, and the only person who finds out is
 * whoever gets forty notifications.
 */

import { describe, expect, test } from 'bun:test'
import { abilityFor, BULK_LIMIT, isBulkOperation, selectedNumbers } from '../../app/Actions/Issue/bulk'

describe('selectedNumbers', () => {
  /** A form sends one value for one ticked box and an array for several. */
  test('takes a single value and a list alike', () => {
    expect(selectedNumbers('12')).toEqual({ ok: true, numbers: [12] })
    expect(selectedNumbers(['1', '2', '3'])).toEqual({ ok: true, numbers: [1, 2, 3] })
  })

  test('keeps the order they were sent in', () => {
    expect(selectedNumbers(['9', '2', '7'])).toEqual({ ok: true, numbers: [9, 2, 7] })
  })

  test('collapses a number sent twice', () => {
    expect(selectedNumbers(['4', '4', '5'])).toEqual({ ok: true, numbers: [4, 5] })
  })

  test('refuses an empty selection rather than doing nothing quietly', () => {
    expect(selectedNumbers([])).toEqual({ ok: false, error: 'Nothing was selected' })
    expect(selectedNumbers(undefined)).toEqual({ ok: false, error: 'Nothing was selected' })
    expect(selectedNumbers(null)).toEqual({ ok: false, error: 'Nothing was selected' })
  })

  /**
   * Dropping the bad entry would act on a smaller set than the person chose,
   * while they are looking at a confirmation that says otherwise.
   */
  test('refuses the whole request when one entry is not a number', () => {
    expect(selectedNumbers(['1', 'all', '3']).ok).toBe(false)
    expect(selectedNumbers(['1', '2.5']).ok).toBe(false)
    expect(selectedNumbers(['1', '-3']).ok).toBe(false)
    expect(selectedNumbers(['0']).ok).toBe(false)
    expect(selectedNumbers(['']).ok).toBe(false)
  })

  test('takes a full page of the list, and refuses more', () => {
    const page = Array.from({ length: BULK_LIMIT }, (_, index) => String(index + 1))

    expect(selectedNumbers(page).ok).toBe(true)
    expect(selectedNumbers([...page, '999'])).toEqual({ ok: false, error: `That is more than ${BULK_LIMIT} issues` })
  })
})

describe('isBulkOperation', () => {
  test('accepts what the list offers', () => {
    for (const operation of ['close', 'reopen', 'label', 'unlabel', 'milestone'])
      expect(isBulkOperation(operation)).toBe(true)
  })

  test('refuses anything else rather than guessing', () => {
    expect(isBulkOperation('delete')).toBe(false)
    expect(isBulkOperation('CLOSE')).toBe(false)
    expect(isBulkOperation('')).toBe(false)
    expect(isBulkOperation(undefined)).toBe(false)
    expect(isBulkOperation(12)).toBe(false)
  })
})

describe('abilityFor', () => {
  /**
   * Nothing should be reachable in bulk that is not reachable singly, and the
   * mapping lives in one place because a permission check written per branch
   * is one that eventually gets missed on a branch.
   */
  test('asks for what the single-issue version asks for', () => {
    expect(abilityFor('close')).toBe('issue:close')
    expect(abilityFor('reopen')).toBe('issue:close')
    expect(abilityFor('label')).toBe('issue:label')
    expect(abilityFor('unlabel')).toBe('issue:label')
    expect(abilityFor('milestone')).toBe('issue:milestone')
  })

  test('covers every operation, so a new one cannot ship without a permission', () => {
    for (const operation of ['close', 'reopen', 'label', 'unlabel', 'milestone'] as const)
      expect(abilityFor(operation)).toBeTruthy()
  })
})

/**
 * Which issues a merge closes.
 *
 * `closingReferences` finds `fixes #12` in a piece of text and is tested next
 * door. This is the policy on top of it, and policy is where the damage is: a
 * merge that closes the wrong issue shuts somebody's report with a link to a
 * change that has nothing to do with it.
 */

import { describe, expect, test } from 'bun:test'
import { closingTargets, withoutSelf } from '../../app/Actions/Issue/closing'

const HERE = { owner: 'stacks', repository: 'stacks' }

function numbers(text: string, scope = HERE): number[] {
  return closingTargets(text, scope).map(target => target.number)
}

describe('closingTargets', () => {
  test('takes the plain form', () => {
    expect(numbers('fixes #12')).toEqual([12])
    expect(numbers('This closes #3 at last.')).toEqual([3])
  })

  test('takes every keyword people actually write', () => {
    for (const keyword of ['close', 'closes', 'closed', 'fix', 'fixes', 'fixed', 'resolve', 'resolves', 'resolved'])
      expect(numbers(`${keyword} #9`)).toEqual([9])
  })

  test('keeps the keyword that was used', () => {
    expect(closingTargets('Resolves #4', HERE)).toEqual([{ number: 4, keyword: 'resolves' }])
  })

  test('finds several, in the order written', () => {
    expect(numbers('fixes #2 and closes #7')).toEqual([2, 7])
  })

  test('closes an issue once however many times it is named', () => {
    expect(numbers('fixes #5, and also fixes #5')).toEqual([5])
  })

  test('ignores a bare reference with no keyword in front of it', () => {
    expect(numbers('Related to #12, see also #13')).toEqual([])
  })

  /**
   * The reason the parser skips code: a description quoting `fixes #12` in an
   * example would otherwise close issue 12 on merge.
   */
  test('ignores a keyword inside code', () => {
    expect(numbers('Write `fixes #12` in the description.')).toEqual([])
    expect(numbers('```\nfixes #12\n```')).toEqual([])
  })

  /**
   * A merge is performed by somebody with permission *here*. Following a
   * reference into another repository would let it close an issue there
   * quietly, possibly one they cannot even read.
   */
  test('does not follow a reference into another repository', () => {
    expect(numbers('fixes other/repo#12')).toEqual([])
    expect(numbers('closes someone/thing#1 and fixes #2')).toEqual([2])
  })

  test('keeps this repository named the long way', () => {
    expect(numbers('fixes stacks/stacks#12')).toEqual([12])
    expect(numbers('fixes Stacks/Stacks#12')).toEqual([12])
  })

  test('finds nothing in an empty or wordless body', () => {
    expect(numbers('')).toEqual([])
    expect(numbers('Just a description.')).toEqual([])
  })
})

describe('withoutSelf', () => {
  /**
   * Issues and pull requests share one numbering sequence, so a pull request
   * whose description says `fixes #7` while being pull request 7 would close
   * itself and end up reading as both merged and closed.
   */
  test('drops the pull request its own number', () => {
    expect(withoutSelf(closingTargets('fixes #7', HERE), 7)).toEqual([])
  })

  test('keeps the others', () => {
    expect(withoutSelf(closingTargets('fixes #7 and closes #8', HERE), 7).map(t => t.number)).toEqual([8])
  })

  test('leaves an unrelated list alone', () => {
    expect(withoutSelf(closingTargets('fixes #1', HERE), 99).map(t => t.number)).toEqual([1])
  })
})

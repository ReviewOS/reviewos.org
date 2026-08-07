/**
 * Telling a decision apart from its consequence.
 *
 * Most of this file is about what the classifier *refuses* to call mechanical,
 * and that is deliberate. Folding a hunk away and calling it a rename is a
 * promise that nothing in it needs reading; one real edit hidden among ninety
 * renames is the single failure this feature can cause, and it causes it inside
 * a diff the reviewer has been told is safe to skim.
 *
 * So every rule is conservative in the same direction: when a hunk could be
 * mechanical or could be logic, it is logic.
 */

import type { DiffFile, DiffHunk, DiffLine } from '../../app/Actions/Pull/diff'
import { describe, expect, test } from 'bun:test'
import {
  classifyFile,
  classifyHunk,
  movedRuns,
  pairChanges,
  sharedSubstitution,
  singleSubstitution,
} from '../../app/Actions/Pull/classify'

/**
 * A hunk from a compact spelling: `-` removed, `+` added, anything else context.
 *
 * Line numbers are filled in plausibly rather than correctly. Nothing in the
 * classifier reads them, and a fixture that had to keep them consistent would
 * be about arithmetic instead of about classification.
 */
function hunk(...spec: string[]): DiffHunk {
  const lines: DiffLine[] = spec.map((raw, index) => {
    const marker = raw[0]
    const content = raw.slice(1)

    if (marker === '-')
      return { origin: 'removed', content, oldLine: index + 1, newLine: null }
    if (marker === '+')
      return { origin: 'added', content, oldLine: null, newLine: index + 1 }

    return { origin: 'context', content, oldLine: index + 1, newLine: index + 1 }
  })

  return { oldStart: 1, oldLines: spec.length, newStart: 1, newLines: spec.length, heading: '', lines }
}

function file(...hunks: DiffHunk[]): DiffFile {
  return {
    path: 'src/a.ts',
    previousPath: null,
    status: 'modified',
    binary: false,
    additions: 0,
    deletions: 0,
    hunks,
    oldMode: null,
    newMode: null,
    lineEndings: 'lf',
  }
}

describe('pairChanges', () => {
  test('pairs a run of removals with the run of additions after it', () => {
    expect(pairChanges(hunk(' keep', '-was one', '-was two', '+is one', '+is two').lines))
      .toEqual([{ before: 'was one', after: 'is one' }, { before: 'was two', after: 'is two' }])
  })

  /**
   * Two replaced by five is not two pairs and three extra lines - it is a
   * rewrite, and there is no honest pairing of it. Answering null means every
   * classification declines, which is the right answer for a rewrite.
   */
  test('refuses to pair runs of different lengths', () => {
    expect(pairChanges(hunk('-was', '+is one', '+is two').lines)).toBeNull()
  })

  test('a pure addition pairs with nothing', () => {
    expect(pairChanges(hunk(' keep', '+new').lines)).toBeNull()
  })

  test('a hunk with no change at all has nothing to pair', () => {
    expect(pairChanges(hunk(' keep', ' also').lines)).toBeNull()
  })

  test('two separate runs in one hunk are both paired', () => {
    expect(pairChanges(hunk('-a', '+b', ' keep', '-c', '+d').lines))
      .toEqual([{ before: 'a', after: 'b' }, { before: 'c', after: 'd' }])
  })
})

describe('singleSubstitution', () => {
  /**
   * The smallest substitution, not the whole word. `oldName` becoming
   * `newName` shares the `Name`, so the swap is `old` to `new` - which is both
   * correct and the more useful thing to print, because it is the swap that
   * will match on every other line of a mass rename.
   */
  test('finds the smallest thing that changed', () => {
    expect(singleSubstitution('const total = oldName + 1', 'const total = newName + 1'))
      .toEqual({ from: 'old', to: 'new' })
  })

  test('finds a member path, because a rename moves those too', () => {
    expect(singleSubstitution('call(a.b.c)', 'call(x.y.z)')).toEqual({ from: 'a.b.c', to: 'x.y.z' })
  })

  /**
   * The rule that keeps this feature honest. `1` becoming `2` is a change of
   * behaviour that happens to be one character wide, and a hunk full of them
   * folded away as "a rename" is exactly the edit a reviewer is looking for,
   * hidden inside a diff they were told to skim.
   */
  test('a number is not an identifier, so a changed constant is not a rename', () => {
    expect(singleSubstitution('const limit = 1', 'const limit = 2')).toBeNull()
  })

  test('an operator changing is not a rename', () => {
    expect(singleSubstitution('if (a > b)', 'if (a >= b)')).toBeNull()
  })

  test('an insertion is not a substitution', () => {
    expect(singleSubstitution('call(a)', 'call(a, b)')).toBeNull()
    expect(singleSubstitution('call(a, b)', 'call(a)')).toBeNull()
  })

  test('two edits on one line are not one substitution', () => {
    // The prefix and suffix walk meets in the middle and hands back the whole
    // span between the two edits, which is not identifier-shaped.
    expect(singleSubstitution('a(one) + b(two)', 'a(ONE) + b(TWO)')).toBeNull()
  })

  test('an unchanged line has no substitution', () => {
    expect(singleSubstitution('same', 'same')).toBeNull()
  })
})

describe('sharedSubstitution', () => {
  test('the same swap on every line is a find and replace', () => {
    expect(sharedSubstitution([
      { before: 'old.a()', after: 'new.a()' },
      { before: 'old.b()', after: 'new.b()' },
      { before: 'return old', after: 'return new' },
    ])).toEqual({ from: 'old', to: 'new' })
  })

  /**
   * The case the whole rule exists for. Eighty-nine renames and one real edit
   * is not a rename, and a classifier that answered on the majority would fold
   * away the one line anybody needed to see.
   */
  test('one line that is not the shared swap makes the whole hunk logic', () => {
    expect(sharedSubstitution([
      { before: 'old.a()', after: 'new.a()' },
      { before: 'old.b()', after: 'new.b()' },
      { before: 'const limit = 1', after: 'const limit = 2' },
    ])).toBeNull()
  })

  test('two different swaps in one hunk are not one find and replace', () => {
    expect(sharedSubstitution([
      { before: 'old.a()', after: 'new.a()' },
      { before: 'other.b()', after: 'another.b()' },
    ])).toBeNull()
  })

  test('one line changed is somebody renaming a thing, and is shown', () => {
    expect(sharedSubstitution([{ before: 'old', after: 'new' }])).toBeNull()
  })
})

describe('classifyHunk', () => {
  test('a reindented block is formatting', () => {
    expect(classifyHunk(hunk('-  const a = 1', '+    const a = 1')).kind).toBe('formatting')
  })

  test('a mass rename says which name became which', () => {
    const result = classifyHunk(hunk('-old.a()', '-old.b()', '+new.a()', '+new.b()'))

    expect(result.kind).toBe('renamed-symbol')
    expect(result.detail).toBe('old to new')
  })

  test('a changed constant is logic, however few characters it is', () => {
    expect(classifyHunk(hunk('-const limit = 1', '-const other = 1', '+const limit = 2', '+const other = 2')).kind)
      .toBe('logic')
  })

  test('a rewrite is logic', () => {
    expect(classifyHunk(hunk('-was', '+is one', '+is two')).kind).toBe('logic')
  })

  test('an addition is logic', () => {
    expect(classifyHunk(hunk(' keep', '+brand new line')).kind).toBe('logic')
  })
})

describe('movedRuns', () => {
  const block = ['const a = 1', 'const b = 2', 'const c = 3']

  test('a block that left one place and arrived in another is a move', () => {
    const subject = file(
      hunk(...block.map(line => `-${line}`)),
      hunk(...block.map(line => `+${line}`)),
    )

    expect(movedRuns(subject).removed.size).toBe(1)
    expect(classifyFile(subject).reason).toBe('moved')
  })

  /**
   * The block moved *into* something, so it is indented differently and is
   * still the same block. Catching this is most of the value: a refactor that
   * wraps code in a conditional otherwise reads as every line changing.
   */
  test('re-indentation does not stop it being a move', () => {
    const subject = file(
      hunk(...block.map(line => `-${line}`)),
      hunk(...block.map(line => `+    ${line}`)),
    )

    expect(classifyFile(subject).reason).toBe('moved')
  })

  /**
   * A single brace leaving one place and appearing in another is not a move,
   * it is a brace. Without a minimum every diff in every language would be
   * mostly "moved".
   */
  test('a run shorter than the minimum is not a move', () => {
    const subject = file(hunk('-}', ' keep'), hunk('+}', ' keep'))

    expect(movedRuns(subject).removed.size).toBe(0)
    expect(classifyFile(subject).reason).not.toBe('moved')
  })

  test('a block that left twice and arrived once is not a clean move', () => {
    const subject = file(
      hunk(...block.map(line => `-${line}`)),
      hunk(...block.map(line => `-${line}`)),
      hunk(...block.map(line => `+${line}`)),
    )

    expect(movedRuns(subject).removed.size).toBe(0)
  })

  /**
   * The move happened, and one line inside the hunk also changed. That line has
   * not been read by anybody, so the hunk is logic.
   */
  test('a hunk that moved a block and edited something else is logic', () => {
    const subject = file(
      hunk(...block.map(line => `-${line}`), '-const d = 4'),
      hunk(...block.map(line => `+${line}`), '+const d = 5'),
    )

    expect(classifyFile(subject).reason).toBeNull()
  })
})

describe('classifyFile', () => {
  test('counts the mechanical hunks, which is the number worth printing', () => {
    const subject = file(
      hunk('-  const a = 1', '+    const a = 1'),
      hunk('-old.a()', '-old.b()', '+new.a()', '+new.b()'),
      hunk('-const limit = 1', '+const limit = 2'),
    )

    const result = classifyFile(subject)

    expect(result.mechanical).toBe(2)
    expect(result.allMechanical).toBe(false)
    // Two mechanical hunks and one that is not is not a file with a reason.
    // The honest summary of it is the diff.
    expect(result.reason).toBeNull()
  })

  test('a file that is only formatting says so', () => {
    const result = classifyFile(file(
      hunk('-  const a = 1', '+    const a = 1'),
      hunk('-\tconst b = 2', '+  const b = 2'),
    ))

    expect(result.allMechanical).toBe(true)
    expect(result.reason).toBe('formatting')
  })

  test('a file that is mechanical two different ways gives no single reason', () => {
    const result = classifyFile(file(
      hunk('-  const a = 1', '+    const a = 1'),
      hunk('-old.a()', '-old.b()', '+new.a()', '+new.b()'),
    ))

    expect(result.allMechanical).toBe(true)
    expect(result.reason).toBeNull()
  })

  /**
   * A rename with no content change has no hunks at all, so there is nothing to
   * read and nothing to say beyond the status the header already shows.
   */
  test('a rename with no content change needs no reading', () => {
    const result = classifyFile(file())

    expect(result.allMechanical).toBe(true)
    expect(result.mechanical).toBe(0)
    expect(result.reason).toBeNull()
  })
})

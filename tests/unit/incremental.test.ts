/**
 * The pure half of "since I last looked".
 *
 * Two proposals, compared. The bugs this file exists to catch are all of the
 * same kind: an implementation that walks only the new side and quietly loses
 * every file the author reverted, and a signature that reads a file as changed
 * because git printed a blob sha differently.
 */

import { describe, expect, test } from 'bun:test'
import { compareProposals, patchSignature, pathInPatch, staleTicks } from '../../app/Actions/Pull/incremental'

/** A patch for one file, in the shape git actually writes it. */
function patch(options: {
  path: string
  index?: string
  header?: string
  body?: string
}): string {
  return [
    `diff --git a/${options.path} b/${options.path}`,
    `index ${options.index ?? '1a2b3c4..5d6e7f8'} 100644`,
    `--- a/${options.path}`,
    `+++ b/${options.path}`,
    options.header ?? '@@ -1,3 +1,3 @@',
    ' context',
    options.body ?? '-was\n+is',
    ' more',
    '',
  ].join('\n')
}

describe('patchSignature', () => {
  test('the same proposal signs the same, whatever git abbreviated the blobs to', () => {
    const short = patch({ path: 'a.ts', index: '1a2b3c4..5d6e7f8' })
    const long = patch({ path: 'a.ts', index: '1a2b3c4d5e6..5d6e7f8a9b0' })

    // The abbreviation length grows with a repository's object count, so the
    // same content is printed two ways over its lifetime. Signing the index
    // line would make every file in the repository read as changed on the day
    // it crosses the threshold.
    expect(patchSignature(short)).toBe(patchSignature(long))
  })

  test('a different change signs differently', () => {
    expect(patchSignature(patch({ path: 'a.ts' })))
      .not.toBe(patchSignature(patch({ path: 'a.ts', body: '-was\n+something else' })))
  })

  /**
   * Not noise. A hunk header moving means the base changed this file's content
   * underneath the change, so the change now applies to different surrounding
   * code - which is precisely a thing to read again.
   */
  test('the same change at a different line signs differently', () => {
    expect(patchSignature(patch({ path: 'a.ts', header: '@@ -1,3 +1,3 @@' })))
      .not.toBe(patchSignature(patch({ path: 'a.ts', header: '@@ -80,3 +80,3 @@' })))
  })
})

describe('pathInPatch', () => {
  test('reads the path a file patch is about', () => {
    expect(pathInPatch(patch({ path: 'src/a.ts' }))).toBe('src/a.ts')
  })

  test('a deletion has no `+++` side, and is still about a path', () => {
    const deletion = [
      'diff --git a/gone.ts b/gone.ts',
      'deleted file mode 100644',
      'index 1a2b3c4..0000000',
      '--- a/gone.ts',
      '+++ /dev/null',
      '@@ -1,2 +0,0 @@',
      '-was here',
      '',
    ].join('\n')

    expect(pathInPatch(deletion)).toBe('gone.ts')
  })

  /**
   * git quotes a path with a space in it and the `b/` prefix is *inside* the
   * quotes. Stripping the prefix before the unquote is how every path with a
   * space came out as `b/my file.ts` once already, in the manifest parser.
   */
  test('a quoted path loses its prefix, not its spaces', () => {
    const quoted = [
      'diff --git "a/my file.ts" "b/my file.ts"',
      'index 1a2b3c4..5d6e7f8 100644',
      '--- "a/my file.ts"',
      '+++ "b/my file.ts"',
      '@@ -1 +1 @@',
      '-a',
      '+b',
      '',
    ].join('\n')

    expect(pathInPatch(quoted)).toBe('my file.ts')
  })

  /**
   * A patch that adds a line beginning `+++` contains something that looks
   * exactly like a header. Reading past the first hunk marker would name a
   * file out of somebody's source code.
   */
  test('content that looks like a header is content', () => {
    const tricky = [
      'diff --git a/real.ts b/real.ts',
      '--- a/real.ts',
      '+++ b/real.ts',
      '@@ -1 +2 @@',
      '+++ b/not-a-file.ts',
      '',
    ].join('\n')

    expect(pathInPatch(tricky)).toBe('real.ts')
  })
})

describe('compareProposals', () => {
  const before = new Map([['a.ts', 'aaa'], ['b.ts', 'bbb'], ['c.ts', 'ccc']])

  test('an unchanged file is counted, not listed', () => {
    const after = new Map([['a.ts', 'aaa'], ['b.ts', 'bbb'], ['c.ts', 'ccc']])
    const result = compareProposals(before, after)

    expect(result).toEqual({ changed: [], added: [], removed: [], unchanged: 3 })
  })

  test('a file whose proposal moved is the one to read again', () => {
    const after = new Map([['a.ts', 'aaa'], ['b.ts', 'DIFFERENT'], ['c.ts', 'ccc']])
    const result = compareProposals(before, after)

    expect(result.changed).toEqual(['b.ts'])
    expect(result.unchanged).toBe(2)
  })

  test('a file the pull request did not touch before is added, not changed', () => {
    const after = new Map([...before, ['d.ts', 'ddd']])
    const result = compareProposals(before, after)

    expect(result.added).toEqual(['d.ts'])
    expect(result.changed).toEqual([])
  })

  /**
   * The case an implementation that only walks the new side loses entirely.
   * A file the author reverted is gone from the current proposal, and a
   * reviewer who read it and formed an opinion about it needs to know it is no
   * longer being proposed at all.
   */
  test('a file the author reverted is reported as removed', () => {
    const after = new Map([['a.ts', 'aaa'], ['c.ts', 'ccc']])
    const result = compareProposals(before, after)

    expect(result.removed).toEqual(['b.ts'])
    expect(result.changed).toEqual([])
    expect(result.unchanged).toBe(2)
  })

  test('everything comes back sorted, so two calls read the same', () => {
    const after = new Map([['z.ts', '1'], ['a.ts', 'CHANGED'], ['m.ts', '2'], ['b.ts', 'ALSO']])
    const result = compareProposals(before, after)

    expect(result.changed).toEqual(['a.ts', 'b.ts'])
    expect(result.added).toEqual(['m.ts', 'z.ts'])
  })

  test('a first look at an empty proposal is not a crash', () => {
    expect(compareProposals(new Map(), new Map())).toEqual({
      changed: [],
      added: [],
      removed: [],
      unchanged: 0,
    })
  })
})

/**
 * A tick that no longer describes the file in front of the reviewer.
 *
 * The trap is stated on the box this implements: the head is one sha for the
 * whole pull request, so "the head moved, unmark everything" clears the tick on
 * every file the push did not touch - and looks exactly like the feature
 * working. Every case below is about one file moving while another does not.
 */
describe('staleTicks', () => {
  const prints = (entries: Record<string, string>) => new Map(Object.entries(entries))

  const head = 'headsha'
  const atHead = prints({ 'a.ts': 'one', 'b.ts': 'two-changed', 'c.ts': 'three' })
  const earlier = prints({ 'a.ts': 'one', 'b.ts': 'two', 'c.ts': 'three' })
  const at = new Map([['oldsha', earlier]])

  test('only the file that actually moved goes stale', () => {
    const result = staleTicks(
      [{ path: 'a.ts', headSha: 'oldsha' }, { path: 'b.ts', headSha: 'oldsha' }],
      head,
      atHead,
      at,
    )

    expect(result.stale).toEqual(['b.ts'])
    expect(result.unverifiable).toEqual([])
  })

  test('a tick made at the current head is fresh without asking git anything', () => {
    const result = staleTicks([{ path: 'b.ts', headSha: head }], head, atHead, new Map())

    expect(result.stale).toEqual([])
    expect(result.unverifiable).toEqual([])
  })

  /**
   * The force-push case. The sha they read is unreachable, so nothing can be
   * compared against it - and saying "unchanged" there is the interface telling
   * somebody they have read a file nobody can confirm they have.
   */
  test('a tick made at a sha that is gone is unverifiable, not fresh', () => {
    const result = staleTicks([{ path: 'a.ts', headSha: 'dropped' }], head, atHead, at)

    expect(result.stale).toEqual([])
    expect(result.unverifiable).toEqual(['a.ts'])
  })

  test('and so is a row written before the sha was recorded at all', () => {
    const result = staleTicks([{ path: 'a.ts', headSha: null }], head, atHead, at)

    expect(result.unverifiable).toEqual(['a.ts'])
  })

  test('a file the pull request no longer touches is neither', () => {
    // There is no row in the sidebar to mark and nothing left to re-read.
    const result = staleTicks([{ path: 'gone.ts', headSha: 'oldsha' }], head, atHead, at)

    expect(result.stale).toEqual([])
    expect(result.unverifiable).toEqual([])
  })

  test('a file the pull request did not touch when they ticked it is stale now', () => {
    // Ticked when it proposed nothing, and it proposes something now: they have
    // read the file, not the change.
    const result = staleTicks([{ path: 'd.ts', headSha: 'oldsha' }], head, prints({ 'd.ts': 'new' }), at)

    expect(result.stale).toEqual(['d.ts'])
  })

  test('ticks from several rounds are each judged against their own round', () => {
    const twoRounds = new Map([
      ['first', prints({ 'a.ts': 'one', 'b.ts': 'old' })],
      ['second', prints({ 'a.ts': 'one', 'b.ts': 'two-changed' })],
    ])

    const result = staleTicks(
      [{ path: 'b.ts', headSha: 'first' }, { path: 'a.ts', headSha: 'second' }],
      head,
      atHead,
      twoRounds,
    )

    // `b.ts` moved after the first round; `a.ts` has not moved since either.
    expect(result.stale).toEqual(['b.ts'])
  })

  test('nothing ticked is an empty answer rather than a special case', () => {
    expect(staleTicks([], head, atHead, at)).toEqual({ stale: [], unverifiable: [] })
  })
})

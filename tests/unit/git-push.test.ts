// What a push is, read off the three fields git gives a post-receive hook.
//
// The parsing is strict on purpose. The hook posts to a URL, and a URL can be
// posted to by anything that learns the secret - so a line that does not look
// exactly like git wrote it is dropped rather than turned into a repository
// update. Most of what is below is that: the ways a line can lie.

import { describe, expect, test } from 'bun:test'
import {
  adoptedDefaultBranch,
  branchUpdates,
  commitRange,
  movesDefaultBranch,
  parseRefUpdate,
  parseRefUpdates,
  ZERO_SHA,
} from '../../app/Actions/Git/push'

const A = 'a'.repeat(40)
const B = 'b'.repeat(40)

describe('parseRefUpdate', () => {
  test('reads an ordinary branch move', () => {
    expect(parseRefUpdate(`${A} ${B} refs/heads/main`)).toEqual({
      before: A,
      after: B,
      ref: 'refs/heads/main',
      kind: 'branch',
      change: 'updated',
      name: 'main',
    })
  })

  test('reads a creation and a deletion from the zero sha', () => {
    expect(parseRefUpdate(`${ZERO_SHA} ${B} refs/heads/new`)).toMatchObject({ change: 'created', name: 'new' })
    expect(parseRefUpdate(`${A} ${ZERO_SHA} refs/heads/old`)).toMatchObject({ change: 'deleted', name: 'old' })
  })

  test('names tags and leaves anything else alone', () => {
    expect(parseRefUpdate(`${A} ${B} refs/tags/v1.0.0`)).toMatchObject({ kind: 'tag', name: 'v1.0.0' })
    expect(parseRefUpdate(`${A} ${B} refs/notes/commits`)).toMatchObject({ kind: 'other', name: 'refs/notes/commits' })
  })

  test('keeps a branch name containing a slash whole', () => {
    expect(parseRefUpdate(`${A} ${B} refs/heads/feature/thing`)).toMatchObject({ name: 'feature/thing' })
  })

  /** Neither side being a real sha means this did not come from git. */
  test('refuses a line whose shas are not shas', () => {
    expect(parseRefUpdate(`nope ${B} refs/heads/main`)).toBeNull()
    expect(parseRefUpdate(`${A} nope refs/heads/main`)).toBeNull()
    expect(parseRefUpdate(`${A.toUpperCase()} ${B} refs/heads/main`)).toBeNull()
    expect(parseRefUpdate(`${A.slice(0, 7)} ${B} refs/heads/main`)).toBeNull()
  })

  test('refuses a line with the wrong number of fields', () => {
    expect(parseRefUpdate(`${A} ${B}`)).toBeNull()
    expect(parseRefUpdate(`${A} ${B} refs/heads/main extra`)).toBeNull()
    expect(parseRefUpdate('')).toBeNull()
  })

  /**
   * These names reach a command line. Every call site passes arguments as an
   * array rather than a shell string, so this is the second line of defence
   * rather than the first - but a name beginning with `-` is read as an option
   * whatever the call site does.
   */
  test('refuses a ref name that would be read as an option or escape its path', () => {
    expect(parseRefUpdate(`${A} ${B} --upload-pack=evil`)).toBeNull()
    expect(parseRefUpdate(`${A} ${B} refs/heads/../../etc`)).toBeNull()
    expect(parseRefUpdate(`${A} ${B} refs/heads/main@{1}`)).toBeNull()
    expect(parseRefUpdate(`${A} ${B} refs/heads/main;rm`)).toBeNull()
  })

  /** git would have sent two lines rather than one saying nothing happened. */
  test('refuses a line that is zero on both sides', () => {
    expect(parseRefUpdate(`${ZERO_SHA} ${ZERO_SHA} refs/heads/main`)).toBeNull()
  })
})

describe('parseRefUpdates', () => {
  test('reads every line and keeps git order', () => {
    const input = [
      `${A} ${B} refs/heads/main`,
      `${ZERO_SHA} ${B} refs/tags/v1.0.0`,
      '',
    ].join('\n')

    expect(parseRefUpdates(input).map(update => update.ref))
      .toEqual(['refs/heads/main', 'refs/tags/v1.0.0'])
  })

  /** One bad line does not lose the good ones around it. */
  test('drops what it cannot read and keeps the rest', () => {
    const input = [`${A} ${B} refs/heads/main`, 'garbage', `${A} ${B} refs/heads/other`].join('\n')

    expect(parseRefUpdates(input)).toHaveLength(2)
  })

  test('reads nothing out of nothing', () => {
    expect(parseRefUpdates('')).toEqual([])
    expect(parseRefUpdates('\n\n')).toEqual([])
  })
})

describe('branchUpdates', () => {
  test('keeps branches and drops tags and everything else', () => {
    const updates = parseRefUpdates([
      `${A} ${B} refs/heads/main`,
      `${A} ${B} refs/tags/v1`,
      `${A} ${B} refs/notes/commits`,
    ].join('\n'))

    expect(branchUpdates(updates).map(update => update.name)).toEqual(['main'])
  })
})

describe('commitRange', () => {
  test('an ordinary push is bounded by what was there before', () => {
    expect(commitRange(parseRefUpdate(`${A} ${B} refs/heads/main`)!)).toEqual({ from: A, to: B })
  })

  /**
   * A new branch has no `before`, and walking everything reachable from it
   * would walk the whole history on the first push of a fork. The caller
   * excludes what the other refs already reach instead.
   */
  test('a created branch has no lower bound', () => {
    expect(commitRange(parseRefUpdate(`${ZERO_SHA} ${B} refs/heads/new`)!)).toEqual({ from: null, to: B })
  })

  test('a deletion introduces no commits and has no range', () => {
    expect(commitRange(parseRefUpdate(`${A} ${ZERO_SHA} refs/heads/gone`)!)).toBeNull()
  })
})

describe('movesDefaultBranch', () => {
  const updates = parseRefUpdates(`${A} ${B} refs/heads/main`)

  test('is true when the default branch is one of the branches pushed', () => {
    expect(movesDefaultBranch(updates, 'main')).toBe(true)
  })

  test('is false for any other branch', () => {
    expect(movesDefaultBranch(updates, 'develop')).toBe(false)
  })

  test('is false when the default branch was deleted rather than moved', () => {
    expect(movesDefaultBranch(parseRefUpdates(`${A} ${ZERO_SHA} refs/heads/main`), 'main')).toBe(false)
  })
})

/**
 * The first push into an empty repository, where the row says `main` and the
 * pusher pushed `master`. Everywhere else this must not fire: a push that could
 * silently repoint what everybody sees when they open the repository is a push
 * that can hide the code.
 */
describe('adoptedDefaultBranch', () => {
  const created = parseRefUpdates(`${ZERO_SHA} ${B} refs/heads/master`)

  test('adopts the one branch pushed when the named default does not exist', () => {
    expect(adoptedDefaultBranch(created, 'main', ['master'])).toBe('master')
  })

  test('leaves it alone once the named default exists', () => {
    expect(adoptedDefaultBranch(created, 'main', ['main', 'master'])).toBeNull()
  })

  test('leaves it alone when several branches arrived, because there is no answer', () => {
    const many = parseRefUpdates([
      `${ZERO_SHA} ${B} refs/heads/master`,
      `${ZERO_SHA} ${B} refs/heads/develop`,
    ].join('\n'))

    expect(adoptedDefaultBranch(many, 'main', ['master', 'develop'])).toBeNull()
  })

  test('leaves it alone when the branch pushed is already the default', () => {
    expect(adoptedDefaultBranch(parseRefUpdates(`${ZERO_SHA} ${B} refs/heads/main`), 'main', ['main'])).toBeNull()
  })

  test('leaves it alone when nothing was created', () => {
    expect(adoptedDefaultBranch(parseRefUpdates(`${A} ${B} refs/heads/master`), 'main', ['master'])).toBeNull()
  })
})

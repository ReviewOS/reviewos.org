// Reading git's output.
//
// Split in two on purpose. The pure parsers are fed the exact byte sequences
// git emits, including the ones that only appear for a rename or for a file
// nobody would name that way on purpose. Then the same parsers are run against
// a real repository, because a hand-written sample keeps passing after git
// changes the format and a real one does not.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { blameFile, commitDetail, compareRefs } from '../../app/Actions/Browse/load'
import {
  mergeChangeStatus,
  parseAheadBehind,
  parseBlame,
  parseCommitDetail,
  parseNameStatus,
  parseNumstat,
} from '../../app/Actions/Browse/parse'

const SHA = 'a'.repeat(40)
const OTHER = 'b'.repeat(40)

describe('parseCommitDetail', () => {
  test('reads every field', () => {
    const commit = parseCommitDetail(
      [SHA, `${OTHER} ${'c'.repeat(40)}`, 'Ada', 'ada@example.com', '2026-08-05T10:00:00+01:00', 'Grace', '2026-08-05T11:00:00+01:00', 'A subject', 'A body\n\nwith paragraphs\n'].join('\0'),
    )

    expect(commit).toMatchObject({
      sha: SHA,
      parents: [OTHER, 'c'.repeat(40)],
      authorName: 'Ada',
      authorEmail: 'ada@example.com',
      subject: 'A subject',
      body: 'A body\n\nwith paragraphs',
    })
  })

  test('a root commit has no parents rather than one empty one', () => {
    expect(parseCommitDetail([SHA, '', 'Ada', 'a@e', '', 'Ada', '', 'first', ''].join('\0'))!.parents).toEqual([])
  })

  /** A commit message can contain anything, so it must not be able to add fields. */
  test('a body containing NUL cannot shift the fields before it', () => {
    const commit = parseCommitDetail([SHA, '', 'Ada', 'a@e', '', 'Ada', '', 'subject', 'body\0with a nul'].join('\0'))

    expect(commit!.subject).toBe('subject')
    expect(commit!.body).toBe('body\0with a nul')
  })

  test('refuses output that is not a commit', () => {
    expect(parseCommitDetail('')).toBeNull()
    expect(parseCommitDetail('not a sha\0\0\0')).toBeNull()
  })
})

describe('parseNumstat', () => {
  test('reads an ordinary change', () => {
    expect(parseNumstat('12\t3\tsrc/index.ts\0')).toEqual([
      { path: 'src/index.ts', from: null, status: 'modified', additions: 12, deletions: 3, binary: false },
    ])
  })

  /**
   * The shape that breaks the obvious implementation: for a rename the path
   * field is empty and the two paths follow as their own records. Reading one
   * record per NUL invents two files with no counts and loses the change.
   */
  test('reads a rename as one file with both names', () => {
    expect(parseNumstat('4\t2\t\0old/name.ts\0new/name.ts\0')).toEqual([
      { path: 'new/name.ts', from: 'old/name.ts', status: 'renamed', additions: 4, deletions: 2, binary: false },
    ])
  })

  test('a rename does not swallow the record after it', () => {
    // Written as a join because `\01` in a string literal is one octal escape,
    // not a NUL followed by a digit - which is its own small lesson.
    const files = parseNumstat(['4\t2\t', 'old.ts', 'new.ts', '1\t1\tafter.ts', ''].join('\0'))

    expect(files).toHaveLength(2)
    expect(files[1]!.path).toBe('after.ts')
  })

  test('binary is reported as binary rather than as NaN', () => {
    const [file] = parseNumstat('-\t-\tlogo.png\0')

    expect(file).toMatchObject({ path: 'logo.png', binary: true, additions: 0, deletions: 0 })
    expect(Number.isNaN(file!.additions)).toBe(false)
  })

  test('a filename containing a tab survives', () => {
    expect(parseNumstat('1\t0\tweird\tname.txt\0')[0]!.path).toBe('weird\tname.txt')
  })

  test('a filename containing a newline survives, which is the whole reason for -z', () => {
    expect(parseNumstat('1\t0\ttwo\nlines.txt\0')[0]!.path).toBe('two\nlines.txt')
  })

  test('empty output is no files', () => {
    expect(parseNumstat('')).toEqual([])
  })
})

describe('parseNameStatus', () => {
  test('reads the letters it knows', () => {
    const changes = parseNameStatus('A\0added.ts\0M\0changed.ts\0D\0gone.ts\0')

    expect(changes).toEqual([
      { path: 'added.ts', from: null, status: 'added' },
      { path: 'changed.ts', from: null, status: 'modified' },
      { path: 'gone.ts', from: null, status: 'deleted' },
    ])
  })

  test('reads a rename with its similarity score', () => {
    expect(parseNameStatus('R096\0old.ts\0new.ts\0')).toEqual([
      { path: 'new.ts', from: 'old.ts', status: 'renamed' },
    ])
  })

  test('a letter it does not know is unknown rather than dropped', () => {
    expect(parseNameStatus('X\0strange.ts\0')).toEqual([{ path: 'strange.ts', from: null, status: 'unknown' }])
  })
})

describe('mergeChangeStatus', () => {
  const files = parseNumstat('1\t0\tadded.ts\0')

  test('takes the kind from name-status and the size from numstat', () => {
    const merged = mergeChangeStatus(files, [{ path: 'added.ts', from: null, status: 'added' }])

    expect(merged[0]).toMatchObject({ path: 'added.ts', status: 'added', additions: 1 })
  })

  test('a file only name-status knows about is kept, at zero', () => {
    const merged = mergeChangeStatus(files, [
      { path: 'added.ts', from: null, status: 'added' },
      { path: 'mode-only.sh', from: null, status: 'modified' },
    ])

    expect(merged).toHaveLength(2)
    expect(merged[1]).toMatchObject({ path: 'mode-only.sh', additions: 0, deletions: 0 })
  })
})

describe('parseBlame', () => {
  /**
   * The porcelain format states a commit's details once and then refers to it
   * by sha. A parser that reads each line independently gives every line after
   * the first an empty author, which looks like a blank column rather than a
   * bug.
   */
  const PORCELAIN = [
    `${SHA} 1 1 2`,
    'author Ada',
    'author-time 1754380800',
    'author-tz +0100',
    'summary first',
    'filename a.txt',
    '\tone',
    `${SHA} 2 2`,
    '\ttwo',
    `${OTHER} 3 3 1`,
    'author Grace',
    'author-time 1754384400',
    'author-tz +0000',
    'summary second',
    'filename a.txt',
    '\tthree',
  ].join('\n')

  const lines = parseBlame(PORCELAIN)

  test('every line gets an author, not only the first of each run', () => {
    expect(lines.map(line => line.authorName)).toEqual(['Ada', 'Ada', 'Grace'])
  })

  test('keeps the file contents and the line numbers', () => {
    expect(lines.map(line => line.text)).toEqual(['one', 'two', 'three'])
    expect(lines.map(line => line.number)).toEqual([1, 2, 3])
  })

  test('marks where one commit stops and the next begins', () => {
    expect(lines.map(line => line.startsGroup)).toEqual([true, false, true])
  })

  /** The author's own offset, not the server's. */
  test('keeps the timezone the commit was made in', () => {
    expect(lines[0]!.authoredAt).toBe('2025-08-05T09:00:00+01:00')
    expect(lines[2]!.authoredAt).toBe('2025-08-05T09:00:00+00:00')
  })

  test('a line that is only a tab is an empty line, not a missing one', () => {
    const blamed = parseBlame([`${SHA} 1 1 1`, 'author Ada', 'author-time 1754380800', 'author-tz +0000', 'summary s', '\t'].join('\n'))

    expect(blamed).toHaveLength(1)
    expect(blamed[0]!.text).toBe('')
  })

  test('empty output is no lines', () => {
    expect(parseBlame('')).toEqual([])
  })
})

describe('parseAheadBehind', () => {
  test('reads left as behind and right as ahead', () => {
    expect(parseAheadBehind('3\t7\n')).toEqual({ behind: 3, ahead: 7 })
  })

  test('nonsense is zero rather than NaN', () => {
    expect(parseAheadBehind('')).toEqual({ behind: 0, ahead: 0 })
  })
})

/**
 * The same parsers, against git itself. This is what catches a format change
 * and an argument that does not mean what it was thought to mean.
 */
describe('against a real repository', () => {
  let root: string
  let bare: string
  let firstSha: string

  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'Ada',
    GIT_AUTHOR_EMAIL: 'ada@example.com',
    GIT_COMMITTER_NAME: 'Ada',
    GIT_COMMITTER_EMAIL: 'ada@example.com',
  }

  function git(cwd: string, ...args: string[]): string {
    const result = spawnSync('git', args, { cwd, env })
    if (result.status !== 0)
      throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
    return result.stdout.toString()
  }

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'reviewos-browse-'))
    bare = join(root, 'work')
    mkdirSync(bare)

    git(bare, 'init', '--initial-branch=main')
    writeFileSync(join(bare, 'a.txt'), 'one\ntwo\n')
    writeFileSync(join(bare, 'logo.bin'), Buffer.from([0, 1, 2, 3, 0]) as any)
    git(bare, 'add', '.')
    git(bare, 'commit', '-m', 'first commit\n\nWith a body.')
    firstSha = git(bare, 'rev-parse', 'HEAD').trim()

    git(bare, 'mv', 'a.txt', 'b.txt')
    writeFileSync(join(bare, 'b.txt'), 'one\ntwo\nthree\n')
    writeFileSync(join(bare, 'new.txt'), 'new\n')
    git(bare, 'add', '.')
    git(bare, 'commit', '-m', 'rename and add')

    git(bare, 'checkout', '-q', '-b', 'topic', firstSha)
    writeFileSync(join(bare, 'topic.txt'), 'topic\n')
    git(bare, 'add', '.')
    git(bare, 'commit', '-m', 'topic work')
  })

  afterAll(() => {
    rmSync(root, { recursive: true, force: true })
  })

  test('the first commit shows its files rather than nothing', async () => {
    const commit = await commitDetail(join(bare, '.git'), firstSha)

    expect(commit).not.toBeNull()
    expect(commit!.subject).toBe('first commit')
    expect(commit!.body).toBe('With a body.')
    expect(commit!.parents).toEqual([])
    expect(commit!.files.map(file => file.path).sort()).toEqual(['a.txt', 'logo.bin'])
    expect(commit!.files.every(file => file.status === 'added')).toBe(true)
  })

  test('a binary file in a real commit is reported as binary', async () => {
    const commit = await commitDetail(join(bare, '.git'), firstSha)

    expect(commit!.files.find(file => file.path === 'logo.bin')!.binary).toBe(true)
  })

  test('a real rename comes back as one file with both names', async () => {
    const commit = await commitDetail(join(bare, '.git'), 'main')
    const renamed = commit!.files.find(file => file.status === 'renamed')

    expect(renamed).toBeDefined()
    expect(renamed!.path).toBe('b.txt')
    expect(renamed!.from).toBe('a.txt')
  })

  test('an unknown revision is null rather than a throw', async () => {
    expect(await commitDetail(join(bare, '.git'), 'f'.repeat(40))).toBeNull()
  })

  test('comparing two branches diffs from where they parted', async () => {
    const comparison = await compareRefs(join(bare, '.git'), 'main', 'topic')

    expect(comparison.ok).toBe(true)
    expect(comparison.mergeBase).toBe(firstSha)
    expect(comparison.commits.map(commit => commit.subject)).toEqual(['topic work'])
    // b.txt and new.txt are on main, not on topic, so they are not this
    // comparison's business - that is the whole point of the merge base.
    expect(comparison.files.map(file => file.path)).toEqual(['topic.txt'])
    expect(comparison.ahead).toBe(1)
    expect(comparison.behind).toBe(1)
  })

  test('comparing a ref to itself is empty rather than an error', async () => {
    const comparison = await compareRefs(join(bare, '.git'), 'main', 'main')

    expect(comparison.ok).toBe(true)
    expect(comparison.files).toEqual([])
    expect(comparison.ahead).toBe(0)
  })

  test('an unknown ref is refused with a reason', async () => {
    expect(await compareRefs(join(bare, '.git'), 'main', 'nope')).toMatchObject({ ok: false, error: 'No such ref' })
  })

  test('blame names an author for every line', async () => {
    const blamed = await blameFile(join(bare, '.git'), 'main', 'b.txt')

    expect(blamed.ok).toBe(true)
    expect(blamed.lines.map(line => line.text)).toEqual(['one', 'two', 'three'])
    expect(blamed.lines.every(line => line.authorName === 'Ada')).toBe(true)
    expect(blamed.lines[0]!.sha).toBe(firstSha)
  })

  test('blaming a file that is not there is refused, not empty', async () => {
    expect(await blameFile(join(bare, '.git'), 'main', 'missing.txt')).toMatchObject({ ok: false })
  })

  /** A file shorter than the cap must not be refused by the line range. */
  test('a short file blames fully even with a large cap', async () => {
    const blamed = await blameFile(join(bare, '.git'), 'main', 'b.txt', 5000)

    expect(blamed.lines).toHaveLength(3)
    expect(blamed.truncated).toBe(false)
  })
})

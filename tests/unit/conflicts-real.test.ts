/**
 * The parser against what git actually writes.
 *
 * Every other test in `conflicts.test.ts` is written against markers typed by
 * hand, which is exactly how a parser comes to handle a shape nobody produces.
 * This one builds a real conflict with real git - two branches editing the same
 * line - and reads the blob `merge-tree` wrote into the object database, which
 * is the same path `DiffConflictsAction` takes.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { countConflicts, parseConflicts, resolveConflict } from '../../app/Actions/Pull/conflicts'

let directory = ''
let blob = ''

function git(...args: string[]): string {
  const result = spawnSync('git', args, { cwd: directory, encoding: 'utf8' })
  return result.stdout ?? ''
}

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), 'reviewos-conflict-'))

  git('init', '-q', '--initial-branch=main', '.')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'Test')

  writeFileSync(join(directory, 'a.txt'), 'one\ntwo\nthree\n')
  git('add', '.')
  git('commit', '-qm', 'base')

  git('checkout', '-qb', 'feature')
  writeFileSync(join(directory, 'a.txt'), 'one\ntwo from the branch\nthree\n')
  git('commit', '-qam', 'branch')

  git('checkout', '-q', 'main')
  writeFileSync(join(directory, 'a.txt'), 'one\ntwo from main\nthree\n')
  git('commit', '-qam', 'main')

  const tree = git('merge-tree', '--write-tree', '--name-only', 'main', 'feature').split('\n')[0]!
  blob = git('cat-file', 'blob', `${tree}:a.txt`)
})

afterAll(() => {
  if (directory)
    rmSync(directory, { recursive: true, force: true })
})

describe('a conflict git wrote itself', () => {
  test('is recognised, once', () => {
    expect(countConflicts(parseConflicts(blob))).toBe(1)
  })

  test('carries the branch names git labelled the sides with', () => {
    const [, conflict] = parseConflicts(blob)

    expect(conflict).toMatchObject({
      type: 'conflict',
      ours: { label: 'main', lines: ['two from main'] },
      theirs: { label: 'feature', lines: ['two from the branch'] },
    })
  })

  test('the unconflicted lines around it survive on both answers', () => {
    const regions = parseConflicts(blob)

    expect(resolveConflict(regions, 0, 'ours')).toBe('one\ntwo from main\nthree\n')
    expect(resolveConflict(regions, 0, 'theirs')).toBe('one\ntwo from the branch\nthree\n')
  })

  test('and resolving leaves nothing behind to resolve', () => {
    const resolved = resolveConflict(parseConflicts(blob), 0, 'both')

    expect(countConflicts(parseConflicts(resolved))).toBe(0)
  })
})

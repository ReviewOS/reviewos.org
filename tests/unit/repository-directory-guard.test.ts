// The teardown guard, and the deletion that put it there.
//
// On 2026-08-18 a test suite deleted `~/Code/Apps` - this project and every
// other project beside it - from one line of teardown:
//
//     const created = { diskPath: '' }
//     afterAll(() => rmSync(resolve(created.diskPath, '..'), { recursive: true, force: true }))
//
// Setup had failed before it assigned `diskPath`, so the field was still the
// empty string it was declared with. `resolve('', '..')` is not "nothing": it
// is the parent of the working directory. `force: true` meant it happened
// without an error, and `recursive: true` meant it took everything.
//
// So every teardown now goes through `removeRepositoryDirectory` /
// `removeRepositoryOwnerDirectory`, and these are the cases that matter. The
// first one is the exact input that caused the loss.

import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import {
  insideRepositoryStore,
  removeRepositoryDirectory,
  removeRepositoryOwnerDirectory,
  repositoryRoot,
} from '../helpers/repositoryDirectory'

describe('the path a teardown is allowed to remove', () => {
  test('refuses the empty disk path that deleted a machine\'s projects', () => {
    // `resolve('', '..')` is the parent of the working directory, which is
    // where every project on the machine lives.
    expect(resolve('', '..')).toBe(resolve(process.cwd(), '..'))

    expect(() => removeRepositoryDirectory('')).toThrow(/refusing to remove/)
    expect(() => removeRepositoryOwnerDirectory('')).toThrow(/refusing to remove/)
  })

  test('refuses anything outside the repository store', () => {
    expect(insideRepositoryStore(process.cwd())).toBe(false)
    expect(insideRepositoryStore(resolve(process.cwd(), '..'))).toBe(false)
    expect(insideRepositoryStore('/')).toBe(false)
    expect(insideRepositoryStore(tmpdir())).toBe(false)

    expect(() => removeRepositoryDirectory(process.cwd())).toThrow(/refusing to remove/)
    expect(() => removeRepositoryDirectory(tmpdir())).toThrow(/refusing to remove/)
  })

  test('refuses the store itself, whose contents belong to other tests', () => {
    expect(insideRepositoryStore(repositoryRoot())).toBe(false)
  })

  test('refuses a relative path, which resolves against whatever the cwd is', () => {
    expect(insideRepositoryStore('storage/repos/owner/name.git')).toBe(false)
  })

  test('is not fooled by a sibling whose name starts the same way', () => {
    expect(insideRepositoryStore(`${repositoryRoot()}-backup/owner/name.git`)).toBe(false)
  })

  test('allows a repository under the store, and removes exactly it', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'reviewos-guard-'))
    const owner = join(cwd, 'storage', 'repos', 'someone')
    const repository = join(owner, 'thing.git')

    mkdirSync(repository, { recursive: true })
    writeFileSync(join(repository, 'HEAD'), 'ref: refs/heads/main\n')

    expect(insideRepositoryStore(repository, cwd)).toBe(true)

    removeRepositoryDirectory(repository, cwd)
    expect(Bun.file(join(repository, 'HEAD')).size).toBe(0)

    // The owner directory goes only once it is empty - a sibling repository
    // there belongs to a test running beside this one.
    removeRepositoryOwnerDirectory(repository, cwd)

    rmSync(cwd, { recursive: true, force: true })
  })

  test('leaves an owner directory that still holds another test\'s repository', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'reviewos-guard-'))
    const owner = join(cwd, 'storage', 'repos', 'someone')
    const mine = join(owner, 'mine.git')
    const theirs = join(owner, 'theirs.git')

    mkdirSync(mine, { recursive: true })
    mkdirSync(theirs, { recursive: true })

    removeRepositoryDirectory(mine, cwd)
    removeRepositoryOwnerDirectory(mine, cwd)

    // Still there: emptying it would have taken the other suite's fixture.
    expect(Bun.file(join(theirs, '.keep')).size).toBe(0)
    expect(() => mkdirSync(theirs, { recursive: true })).not.toThrow()

    rmSync(cwd, { recursive: true, force: true })
  })
})

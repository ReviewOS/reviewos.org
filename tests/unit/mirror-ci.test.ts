// A mirror whose CI runs here.
//
// A mirror's refs move by `git fetch`, never by a push, so for as long as
// mirrors have existed nothing listening for pushes heard about them: no
// definitions, no runs, no verdict. These pin the three pure answers the
// bridge is built on - what a sync's changes are as a push, what a run's state
// is as a GitHub commit status, and what a line in `mirrors.yml` asks of a
// mirror that already exists.

import { describe, expect, test } from 'bun:test'
import { readDeclaration, settingsDrift } from '../../app/Actions/Mirror/declare'
import { updatesFromChanges } from '../../app/Actions/Mirror/workflows'
import { upstreamDescription, upstreamStateFor } from '../../app/Actions/Mirror/upstreamStatus'

const A = 'a'.repeat(40)
const B = 'b'.repeat(40)
const ZERO = '0'.repeat(40)

describe('a sync, as the push it stands for', () => {
  test('a moved branch is an updated branch, named without its prefix', () => {
    expect(updatesFromChanges([{ ref: 'refs/heads/main', before: A, after: B, kind: 'updated' }])).toEqual([
      { ref: 'refs/heads/main', kind: 'branch', name: 'main', before: A, after: B, change: 'updated' },
    ])
  })

  test('a new tag had nothing before it, and a deleted branch has nothing after', () => {
    const [tag, gone] = updatesFromChanges([
      { ref: 'refs/tags/v1.0.0', before: null, after: A, kind: 'created' },
      { ref: 'refs/heads/old', before: B, after: null, kind: 'deleted' },
    ])

    // The all-zero sha is how a push says "no commit", and the listener reads
    // `before` to diff the changed paths - a `null` there would be a crash.
    expect(tag).toMatchObject({ kind: 'tag', name: 'v1.0.0', before: ZERO, after: A, change: 'created' })
    expect(gone).toMatchObject({ kind: 'branch', name: 'old', before: B, after: ZERO, change: 'deleted' })
  })

  test('a ref that is neither is passed on as other, whole', () => {
    expect(updatesFromChanges([{ ref: 'refs/pull/7/head', before: A, after: B, kind: 'updated' }])[0])
      .toMatchObject({ kind: 'other', name: 'refs/pull/7/head' })
  })
})

describe('a run, as a commit status upstream', () => {
  test('waiting and running are pending, the ends are their own', () => {
    for (const state of ['queued', 'waiting', 'paused', 'running', 'cancelling'])
      expect(upstreamStateFor(state)).toBe('pending')

    expect(upstreamStateFor('succeeded')).toBe('success')
    expect(upstreamStateFor('failed')).toBe('failure')
  })

  test('a cancelled run is an error, not a failure the commit caused', () => {
    // Usually a newer push superseded it: a red cross there sends somebody
    // looking for a bug nobody wrote.
    expect(upstreamStateFor('cancelled')).toBe('error')
  })

  test('a state this does not know reports nothing rather than a guess', () => {
    expect(upstreamStateFor('exploded')).toBeNull()
  })

  test('says which run, in a sentence that fits GitHub\'s limit', () => {
    expect(upstreamDescription(12, 'succeeded')).toBe('Run 12 passed')
    expect(upstreamDescription(12, 'queued')).toBe('Run 12 is waiting for a runner')
    expect(upstreamDescription(123456, 'cancelling').length).toBeLessThanOrEqual(140)
  })
})

describe('a declaration, for a mirror that already exists', () => {
  const current = { runWorkflows: false, credentialRef: '', visibility: 'public' }

  test('reads the new keys', () => {
    const { mirrors } = readDeclaration(`
mirrors:
  - remote: stacksjs/hq.training
    owner: stacks
    ci: true
    credential: hq
    private: true
`)

    expect(mirrors.mirrors[0]).toMatchObject({ ci: true, credential: 'hq', private: true })
  })

  test('asks for what the line says', () => {
    expect(settingsDrift('stacks/hq.training', current, { remote: 'stacksjs/hq.training', owner: 'stacks', ci: true, credential: 'hq', private: true })).toEqual([
      'run stacks/hq.training\'s workflows here',
      'read stacks/hq.training with the hq credential',
      'make stacks/hq.training private',
    ])
  })

  test('and nothing for a key it leaves out', () => {
    // A file written before `ci:` existed must not switch CI off on every
    // mirror somebody turned it on for by hand.
    expect(settingsDrift('stacks/x', { ...current, runWorkflows: true }, { remote: 'stacksjs/x', owner: 'stacks' })).toEqual([])
  })

  test('and never towards public', () => {
    // Publishing a repository is not a decision a file applied on every
    // deploy gets to make.
    expect(settingsDrift('stacks/x', { ...current, visibility: 'private' }, { remote: 'stacksjs/x', owner: 'stacks', private: false })).toEqual([])
  })

  test('says nothing when it already matches', () => {
    expect(settingsDrift('stacks/x', { runWorkflows: true, credentialRef: 'hq', visibility: 'private' }, { remote: 'stacksjs/x', owner: 'stacks', ci: true, credential: 'hq', private: true })).toEqual([])
  })
})

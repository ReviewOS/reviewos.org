import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveDispatchRef } from '../../app/Actions/Git/dispatchRef'
import { initBare, runGit } from '../../app/Actions/Git/git'
import { authorEnvironment, createCommit } from '../../app/Actions/Git/write'

let directory = ''
let first = ''
let head = ''
const author = { name: 'Dispatch fixture', email: 'dispatch@example.test' }

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'reviewos-dispatch-ref-'))
  expect((await initBare(directory)).ok).toBe(true)
  const initial = await createCommit(directory, { branch: 'main', parentSha: null, expectedBranchSha: null, message: 'Workflow registered', author, files: { 'README.md': 'one\n' } })
  expect(initial.ok).toBe(true)
  if (!initial.ok) throw new Error(initial.error)
  first = initial.sha
  const next = await createCommit(directory, { branch: 'main', parentSha: first, message: 'Code advanced without a workflow change', author, files: { 'README.md': 'two\n' } })
  expect(next.ok).toBe(true)
  if (!next.ok) throw new Error(next.error)
  head = next.sha
  for (const ref of ['refs/tags/fragile', 'refs/tags/release', 'refs/tags/same', 'refs/heads/same', 'refs/tags/refs/heads/missing-branch'])
    expect((await runGit(directory, ['update-ref', ref, first])).ok).toBe(true)
  expect((await runGit(directory, ['tag', '-a', 'annotated', first, '-m', 'Annotated fixture'], { env: authorEnvironment(author) })).ok).toBe(true)
  writeFileSync(join(directory, 'refs/heads/fragile'), `${'f'.repeat(40)}\n`)
})

afterAll(() => { if (directory) rmSync(directory, { recursive: true, force: true }) })

describe('the commit requested by manual workflow dispatch', () => {
  test('uses the current named branch commit after code advances', async () => {
    expect(await resolveDispatchRef(directory, 'refs/heads/main')).toEqual({ ok: true, ref: 'refs/heads/main', sha: head })
    expect(head).not.toBe(first)
  })
  test('canonicalizes a short branch and a named tag', async () => {
    expect(await resolveDispatchRef(directory, 'main')).toEqual({ ok: true, ref: 'refs/heads/main', sha: head })
    expect(await resolveDispatchRef(directory, 'release')).toEqual({ ok: true, ref: 'refs/tags/release', sha: first })
  })
  test('requires an explicit namespace when branch and tag names collide', async () => {
    expect(await resolveDispatchRef(directory, 'same')).toMatchObject({ ok: false, status: 422 })
    expect(await resolveDispatchRef(directory, 'refs/tags/same')).toEqual({ ok: true, ref: 'refs/tags/same', sha: first })
  })
  test('never substitutes a stored workflow revision for a missing named ref', async () => {
    expect(await resolveDispatchRef(directory, 'missing')).toMatchObject({ ok: false, status: 404 })
    expect(await resolveDispatchRef(directory, first)).toMatchObject({ ok: false, status: 404 })
  })
  test('does not let a nested tag impersonate an explicitly requested missing branch', async () => {
    expect(await resolveDispatchRef(directory, 'refs/heads/missing-branch')).toMatchObject({ ok: false, status: 404 })
  })
  test('peels annotated tags to their commit', async () => {
    expect(await resolveDispatchRef(directory, 'annotated')).toEqual({ ok: true, ref: 'refs/tags/annotated', sha: first })
  })
  test('never falls through a broken branch to a same-named valid tag', async () => {
    expect(await resolveDispatchRef(directory, 'fragile')).toMatchObject({ ok: false, status: 503 })
  })
  test('reports a repository read failure without calling it a missing branch', async () => {
    expect(await resolveDispatchRef(join(directory, 'objects'), 'main')).toMatchObject({ ok: false, status: 503 })
  })
  test.each(['--all', '../main', 'main~1', 'HEAD^', 'refs/pull/1/head', 'refs/heads/'])('rejects options and revision expressions %s', async (ref) => {
    expect(await resolveDispatchRef(directory, ref)).toMatchObject({ ok: false, status: 422 })
  })
})

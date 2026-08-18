// The bounds on `runGit`.
//
// Before these existed the only bound on stdout was the timeout, and a fast
// git fills memory long before a slow one hits thirty seconds. The properties
// worth testing are the ones a small fixture hides: that the kill happens at
// the budget rather than after the allocation, and that utf8 text survives
// chunk boundaries intact.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initBare, runGit } from '../../app/Actions/Git/git'

let root: string
let bare: string

/** Write a blob straight into the object store, and hand back its sha. */
async function writeBlob(content: string): Promise<string> {
  const result = await runGit(bare, ['hash-object', '-w', '--stdin'], { input: content })

  if (!result.ok)
    throw new Error(`hash-object failed: ${result.stderr}`)

  return result.stdout.trim()
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'reviewos-rungit-bounds-'))
  bare = join(root, 'repo.git')
  await initBare(bare)
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('maxBytes', () => {
  test('a blob past the budget resolves promptly, truncated, within the budget', async () => {
    // 1 MiB of blob against a 64 KiB budget: sixteen times over, so a
    // read-it-all-then-slice implementation would be visible in the size.
    const sha = await writeBlob('x'.repeat(1024 * 1024))

    const started = Date.now()
    const result = await runGit(bare, ['cat-file', 'blob', sha], { maxBytes: 64 * 1024 })

    expect(result.ok).toBe(true)
    expect(result.truncated).toBe(true)
    expect(result.stdout.length).toBeLessThanOrEqual(64 * 1024)
    expect(result.stdout.length).toBeGreaterThan(0)

    // Promptly: the child was killed at the boundary, not run to completion
    // or to the 30 second timeout.
    expect(Date.now() - started).toBeLessThan(5_000)
  })

  test('output within the budget is complete and not marked truncated', async () => {
    const sha = await writeBlob('hello world\n')
    const result = await runGit(bare, ['cat-file', 'blob', sha], { maxBytes: 64 * 1024 })

    expect(result.ok).toBe(true)
    expect(result.truncated).not.toBe(true)
    expect(result.stdout).toBe('hello world\n')
  })

  test('a truncated cut lands on a whole character, never inside one', async () => {
    // Every character is three bytes, and the budget is not a multiple of
    // three, so the cut necessarily falls mid-character and has to back up.
    const sha = await writeBlob('あ'.repeat(10_000))
    const result = await runGit(bare, ['cat-file', 'blob', sha], { maxBytes: 1000 })

    expect(result.truncated).toBe(true)
    expect(result.stdout).not.toContain('�')
    expect([...result.stdout].every(character => character === 'あ')).toBe(true)
  })
})

describe('utf8 chunk boundaries', () => {
  test('tens of thousands of multibyte characters round-trip intact', async () => {
    /*
     * 50,000 three-byte characters is 150KB - past the 64KB pipe chunk size,
     * so at least one character necessarily spans a chunk boundary. Coercing
     * chunks to strings independently - what `runGit` did before setting
     * utf8 - turns that character into replacement characters.
     */
    const text = 'こんにちは世界'.repeat(10_000)
    const sha = await writeBlob(text)
    const result = await runGit(bare, ['cat-file', 'blob', sha])

    expect(result.ok).toBe(true)
    expect(result.truncated).not.toBe(true)
    expect(result.stdout).not.toContain('�')
    expect(result.stdout).toBe(text)
  })
})

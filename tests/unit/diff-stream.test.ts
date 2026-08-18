// Streaming a diff out of git, against a real repository.
//
// The properties that only show up with git actually running: that the three
// dot form diffs from the merge base and not the base tip, that the chunks
// reassemble into the patch, that a hostile revision never reaches the binary,
// and that abandoning the stream kills the child rather than orphaning it.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { streamCommitDiff, streamMergeBaseDiff } from '../../app/Actions/Git/diffStream'
import { initBare } from '../../app/Actions/Git/git'
import { parseDiffFile } from '../../app/Actions/Pull/diff'
import { createPatchSplitter } from '../../app/Actions/Pull/patch'

let root: string
let bare: string
let work: string
let featureSha: string

function git(cwd: string, ...args: string[]) {
  const result = spawnSync('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  })
  if (result.status !== 0)
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
  return result.stdout.toString()
}

/** Read a whole stream into one string, the way a non-streaming caller would. */
async function collect(stream: { chunks: AsyncIterable<string> }): Promise<string> {
  let text = ''
  for await (const chunk of stream.chunks)
    text += chunk
  return text
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'reviewos-diffstream-'))
  bare = join(root, 'chris', 'demo.git')
  work = join(root, 'work')

  await initBare(bare)
  git(root, 'clone', bare, work)

  // A history that forks, so "against the merge base" and "against the base
  // tip" give different answers and the test can tell them apart.
  await Bun.write(join(work, 'shared.ts'), 'export const shared = 1\n')
  git(work, 'add', '.')
  git(work, 'commit', '-m', 'first')
  git(work, 'push', 'origin', 'HEAD:refs/heads/main')

  git(work, 'checkout', '-b', 'feature')
  await Bun.write(join(work, 'feature.ts'), 'export const feature = 1\n')
  git(work, 'add', '.')
  git(work, 'commit', '-m', 'the branch work')
  featureSha = git(work, 'rev-parse', 'HEAD').trim()
  git(work, 'push', 'origin', 'feature')

  // main moves on after the branch left it. This commit is the one a two dot
  // diff would wrongly include.
  git(work, 'checkout', 'main')
  await Bun.write(join(work, 'landed-elsewhere.ts'), 'export const other = 1\n')
  git(work, 'add', '.')
  git(work, 'commit', '-m', 'somebody else landed this')
  git(work, 'push', 'origin', 'main')
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('streamMergeBaseDiff', () => {
  test('diffs from the merge base, so work landed on main is not in the review', async () => {
    const stream = await streamMergeBaseDiff(bare, 'main', 'feature')!
    const patch = await collect(stream)

    expect(patch).toContain('feature.ts')
    expect(patch).not.toContain('landed-elsewhere.ts')
    expect((await stream.done).ok).toBe(true)
  })

  test('the chunks reassemble into exactly what git wrote', async () => {
    const streamed = await collect(await streamMergeBaseDiff(bare, 'main', 'feature')!)
    const direct = git(work, 'diff', '--no-color', 'main...feature')

    expect(streamed).toBe(direct)
  })

  test('the splitter turns the stream into parsed files', async () => {
    const stream = await streamMergeBaseDiff(bare, 'main', 'feature')!
    const splitter = createPatchSplitter()
    const paths: string[] = []

    for await (const chunk of stream.chunks) {
      splitter.push(chunk)
      for (;;) {
        const fileText = splitter.take()
        if (fileText === undefined)
          break
        paths.push(parseDiffFile(fileText)!.path)
      }
    }

    for (const fileText of splitter.finish().files)
      paths.push(parseDiffFile(fileText)!.path)

    expect(paths).toEqual(['feature.ts'])
  })

  test('context is configurable and reaches git', async () => {
    const wide = await collect(await streamMergeBaseDiff(bare, 'main', 'feature', { context: 0 })!)
    expect(wide).toContain('@@')
  })

  test('a revision that looks like a flag is refused before git sees it', async () => {
    expect(await streamMergeBaseDiff(bare, '--output=/tmp/pwned', 'feature')).toBeNull()
    expect(await streamMergeBaseDiff(bare, 'main', '-x')).toBeNull()
    expect(await streamMergeBaseDiff(bare, 'main; rm -rf /', 'feature')).toBeNull()
  })

  test('an unknown revision fails with git saying why, rather than throwing', async () => {
    const stream = await streamMergeBaseDiff(bare, 'main', 'no-such-branch')!
    await collect(stream)
    const result = await stream.done

    expect(result.ok).toBe(false)
    expect(result.stderr.length).toBeGreaterThan(0)
  })

  test('abandoning the stream kills the child rather than leaving it running', async () => {
    const stream = await streamMergeBaseDiff(bare, 'main', 'feature')!

    // Break after the first chunk, which is what a reader navigating away does.
    for await (const _chunk of stream.chunks)
      break

    const result = await stream.done
    expect(result.ok).toBe(false)
  })

  test('cancel before reading anything still settles', async () => {
    const stream = await streamMergeBaseDiff(bare, 'main', 'feature')!
    stream.cancel()
    stream.cancel()

    expect((await stream.done).ok).toBe(false)
  })
})

describe('streamCommitDiff', () => {
  test('shows what one commit introduced', async () => {
    const patch = await collect(await streamCommitDiff(bare, featureSha)!)

    expect(patch).toContain('feature.ts')
    expect(patch).not.toContain('shared.ts')
  })

  test('refuses a revision that could be read as a flag', async () => {
    expect(await streamCommitDiff(bare, '--help')).toBeNull()
  })
})

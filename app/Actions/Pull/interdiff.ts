/**
 * The line-level interdiff: what changed between two versions of a proposal.
 *
 * Since-last-look names the files whose patch moved; this is the next step
 * for one such file - not the file's whole diff again, but the diff of the
 * two patches, so a reviewer who read four hundred lines on Monday reads the
 * six that moved since.
 *
 * `git range-diff` is not the tool, though it looks like one: it pairs
 * commits, calls a commit `=` unchanged even when its hunks moved -
 * contradicting `patchSignature`'s documented rule that hunk movement is a
 * thing to re-read - and answers per commit rather than per file. What is
 * diffed instead is the two three-dot patch texts themselves, each head
 * against its own merge base - the same comparison the fingerprints make, so
 * "changed" here and "changed" in the file list are one definition.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gitEnvironment } from '../Git/git'
import { streamMergeBaseDiff } from '../Git/diffStream'

/**
 * A patch as it counts for comparison: `index ` lines dropped, exactly as
 * `patchSignature` drops them, because blob-sha abbreviations drift with
 * repository size and two identical proposals would otherwise differ.
 */
export function normalizePatchText(fileText: string): string {
  return fileText
    .split('\n')
    .filter(line => !line.startsWith('index '))
    .join('\n')
}

/** One file's three-dot patch at one head, buffered. */
async function patchAt(diskPath: string, base: string, head: string, path: string): Promise<string | null> {
  const stream = await streamMergeBaseDiff(diskPath, base, head, { paths: [path] })
  if (!stream)
    return null

  let text = ''
  for await (const chunk of stream.chunks)
    text += chunk

  const outcome = await stream.done
  return outcome.ok ? text : null
}

export type Interdiff =
  | { ok: true, unchanged: false, patch: string }
  | { ok: true, unchanged: true }
  | { ok: false, error: string }

/**
 * The diff of the two patches, as unified diff text.
 *
 * `git diff --no-index` over two temp files, because git's own diff of the
 * texts is the rendering every reviewer already reads - outer +/- for what
 * the round changed, the inner patch's own markers riding as content. Its
 * exit code speaks a different dialect: 1 means "different", which is the
 * answer, not an error.
 */
export async function interdiffFor(options: {
  diskPath: string
  base: string
  path: string
  lastSeen: string
  head: string
}): Promise<Interdiff> {
  const { diskPath, base, path, lastSeen, head } = options

  const [before, after] = await Promise.all([
    patchAt(diskPath, base, lastSeen, path),
    patchAt(diskPath, base, head, path),
  ])

  if (before === null || after === null)
    return { ok: false, error: 'One of the two versions could not be diffed' }

  const beforeText = normalizePatchText(before)
  const afterText = normalizePatchText(after)

  if (beforeText === afterText)
    return { ok: true, unchanged: true }

  const scratch = await mkdtemp(join(tmpdir(), 'reviewos-interdiff-'))

  try {
    await Promise.all([
      writeFile(join(scratch, 'before.patch'), beforeText),
      writeFile(join(scratch, 'after.patch'), afterText),
    ])

    // A bespoke spawn rather than runGit: --no-index exits 1 on difference,
    // and runGit reads any non-zero as failure.
    const child = Bun.spawn([
      'git',
      'diff',
      '--no-index',
      '--no-color',
      '--unified=3',
      '--',
      join(scratch, 'before.patch'),
      join(scratch, 'after.patch'),
    ], {
      stdout: 'pipe',
      stderr: 'pipe',
      env: gitEnvironment(),
    })

    const [stdout, code] = await Promise.all([
      new Response(child.stdout).text(),
      child.exited,
    ])

    if (code !== 0 && code !== 1)
      return { ok: false, error: 'The two versions could not be compared' }

    return { ok: true, unchanged: false, patch: stdout }
  }
  finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => {})
  }
}

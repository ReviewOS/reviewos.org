/**
 * Building one repository's shard, and knowing when it has gone stale.
 *
 * The impure half: this is the part that runs git. What it produces is the
 * candidate filter described in `trigram.ts` - never the answer itself, which
 * still comes from `git grep` against the tree at the ref.
 *
 * ## Two processes, not two per file
 *
 * `git ls-tree -r -l` names every blob and its size in one process, and
 * `git cat-file --batch` streams every blob's contents through a second. The
 * obvious implementation - `git show` per file - is one process per file, which
 * on a repository with forty thousand files is forty thousand processes and the
 * mistake `MeasureLanguagesJob` already avoids in this codebase.
 *
 * ## What is deliberately not indexed
 *
 * Binaries, minified bundles and anything over the byte ceiling. A bundle is
 * one line holding nearly every trigram, so it is offered as a candidate for
 * every query and grepped every time - it makes the index slower *and* worse.
 * The count of skipped files is kept on the shard so a reader sees the gap
 * rather than wondering about it.
 */

import { mkdir, readdir, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { runGit, spawnGitLimited } from '../Git/git'
import {
  addDocument,
  candidatesFromText,
  decodeShard,
  decodeSummary,
  emptyShard,
  encodeShard,
  type Shard,
  SUMMARY_BITS,
} from './trigram'

/** Files larger than this are skipped: see the note above about bundles. */
export const MAX_INDEXED_BYTES = 512 * 1024

/** And a whole-shard ceiling, so one enormous repository cannot fill the disk. */
export const MAX_SHARD_BYTES = 64 * 1024 * 1024

/** Where shards live. One file per repository, named by id. */
export function shardDirectory(): string {
  return join(process.cwd(), 'storage', 'search')
}

export function shardPath(repositoryId: number): string {
  return join(shardDirectory(), `${repositoryId}.idx`)
}

/** A blob, as `ls-tree -l` reports it. */
interface Entry {
  sha: string
  size: number
  path: string
}

/** Every blob at a ref, with its size, in one process. */
export async function entriesAt(diskPath: string, ref: string): Promise<Entry[]> {
  const result = await runGit(diskPath, ['ls-tree', '-r', '-l', '-z', ref], {
    timeoutMs: 60_000,
    maxBytes: 128 * 1024 * 1024,
    priority: 'background',
  })

  if (!result.ok)
    return []

  const entries: Entry[] = []

  // `-z` because a path may contain a newline, and a format that splits on one
  // silently loses those files - which is a search that cannot find them.
  for (const record of result.stdout.split('\0')) {
    if (!record)
      continue

    const match = /^\d+ blob ([0-9a-f]+)\s+(\S+)\t(.*)$/s.exec(record)

    if (!match)
      continue

    entries.push({ sha: match[1]!, size: Number(match[2]) || 0, path: match[3]! })
  }

  return entries
}

/** Whether these bytes look like something worth indexing. */
export function isIndexable(size: number, sample: string): boolean {
  if (size <= 0 || size > MAX_INDEXED_BYTES)
    return false

  // A NUL early on is what git itself calls binary, and matching git's own
  // judgement keeps the index and the grep agreeing.
  if (sample.includes('\0'))
    return false

  // A single line longer than this is a bundle or a data blob rather than
  // something a person reads, whatever its extension claims.
  const longest = sample.split('\n').reduce((most, line) => Math.max(most, line.length), 0)

  return longest <= 2000
}

/**
 * Build a shard for one repository at a ref.
 *
 * Contents come through one `cat-file --batch`, which answers each request with
 * a header line and then exactly that many *bytes* - so the parsing is by
 * length, on bytes, rather than by looking for a delimiter that can appear in
 * the data.
 */
export async function buildShard(diskPath: string, ref: string): Promise<Shard | null> {
  const head = await runGit(diskPath, ['rev-parse', ref], { timeoutMs: 10_000 })

  if (!head.ok)
    return null

  const commit = head.stdout.trim()
  const entries = await entriesAt(diskPath, ref)
  const shard = emptyShard(ref, commit)

  const wanted = entries.filter(entry => entry.size > 0 && entry.size <= MAX_INDEXED_BYTES)
  shard.skipped = entries.length - wanted.length

  if (wanted.length === 0)
    return shard

  /*
   * Read as bytes, not as a string.
   *
   * The first version sliced a JS string by the header's byte counts. A string
   * index is a UTF-16 code unit, so the first file containing a non-ASCII
   * character - an arrow in a comment, an accented name, an emoji in a test -
   * shifted the cursor and every object after it parsed from the wrong offset.
   * It indexed 33 files of 3,949 and reported success, which is exactly the
   * shape of bug this index must not have: a search that quietly cannot find
   * things.
   */
  const child = await spawnGitLimited('background', diskPath, ['cat-file', '--batch'])

  if (!child)
    return shard

  child.stdin.write(`${wanted.map(entry => entry.sha).join('\n')}\n`)
  child.stdin.end()

  const chunks: Uint8Array[] = []
  let total = 0

  for await (const chunk of child.stdout as AsyncIterable<Uint8Array>) {
    chunks.push(chunk)
    total += chunk.byteLength

    // The ceiling is on the repository, not on one object: a tree big enough to
    // pass it is one where the index costs more than it saves, and a partial
    // index is still a correct filter over the files it did read.
    if (total > MAX_SHARD_BYTES)
      break
  }

  await new Promise<void>((resolve) => {
    // node:child_process, not Bun.spawn: `spawnGit` is the streaming seam the
    // wire protocol uses, and it hands back a Node child.
    child.once('close', () => resolve())
    child.once('error', () => resolve())
  })

  const output = new Uint8Array(total)
  let filled = 0

  for (const chunk of chunks) {
    output.set(chunk.subarray(0, Math.min(chunk.byteLength, total - filled)), filled)
    filled += chunk.byteLength

    if (filled >= total)
      break
  }

  const decoder = new TextDecoder()
  let cursor = 0
  let index = 0

  while (cursor < output.length && index < wanted.length) {
    const newline = output.indexOf(0x0A, cursor)

    if (newline === -1)
      break

    const header = decoder.decode(output.subarray(cursor, newline))
    const size = Number(header.split(' ')[2] ?? 0)

    cursor = newline + 1

    if (!Number.isInteger(size) || size < 0)
      break

    const body = output.subarray(cursor, cursor + size)
    // The batch writes the object, a newline, then the next header.
    cursor += size + 1

    const entry = wanted[index]!
    index += 1

    // A NUL anywhere in the bytes is what git calls binary. Checked on the
    // bytes rather than after a decode that would have replaced it.
    if (body.includes(0)) {
      shard.skipped += 1
      continue
    }

    const contents = decoder.decode(body)

    if (isIndexable(entry.size, contents.slice(0, 8000)))
      addDocument(shard, entry.path, contents)
    else
      shard.skipped += 1
  }

  return shard
}

/** Write a shard, atomically, so a reader never sees half of one. */
export async function writeShard(repositoryId: number, shard: Shard): Promise<void> {
  await mkdir(shardDirectory(), { recursive: true })

  const target = shardPath(repositoryId)
  const temporary = `${target}.${process.pid}.tmp`

  await Bun.write(temporary, encodeShard(shard))

  // Rename rather than write in place: a search running while an index is
  // rebuilt reads the old shard whole or the new one whole, never a prefix of
  // the new one - which would decode as a shard with no postings and answer
  // "nothing found".
  await rename(temporary, target)
}

/**
 * The head of a shard: the commit it was built from and its trigram bitmap.
 *
 * A prefix read rather than a full one. This is the call an instance-wide
 * search makes for *every* repository, and the whole point is that it costs a
 * few tens of kilobytes rather than the megabytes a shard runs to.
 */
export async function readSummary(repositoryId: number): Promise<{ ref: string, commit: string, bitmap: Uint8Array } | null> {
  try {
    const file = Bun.file(shardPath(repositoryId))

    if (!(await file.exists()))
      return null

    // The header lines and the base64 bitmap, generously: a short read decodes
    // to nothing and sends the search down the slow path rather than giving a
    // wrong answer.
    return decodeSummary(await file.slice(0, (SUMMARY_BITS / 8) * 2 + 4096).text())
  }
  catch {
    return null
  }
}

/**
 * The candidate paths for a query, without decoding the whole shard.
 *
 * The read path an instance-wide search uses. `readShard` remains for the tools
 * that want the structure - rebuilding, inspecting, testing.
 */
export async function candidatesFor(repositoryId: number, grams: Set<string>): Promise<string[] | null> {
  try {
    const file = Bun.file(shardPath(repositoryId))

    if (!(await file.exists()))
      return null

    return candidatesFromText(await file.text(), grams)
  }
  catch {
    return null
  }
}

/** Read one whole, or null when there is not one or the format is unknown. */
export async function readShard(repositoryId: number): Promise<Shard | null> {
  try {
    const file = Bun.file(shardPath(repositoryId))

    if (!(await file.exists()))
      return null

    return decodeShard(await file.text())
  }
  catch {
    return null
  }
}

/** Forget one, for a repository that has been deleted. */
export async function removeShard(repositoryId: number): Promise<void> {
  await rm(shardPath(repositoryId), { force: true }).catch(() => undefined)
}

/** Which repositories currently have a shard, by id. */
export async function indexedRepositories(): Promise<number[]> {
  try {
    const names = await readdir(shardDirectory())

    return names
      .filter(name => name.endsWith('.idx'))
      .map(name => Number(name.slice(0, -4)))
      .filter(id => Number.isInteger(id) && id > 0)
      .sort((left, right) => left - right)
  }
  catch {
    return []
  }
}

/**
 * The paths that changed since the shard was built.
 *
 * This is how staleness is handled honestly rather than pretended away. The
 * shard knows the commit it was built from; if the ref has moved, every path
 * touched between the two joins the candidate set whatever the index says. So a
 * file written after the last build is findable without a rebuild, and the
 * index can be out of date but not wrong.
 *
 * `*` is returned when the old commit is gone - a force-push, or history
 * rewritten - because then the shard cannot be shown to be a subset of the
 * truth and the caller must search in full.
 */
export async function changedSince(diskPath: string, from: string, to: string): Promise<string[]> {
  if (!from || from === to)
    return []

  const result = await runGit(diskPath, ['diff', '--name-only', '-z', `${from}..${to}`], {
    timeoutMs: 20_000,
    maxBytes: 8 * 1024 * 1024,
  })

  if (!result.ok)
    return ['*']

  return result.stdout.split('\0').filter(Boolean)
}

import { describe, expect, it } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

/**
 * Nothing is awaited between spawning a diff and reading it.
 *
 * `git diff` starts writing the moment it is spawned, and the child's stdout
 * does not hold output that nobody has asked for yet. So every `await` between
 * the spawn and the first read is a window in which git can produce the whole
 * diff, exit, and have all of it dropped.
 *
 * That is not theoretical and it is not rare. `DiffManifestAction` spawned the
 * diff at the top and then awaited the review threads, the coverage and the
 * repository's language rules before reading a byte. A diff small enough to
 * finish inside that window - four hundred bytes, one file, which is most pull
 * requests - arrived as nothing. Measured on the box: a 50ms delay before the
 * first read was enough to turn 406 bytes into 0.
 *
 * The failure is silent in both directions. git exits 0, so `done.ok` is true
 * and no error is reported; and the manifest of an empty diff is a valid
 * manifest, so the endpoint answers 200 with `{"files":0}`. The review screen
 * renders that as a pull request that changes nothing.
 *
 * So: spawn it last. This reads the source rather than the behaviour, because
 * the behaviour only shows up when git wins a race.
 */

const ACTIONS = resolve(import.meta.dir, '../../app/Actions/Pull')

const SPAWNS = /await\s+stream(?:MergeBaseDiff|CommitRangeDiff|CommitDiff)\s*\(/

/** Where the diff is first read: iterated, or handed to the manifest builder. */
const READS = /for\s+await\s*\([^)]*\bdiff\.chunks|streamManifest\s*\(\s*diff\b/

function awaitsBetweenSpawnAndRead(source: string): string[] {
  const lines = source.split('\n')
  const spawnAt = lines.findIndex(line => SPAWNS.test(line))

  if (spawnAt === -1)
    return []

  const readAt = lines.findIndex((line, i) => i > spawnAt && READS.test(line))

  if (readAt === -1)
    return []

  const between: string[] = []

  for (let i = spawnAt + 1; i < readAt; i++) {
    const line = lines[i]!

    // `if (!diff) return …` is the null check, and awaits nothing.
    if (/\bawait\b/.test(line) && !/^\s*(\*|\/\/)/.test(line))
      between.push(`line ${i + 1}: ${line.trim().slice(0, 80)}`)
  }

  return between
}

describe('the diff endpoints', () => {
  it('spawn git immediately before reading it, never before an await', () => {
    const offenders: string[] = []

    for (const entry of readdirSync(ACTIONS)) {
      if (!entry.endsWith('.ts'))
        continue

      const source = readFileSync(join(ACTIONS, entry), 'utf8')

      for (const found of awaitsBetweenSpawnAndRead(source))
        offenders.push(`${entry} ${found}`)
    }

    expect(offenders).toEqual([])
  })
})

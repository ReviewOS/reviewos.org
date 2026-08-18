// What `artifact-paths:` actually collects.
//
// The parser's rules are unit-tested beside the other step attributes; this is
// the half that touches a filesystem, and the cases worth pinning are the ones
// where a naive glob does the wrong thing: a pattern matching a directory, a
// symlink pointing out of the checkout, and a build that wrote nothing.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { collectArtifacts, MAX_COLLECTED_FILES } from '../../app/Actions/Runner/localExecutor'

let workspace = ''
let outside = ''

beforeAll(() => {
  workspace = mkdtempSync(join(tmpdir(), 'reviewos-collect-'))
  outside = mkdtempSync(join(tmpdir(), 'reviewos-outside-'))

  mkdirSync(join(workspace, 'coverage'), { recursive: true })
  mkdirSync(join(workspace, 'screenshots'), { recursive: true })
  writeFileSync(join(workspace, 'coverage', 'lcov.info'), 'TN:\n')
  writeFileSync(join(workspace, 'coverage', 'index.html'), '<html></html>')
  writeFileSync(join(workspace, 'screenshots', 'failure.png'), 'not really a png')
  writeFileSync(join(outside, 'secret.txt'), 'the machine\'s business')

  try {
    symlinkSync(join(outside, 'secret.txt'), join(workspace, 'screenshots', 'escape.png'))
  }
  catch { /* a filesystem without symlinks skips that assertion */ }
})

afterAll(() => {
  rmSync(workspace, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
})

describe('collecting what a job left behind', () => {
  test('matches files and leaves the directories alone', async () => {
    const found = await collectArtifacts(workspace, ['coverage/**'])

    // `coverage/**` matches the directory as well as its contents, and a
    // directory is not a file anybody can download.
    expect(found).toEqual(['coverage/index.html', 'coverage/lcov.info'])
  })

  test('is sorted, so two runs of one job produce the same list', async () => {
    const found = await collectArtifacts(workspace, ['screenshots/*.png', 'coverage/*.info'])

    expect(found).toEqual([...found].sort())
    expect(found).toContain('coverage/lcov.info')
  })

  test('nothing it collects is outside the workspace', async () => {
    /*
     * Two ways out, both closed. A symlink the *build* created can point
     * anywhere, and the scan does not follow one; a pattern that climbs out
     * with `..` is refused by the parser and, if one ever reached here, by the
     * check on each match - `../*` genuinely does escape the scan directory,
     * which is why the second check is not decoration.
     */
    const found = await collectArtifacts(workspace, ['screenshots/*.png'])

    expect(found).toContain('screenshots/failure.png')
    expect(found).not.toContain('screenshots/escape.png')

    expect(await collectArtifacts(workspace, ['../*'])).toEqual([])
  })

  test('a glob that matched nothing collects nothing rather than failing', async () => {
    // Usually a typo, or a build that wrote somewhere else. Either way the job
    // has already run, and refusing to finish it over a pattern would throw
    // away the result somebody was waiting for.
    expect(await collectArtifacts(workspace, ['dist/**'])).toEqual([])
    expect(await collectArtifacts(workspace, ['['])).toEqual([])
  })

  test('and the same file named by two globs is uploaded once', async () => {
    const found = await collectArtifacts(workspace, ['coverage/**', 'coverage/lcov.info'])

    expect(found.filter(one => one === 'coverage/lcov.info').length).toBe(1)
  })

  test('the ceiling is a number, not a promise', async () => {
    // A job that writes ten thousand files should publish some of them and stop,
    // rather than turning one build into ten thousand uploads.
    expect(MAX_COLLECTED_FILES).toBeGreaterThan(0)
    expect((await collectArtifacts(workspace, ['**'])).length).toBeLessThanOrEqual(MAX_COLLECTED_FILES)
  })
})

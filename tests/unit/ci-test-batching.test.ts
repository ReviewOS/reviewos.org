// Running the suite in batches, until a Stacks release carries the framework fix.
//
// The reason is in `.github/scripts/test-batched.ts`: one process holding 589
// isolated files ends 142 MiB from the end of a 16 GB machine, on a run that
// passes. These pin the batching, and the two behaviours that must not change
// while it is in place - every file runs, and every failure is reported.

import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { batchFiles, intoBatches, testFiles } from '../../.github/scripts/test-batched'

describe('how many files a process takes', () => {
  test('a hundred by default, which is about 2 GB of retained isolation', () => {
    expect(batchFiles({})).toBe(100)
    expect(batchFiles({ BUDDY_TEST_BATCH_FILES: '  ' })).toBe(100)
  })

  test('or whatever the environment asks for', () => {
    expect(batchFiles({ BUDDY_TEST_BATCH_FILES: '40' })).toBe(40)
  })

  test('and off means one process, which is how you reproduce the old behaviour', () => {
    expect(batchFiles({ BUDDY_TEST_BATCH_FILES: 'off' })).toBeNull()
    expect(batchFiles({ BUDDY_TEST_BATCH_FILES: '0' })).toBeNull()
  })

  test('a value that is not a count is refused rather than rounded', () => {
    for (const named of ['-1', '2.5', 'many', '100 files'])
      expect(() => batchFiles({ BUDDY_TEST_BATCH_FILES: named })).toThrow('whole number of files')
  })

  test('and it is the same variable the framework reads, so nothing changes when this goes', () => {
    // `storage/framework/core/actions/src/test/runner.ts` reads this name too.
    // Deleting the bridge must not require anything that sets it to be edited.
    expect(batchFiles({ BUDDY_TEST_BATCH_FILES: '7' })).toBe(7)
  })
})

describe('splitting the suite up', () => {
  test('keeps the order it was given, because the suite order is the suite order', () => {
    expect(intoBatches(['a', 'b', 'c', 'd', 'e'], 2)).toEqual([['a', 'b'], ['c', 'd'], ['e']])
  })

  test('divides evenly without leaving an empty batch behind', () => {
    expect(intoBatches(['a', 'b', 'c', 'd'], 2)).toEqual([['a', 'b'], ['c', 'd']])
  })

  test('and asks for one process when the batch is bigger than the suite', () => {
    expect(intoBatches(['a'], 100)).toEqual([['a']])
    expect(intoBatches([], 100)).toEqual([])
  })
})

describe('the files it will run', () => {
  const files = testFiles()

  test('is the whole suite, not a sample of it', () => {
    // If this script finds fewer files than the suite has, CI goes green
    // having run less of it, which is the one failure worse than an OOM.
    expect(files.length).toBeGreaterThan(500)
    expect(files.length).toBe(new Set(files).size)
  })

  test('named the way bunfig root = "tests" needs them', () => {
    // A bare project-relative path matches nothing under that root.
    for (const file of files)
      expect(file.startsWith('./tests/')).toBe(true)
  })

  test('and every one of them exists on disk', () => {
    for (const file of files)
      expect(existsSync(file)).toBe(true)
  })

  test('including this file, and the suites on both sides of the tree', () => {
    expect(files).toContain('./tests/unit/ci-test-batching.test.ts')
    expect(files.some(file => file.startsWith('./tests/e2e/'))).toBe(true)
    expect(files.some(file => file.startsWith('./tests/unit/'))).toBe(true)
  })
})

/*
 * Through the script itself, in a project of its own, because the rule being
 * right is worth nothing if the spawn loop does not act on it.
 */
describe('a batched run', () => {
  const drive = async (count: number, batch: string, failing: boolean) => {
    const project = mkdtempSync(join(tmpdir(), 'reviewos-batched-'))
    try {
      mkdirSync(join(project, 'tests/unit'), { recursive: true })
      writeFileSync(join(project, 'bunfig.toml'), '[test]\nroot = "tests"\npreload = []\n')
      for (let at = 1; at <= count; at += 1) {
        writeFileSync(join(project, `tests/unit/f${at}.test.ts`), `
import { expect, test } from 'bun:test'
test('runs with its own global', () => {
  expect(globalThis.__reviewos_batch_marker).toBeUndefined()
  globalThis.__reviewos_batch_marker = true
})
`)
      }
      if (failing) {
        writeFileSync(join(project, 'tests/unit/zz-failure.test.ts'), `import { test } from 'bun:test'\ntest('intentional failure', () => { throw new Error('fixture failure') })\n`)
      }
      const child = Bun.spawn([process.execPath, resolve('.github/scripts/test-batched.ts')], {
        cwd: project,
        env: { ...process.env, PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ''}`, BUDDY_TEST_BATCH_FILES: batch },
        stdout: 'pipe', stderr: 'pipe',
      })
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
      return { code, output: stdout + stderr }
    }
    finally { rmSync(project, { recursive: true, force: true }) }
  }

  test('runs every file, in as many processes as the batch size asks for', async () => {
    const { code, output } = await drive(4, '2', false)

    expect(code).toBe(0)
    expect(output).toContain('Tests 1/2: 2 file(s)')
    expect(output).toContain('Tests 2/2: 2 file(s)')
    expect(output.match(/2 pass/g)?.length).toBe(2)
  }, 30_000)

  test('and says nothing about batches when there is only one', async () => {
    const { code, output } = await drive(4, '100', false)

    expect(code).toBe(0)
    expect(output).not.toContain('Tests 1/1')
    expect(output).toContain('4 pass')
  }, 30_000)

  test('a failure in any batch fails the run', async () => {
    const { code, output } = await drive(4, '2', true)

    expect(code).toBe(1)
    expect(output).toContain('1 fail')
  }, 30_000)

  test('and the batches after it still run, because a suite reports all of its failures', async () => {
    // The failing file sorts last, so this pins the opposite of fail-fast.
    const { code, output } = await drive(4, '1', true)

    expect(code).toBe(1)
    expect(output).toContain('Tests 5/5: 1 file(s)')
    expect(output.match(/1 pass/g)?.length).toBe(4)
  }, 40_000)
})

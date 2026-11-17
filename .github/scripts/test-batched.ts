/**
 * The suite, in batches of files, until a Stacks release carries the fix.
 *
 * ## Why this exists
 *
 * `buddy test` runs `bun test --isolate` with every test file in one process.
 * `--isolate` gives each file a fresh global and pays for it by evaluating the
 * module graph again per file, and those graphs stay for as long as the process
 * does - so peak memory grows with the number of files, not the largest one.
 * Measured here: about 23 MiB a file with isolation against about 0.48 MiB
 * without it, which is 13.5 GB across 589 files on a 16 GB runner.
 *
 * A run that *passed* ended with 142 MiB of 15,982 MiB available and swap drawn
 * down from 3,072 MiB to 16. So a passing run finishes one bad minute from
 * exhaustion, and ordinary variance decides whether a job lives. What the
 * failure looks like is not a failing test: the kernel picks a victim near the
 * tail of the suite, and when it picks the CI agent the job dies with nothing
 * to say why, because a cancelled job's log blob is never finalised. It took
 * three attempts to land one commit, and it has hit both dialects.
 *
 * ## Why it is here rather than in the framework
 *
 * It *is* in the framework, as of stacksjs/stacks eff017f7a3, which batches
 * inside `runTestSuites` where the `--isolate` flag is chosen. But this app
 * resolves `@stacksjs/actions` from npm (0.75.504 at the time of writing), not
 * from a linked checkout, so CI will keep running one process until a release
 * carries that commit and `package.json` moves to it.
 *
 * **Delete this file and restore `"test": "./buddy test"` once that release is
 * in.** `BUDDY_TEST_BATCH_FILES` is deliberately the same variable the
 * framework reads, so nothing that sets it has to change when the bridge goes.
 *
 * Scope, stated plainly: this covers `bun run test`, which is what CI runs. A
 * developer running `./buddy test` still gets one process for the whole suite
 * and can still be killed by it locally, because that path goes through the
 * installed package rather than through here. Fixing that too would mean
 * reimplementing suite and path filters, which is the framework's job and is
 * already done there - so the answer is the release, not more bridge.
 */
import process from 'node:process'

/** Matches the framework's default, and the measurement behind it. */
const defaultBatchFiles = 100

export function batchFiles(env: Record<string, string | undefined> = process.env): number | null {
  const named = env.BUDDY_TEST_BATCH_FILES?.trim()
  if (named === undefined || named === '')
    return defaultBatchFiles
  if (named === 'off')
    return null
  const size = Number(named)
  if (!Number.isInteger(size) || size < 0)
    throw new Error(`BUDDY_TEST_BATCH_FILES must be a whole number of files, or \`off\`. Got: ${named}`)
  return size === 0 ? null : size
}

export function intoBatches<T>(items: readonly T[], size: number): T[][] {
  const batches: T[][] = []
  for (let at = 0; at < items.length; at += size)
    batches.push(items.slice(at, at + size))
  return batches
}

/**
 * Every test file, the way `buddy test` with no arguments finds them.
 *
 * Globbed from `tests/` and prefixed with `./tests/`, because bunfig sets
 * `[test] root = "tests"` and a bare project-relative path matches nothing
 * there. Glob order is kept rather than sorted: it is the order the suite runs
 * in today, and a memory fix is not the place to reorder 589 files.
 */
export function testFiles(root = 'tests'): string[] {
  const pattern = '**/*.{test,spec}.{js,jsx,ts,tsx,mjs,mts,cjs,cts}'
  return [...new Bun.Glob(pattern).scanSync({ cwd: root, onlyFiles: true })]
    .map(file => `./${root}/${file}`)
}

export async function run(): Promise<number> {
  const files = testFiles()
  if (files.length === 0) {
    console.error('No test files found under tests/. That is a bug in this script, not an empty suite.')
    return 1
  }

  const size = batchFiles()
  const batches = size ? intoBatches(files, size) : [files]
  let failure = 0

  for (const [at, batch] of batches.entries()) {
    if (batches.length > 1)
      console.log(`\n=== Tests ${at + 1}/${batches.length}: ${batch.length} file(s) ===`)

    // `process.execPath` rather than `bun` from PATH: this runs inside the CI
    // supervisor, which spawns it with private pipes, and a different Bun on
    // PATH would be a second variable in a memory measurement.
    //
    // `stdio: inherit` keeps the supervisor's arrangement intact - these
    // children hold the supervisor's private pipe, never the Actions runner's.
    const child = Bun.spawn([process.execPath, 'test', '--isolate', ...batch], {
      stdio: ['inherit', 'inherit', 'inherit'],
    })
    const code = await child.exited

    // Every batch runs even after one fails: a suite reports all of its
    // failures, not the first, and that is what one process did.
    if (code !== 0 && failure === 0)
      failure = code || 1
  }

  return failure
}

if (import.meta.main)
  process.exit(await run())

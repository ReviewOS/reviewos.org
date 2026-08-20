// A job is found on disk, by the name it was dispatched under.
//
// The framework resolves a job by opening `app/Jobs/<name>.ts`. There is no
// registry and no scan: `Job.dispatch()` writes `name` into the queue row, the
// scheduler writes the string passed to `.job()`, and the worker takes whichever
// it finds and turns it straight into a path. So the invariant is small and
// absolute - **the name a job is dispatched under is the name of its file** -
// and breaking it produces nothing that looks like a bug.
//
// It was broken for every job in this application. The files are
// `MeasureLanguagesJob.ts`; the names were `MeasureLanguages`. In production
// that meant:
//
//   - the scheduler fired all twenty tasks on time and every one of them threw
//     `Job MirrorSweep not found` into the journal, so no mirror was ever swept
//     and 151 of them went stale with a clean record and no error;
//   - and every push-time dispatch wrote a row nothing could ever execute, so
//     no repository on the instance had a language breakdown - which is what
//     `/explore` renders as cards with no language on them.
//
// Neither failure raises, neither shows in `/api/health`'s queue depth, and
// both are invisible from outside the box. Hence a test rather than a habit.

import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const JOBS = join(import.meta.dir, '../../app/Jobs')
const SCHEDULER = join(import.meta.dir, '../../app/Scheduler.ts')

/**
 * The scheduler's source with its comments removed.
 *
 * The prose above `.job(...)` quotes the calls it is explaining, and a scan
 * that reads those finds tasks the scheduler does not have - which is a test
 * failing on its own documentation.
 */
function scheduledNames(): string[] {
  const source = readFileSync(SCHEDULER, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')

  return [...source.matchAll(/\.job\('([^']+)'\)/g)].map(([, name]) => name)
}

/** Every file in `app/Jobs`, by the name the resolver would look for. */
function jobFiles(): Set<string> {
  return new Set(
    readdirSync(JOBS)
      .filter(name => name.endsWith('.ts'))
      .map(name => name.replace(/\.ts$/, '')),
  )
}

describe('a job can be found by the name it is dispatched under', () => {
  test('every job declares the name of its own file', () => {
    const wrong: string[] = []

    for (const file of jobFiles()) {
      const source = readFileSync(join(JOBS, `${file}.ts`), 'utf8')
      const declared = /^ {2}name: '([^']+)',$/m.exec(source)

      // A plain `export default { handle }` declares no name and is only ever
      // reached by filename, which cannot be wrong.
      if (!declared)
        continue

      if (declared[1] !== file)
        wrong.push(`${file}.ts declares '${declared[1]}'`)
    }

    // Named rather than counted: "3 jobs are unreachable" sends somebody to
    // diff two lists by hand.
    expect(wrong.sort()).toEqual([])
  })

  test('every scheduled task names a job that exists', () => {
    const files = jobFiles()
    const missing = scheduledNames().filter(name => !files.has(name))

    // The state this test was written for: twenty tasks, twenty misses.
    expect(missing.sort()).toEqual([])
  })

  test('the scheduler schedules something', () => {
    // A guard on the guard. Both checks above pass vacuously against a file
    // that schedules nothing, and a scheduler with no tasks is a deployment
    // bug this repository has already had once.
    expect(scheduledNames().length).toBeGreaterThan(0)
  })
})

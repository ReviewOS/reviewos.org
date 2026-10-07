/**
 * One Bun version, everywhere, and nothing allowed to choose its own.
 *
 * On 2026-10-06 the two legs of a single CI run executed the suite on Bun
 * 1.3.11 and 1.4.2. Same commit, same workflow, two runtimes - and the
 * `test (postgres)` leg went red on a batch of failures including the stdout
 * backpressure canary, which asserts the *fixed* behaviour and so reports the
 * runtime rather than the code. A red that means "you drew an old Bun" is
 * worse than no signal, because it reads exactly like a real regression.
 *
 * Two causes, and `config/deps.ts` was only the smaller one. It said
 * `^1.3.14`, which permits everything through 1.4.x. But the pantry action
 * does not read that file at all: with no `packages` input it logs
 * "Installing bun.sh@latest via pantry SDK (defaulted to latest)", so every
 * job fetched whatever was newest at that moment.
 *
 * So the pin lives in two places that have no mechanism keeping them equal,
 * which is what this file is. Text rather than a YAML parse on purpose: the
 * thing being checked is a version string, the check must run on whatever Bun
 * is executing it, and a parser available in one release and not another is
 * the category of problem this test exists about.
 */

import { describe, expect, test } from 'bun:test'
import { readdirSync } from 'node:fs'

const deps = await Bun.file('config/deps.ts').text()

const workflows = readdirSync('.github/workflows')
  .filter(name => name.endsWith('.yml') || name.endsWith('.yaml'))
  .sort()

/** The version `config/deps.ts` declares, which is the one everything follows. */
const declared = /^\s*bun:\s*'([^']+)',/m.exec(deps)?.[1] ?? ''

describe('the Bun version', () => {
  test('is declared exactly, not as a range', () => {
    /*
     * A caret is right for a library and wrong for the runtime that executes
     * the tests. Two machines on different patch versions are not running the
     * same suite, and `^1.3.14` spanned a release in which the backpressure
     * behaviour changed.
     */
    expect(declared).toMatch(/^\d+\.\d+\.\d+$/)
  })
})

describe('every workflow that sets up pantry', () => {
  test('asks for that exact Bun and never lets the action default', async () => {
    /*
     * Counted rather than located: a workflow with three pantry steps and two
     * pins is the failure that matters, and it is invisible to a check that
     * only asks whether the string appears somewhere in the file.
     */
    const wrong: string[] = []

    for (const name of workflows) {
      const text = await Bun.file(`.github/workflows/${name}`).text()
      const setups = text.match(/uses:\s*pantry-pm\/pantry\/packages\/action@/g)?.length ?? 0

      if (setups === 0)
        continue

      const pins = text.match(new RegExp(`packages:\\s*bun\\.sh@${declared.replace(/\./g, '\\.')}(\\s|$)`, 'g'))?.length ?? 0

      if (pins !== setups)
        wrong.push(`${name}: ${setups} pantry setup(s), ${pins} pinned to ${declared}`)
    }

    expect(wrong).toEqual([])
  })

  test('pins no other Bun version anywhere', async () => {
    /*
     * The failure this catches is a half-finished bump: one workflow moved to
     * the new version and the rest left behind, which puts the fleet back on
     * two runtimes with the pin looking present in every file somebody checked.
     */
    const stray: string[] = []

    for (const name of workflows) {
      const text = await Bun.file(`.github/workflows/${name}`).text()

      for (const [, version] of text.matchAll(/packages:\s*bun\.sh@(\S+)/g)) {
        if (version !== declared)
          stray.push(`${name}: bun.sh@${version}`)
      }
    }

    expect(stray).toEqual([])
  })
})

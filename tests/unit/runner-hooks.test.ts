// Which hook runs, and whose.
//
// The precedence is the security rule, so it is a pure function over a
// directory listing rather than something you find out by running a job: for a
// stage that *decides* - `pre-bootstrap`, `checkout`, `command` - the runner's
// hook wins outright and the repository's is not consulted at all.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fleetHook, HOOK_STAGES, hooksFor, repositoryHooksAllowed, RUNNER_ONLY } from '../../app/Actions/Runner/hooks'

let runner = ''
let repository = ''

function write(directory: string, name: string, executable = true): void {
  const path = join(directory, name)

  writeFileSync(path, '#!/bin/sh\nexit 0\n')

  if (executable)
    chmodSync(path, 0o755)
}

beforeAll(() => {
  runner = mkdtempSync(join(tmpdir(), 'reviewos-runner-hooks-'))
  repository = mkdtempSync(join(tmpdir(), 'reviewos-repo-hooks-'))

  mkdirSync(runner, { recursive: true })
  mkdirSync(repository, { recursive: true })

  for (const stage of HOOK_STAGES) {
    write(runner, stage)
    write(repository, stage)
  }

  write(repository, 'not-executable', false)
})

afterAll(() => {
  rmSync(runner, { recursive: true, force: true })
  rmSync(repository, { recursive: true, force: true })
})

describe('an ordinary stage', () => {
  test('runs both, the machine\'s first', () => {
    // Both are legitimate: the operator's hook sets the machine up, the
    // repository's does something the repository needs. Order matters because
    // the second reads what the first exported.
    const hooks = hooksFor({ stage: 'pre-command', runnerDirectory: runner, repositoryDirectory: repository })

    expect(hooks.map(one => one.scope)).toEqual(['runner', 'repository'])
  })

  test('and either alone when only one exists', () => {
    expect(hooksFor({ stage: 'pre-exit', runnerDirectory: runner }).map(one => one.scope)).toEqual(['runner'])
    expect(hooksFor({ stage: 'pre-exit', repositoryDirectory: repository }).map(one => one.scope)).toEqual(['repository'])
    expect(hooksFor({ stage: 'pre-exit' })).toEqual([])
  })
})

describe('a stage that decides', () => {
  test('never consults the repository, even when it has one', () => {
    /*
     * The whole point of the runner scope. `pre-bootstrap` decides whether to
     * run this repository's code at all; `checkout` and `command` *replace* the
     * built-in behaviour, so a repository that could provide one would not be
     * running its own steps any more - and a fleet's wrapper would be removed
     * by whoever did not want it.
     */
    for (const stage of RUNNER_ONLY) {
      const both = hooksFor({ stage, runnerDirectory: runner, repositoryDirectory: repository })

      expect(both.map(one => one.scope)).toEqual(['runner'])

      // And with no runner hook, nothing at all - not the repository's.
      expect(hooksFor({ stage, repositoryDirectory: repository })).toEqual([])
    }
  })

  test('the three are exactly the ones worth protecting', () => {
    // Written down so that adding a fourth is a decision somebody makes on
    // purpose rather than a line in a diff.
    expect([...RUNNER_ONLY]).toEqual(['pre-bootstrap', 'checkout', 'command'])
  })
})

describe('what counts as a hook', () => {
  test('a file nobody can execute is not one', () => {
    // A README dropped in a hooks directory would otherwise be run as a shell
    // script, and the failure would be reported as the job's.
    expect(hooksFor({ stage: 'not-executable' as any, repositoryDirectory: repository })).toEqual([])
  })

  test('and a missing directory is not an error', () => {
    expect(hooksFor({ stage: 'pre-exit', runnerDirectory: '/nowhere-at-all' })).toEqual([])
    expect(fleetHook('/nowhere-at-all', 'runner-startup')).toBeNull()
  })
})

describe('the fleet hooks', () => {
  test('exist only in the runner scope', () => {
    // They belong to the machine and run when no job is claimed, so there is no
    // repository to take one from.
    write(runner, 'runner-startup')

    expect(fleetHook(runner, 'runner-startup')?.scope).toBe('runner')
  })
})

describe('a fork', () => {
  test('does not get its repository hooks run', () => {
    /*
     * A hook is code that runs outside the steps - before the checkout is used,
     * and after the job has finished. This runner refuses untrusted runs
     * outright, so this is a second line, and it is here so the day the first
     * is relaxed for a sandboxed runner it is not relaxed with it.
     */
    expect(repositoryHooksAllowed({ run: { trusted: false } })).toBe(false)
    expect(repositoryHooksAllowed({ run: { trusted: true } })).toBe(true)
    expect(repositoryHooksAllowed({})).toBe(true)
  })
})

describe('the order', () => {
  test('is the one Buildkite documents, so an operator can port a hook set', () => {
    expect([...HOOK_STAGES]).toEqual([
      'pre-bootstrap',
      'environment',
      'pre-checkout',
      'checkout',
      'post-checkout',
      'pre-command',
      'command',
      'post-command',
      'pre-artifact',
      'post-artifact',
      'pre-exit',
    ])
  })
})

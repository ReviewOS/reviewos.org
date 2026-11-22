// A CI mirror's hosted runner labels, translated onto this instance's runners.
//
// Written for zig-utils/zig-anti-virus, whose CI moved here while GitHub
// Actions was disabled for it: every job said `runs-on: ubuntu-latest` (or
// `${{ matrix.os }}`), no runner here answers to that, and the upstream file
// cannot be changed to say otherwise without breaking it on GitHub. What is
// pinned here is the reading, the storing and the translation; the dispatch
// that applies it is covered end to end in tests/e2e/mirror-ci.test.ts.

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { readDeclaration, settingsDrift } from '../../app/Actions/Mirror/declare'
import { declaredRunnerMap, readRunnerMap, storeRunnerMap, storeWorkflowPaths, translateRunsOn, workflowAllowed } from '../../app/Actions/Mirror/runnerMap'
import { combinationName } from '../../app/Actions/Workflow/dispatch'
import { containerFrom } from '../../app/Actions/Workflow/parse'

const ROOT = join(import.meta.dir, '../..')

describe('the map a mirrors.yml line declares', () => {
  test('takes lists, comma-separated strings, and false for "nothing here runs it"', () => {
    const map = declaredRunnerMap({
      'ubuntu-latest': ['self-hosted', 'linux-x64'],
      'macos-latest': 'self-hosted, macos-arm64',
      'windows-latest': false,
      'ubuntu-24.04-arm': [],
    })!

    expect(map.get('ubuntu-latest')).toEqual(['self-hosted', 'linux-x64'])
    expect(map.get('macos-latest')).toEqual(['self-hosted', 'macos-arm64'])
    expect(map.get('windows-latest')).toBeNull()
    expect(map.get('ubuntu-24.04-arm')).toBeNull()
  })

  test('has no opinion when the key is absent, and drops what is not shaped like a label', () => {
    expect(declaredRunnerMap(undefined)).toBeNull()

    const map = declaredRunnerMap({ 'ubuntu-latest': ['ok', 'not a label; rm -rf /'], 'bad label': ['x'], 'n': 3 })!
    expect([...map.keys()]).toEqual(['ubuntu-latest'])
    expect(map.get('ubuntu-latest')).toEqual(['ok'])
  })

  test('is stored as sorted lines and read back as the same map', () => {
    const map = declaredRunnerMap({ 'windows-latest': false, 'Ubuntu-Latest': ['self-hosted', 'linux-x64'] })!
    const stored = storeRunnerMap(map)

    expect(stored).toBe('ubuntu-latest=self-hosted,linux-x64\nwindows-latest=')
    expect(readRunnerMap(stored)).toEqual(map)
    expect(storeRunnerMap(new Map())).toBeNull()
    expect(readRunnerMap(null).size).toBe(0)
  })

  test('arrives through readDeclaration with the priority beside it', () => {
    const { mirrors, error } = readDeclaration(`
mirrors:
  - remote: zig-utils/zig-anti-virus
    owner: zig-utils
    ci: true
    priority: -5
    intermediate: skip
    runners:
      ubuntu-latest: [self-hosted, linux-x64]
      windows-latest: false
  - remote: stacksjs/.github
    owner: stacks
`)

    expect(error).toBeNull()
    expect(mirrors.mirrors[0]!.priority).toBe(-5)
    expect(mirrors.mirrors[0]!.intermediate).toBe('skip')
    expect(storeRunnerMap(mirrors.mirrors[0]!.runners!)).toBe('ubuntu-latest=self-hosted,linux-x64\nwindows-latest=')
    // A line without the keys has no opinion, so it cannot clear one set by hand.
    expect(mirrors.mirrors[1]!.runners).toBeUndefined()
    expect(mirrors.mirrors[1]!.priority).toBeUndefined()
    expect(mirrors.mirrors[1]!.intermediate).toBeUndefined()
  })
})

describe('what a declaration changes on a mirror that exists', () => {
  const current = { runWorkflows: true, credentialRef: '', visibility: 'public', runnerLabels: 'ubuntu-latest=self-hosted', jobPriority: 0 }

  test('a different translation and a different priority are both drift', () => {
    const drift = settingsDrift('zig-utils/zig-anti-virus', current, {
      remote: 'zig-utils/zig-anti-virus',
      owner: 'zig-utils',
      runners: declaredRunnerMap({ 'ubuntu-latest': ['self-hosted', 'linux-x64'] })!,
      priority: -5,
      intermediate: 'skip',
    })

    expect(drift.join('\n')).toContain('skip zig-utils/zig-anti-virus\'s intermediate runs')
    expect(drift.join('\n')).toContain('ubuntu-latest=self-hosted,linux-x64')
    expect(drift.join('\n')).toContain('priority -5')
  })

  test('the same ones, written in another order or case, are not', () => {
    expect(settingsDrift('a/b', { ...current, runnerLabels: 'ubuntu-latest=self-hosted\nwindows-latest=' }, {
      remote: 'a/b',
      owner: 'a',
      runners: declaredRunnerMap({ 'Windows-Latest': false, 'ubuntu-latest': 'self-hosted' })!,
      priority: 0,
    })).toEqual([])
  })
})

describe('translating a job\'s labels', () => {
  const map = declaredRunnerMap({ 'ubuntu-latest': ['self-hosted', 'linux-x64'], 'windows-latest': false })!

  test('replaces a mapped label and leaves the rest as they were', () => {
    expect(translateRunsOn(['ubuntu-latest'], map)).toEqual({ run: true, reason: '', runsOn: ['self-hosted', 'linux-x64'] })
    expect(translateRunsOn(['self-hosted', 'gpu'], map).runsOn).toEqual(['self-hosted', 'gpu'])
    // Matched without regard to case, as the claim matches, and never doubled.
    expect(translateRunsOn(['self-hosted', 'Ubuntu-Latest'], map).runsOn).toEqual(['self-hosted', 'linux-x64'])
  })

  test('skips a job asking for a label nothing here runs, and says which', () => {
    const answer = translateRunsOn(['windows-latest'], map)

    expect(answer.run).toBe(false)
    expect(answer.reason).toContain('`windows-latest`')
    expect(answer.reason).toContain('runs only upstream')
  })

  test('skips a job-level container on a translated mirror, and nowhere else', () => {
    expect(translateRunsOn(['ubuntu-latest'], map, 'fedora:latest')).toMatchObject({ run: false })
    expect(translateRunsOn(['ubuntu-latest'], map, 'fedora:latest').reason).toContain('container: fedora:latest')
    // No map is no opinion: a repository's own workflow is not this rule's business.
    expect(translateRunsOn(['ubuntu-latest'], new Map(), 'fedora:latest')).toEqual({ run: true, reason: '', runsOn: ['ubuntu-latest'] })
  })
})

describe('which of a mirror\'s workflows its events start', () => {
  test('every one, without a list', () => {
    expect(workflowAllowed(null, '.github/workflows/nightly.yml')).toBe(true)
    expect(storeWorkflowPaths([])).toBeNull()
  })

  test('only the listed ones, by full path or by file name', () => {
    const stored = storeWorkflowPaths(['ci.yml', '.github/workflows/differential.yml', 'ci.yml', 'not a path!'])

    expect(stored).toBe('.github/workflows/differential.yml\nci.yml')
    expect(workflowAllowed(stored, '.github/workflows/ci.yml')).toBe(true)
    expect(workflowAllowed(stored, '.github/workflows/differential.yml')).toBe(true)
    expect(workflowAllowed(stored, '.github/workflows/nightly.yml')).toBe(false)
  })
})

describe('a job-level container, as the parser records it', () => {
  test('in either of the two shapes Actions accepts', () => {
    expect(containerFrom('fedora:latest')).toBe('fedora:latest')
    expect(containerFrom({ image: 'node:20', options: '--cpus 1' })).toBe('node:20')
    expect(containerFrom(undefined)).toBeNull()
    expect(containerFrom({ options: '--cpus 1' })).toBeNull()
  })
})

describe('a matrix job\'s name', () => {
  test('fills a name that reads the matrix, the way Actions does', () => {
    expect(combinationName('Test (${{ matrix.os }})', { os: 'ubuntu-latest' })).toBe('Test (ubuntu-latest)')
    expect(combinationName('CPU variant ${{ matrix.cpu }}', { runner: 'ubuntu-latest', cpu: 'x86-64-v3' })).toBe('CPU variant x86-64-v3')
  })

  test('and appends the values to one that does not', () => {
    expect(combinationName('test', { os: 'ubuntu-latest', node: 20 })).toBe('test (ubuntu-latest, 20)')
    expect(combinationName('test', null)).toBe('test')
  })
})

describe('the file this repository ships', () => {
  test('declares zig-anti-virus as a CI mirror whose Windows jobs run only upstream', () => {
    const { mirrors } = readDeclaration(readFileSync(join(ROOT, 'mirrors.yml'), 'utf8'))
    const zav = mirrors.mirrors.find(mirror => mirror.remote === 'zig-utils/zig-anti-virus')

    expect(zav?.ci).toBe(true)
    expect(zav?.intermediate).toBe('skip')
    // The nightly fuzz is twenty-seven two-hour jobs: GitHub's to run, not a shared runner's.
    expect(workflowAllowed(storeWorkflowPaths(zav?.workflows), '.github/workflows/ci.yml')).toBe(true)
    expect(workflowAllowed(storeWorkflowPaths(zav?.workflows), '.github/workflows/nightly.yml')).toBe(false)
    expect(zav?.runners?.get('windows-latest')).toBeNull()
    expect(zav?.runners?.get('ubuntu-latest')?.length).toBeGreaterThan(0)
  })
})

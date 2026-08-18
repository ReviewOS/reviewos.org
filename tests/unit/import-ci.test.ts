// What a repository's CI looks like on the way in.
//
// The files come across with the clone - they are in the git history - so the
// deliverable is the report, produced before the move rather than after it. A
// file that copied cleanly and does not run is the worst outcome of a
// migration: everything looks moved, the first push is green in the file and
// red in reality, and somebody spends a morning finding out which of forty keys
// this instance does not implement.

import { describe, expect, test } from 'bun:test'
import { githubCiReader, reportOnWorkflows } from '../../app/Actions/Import/ci'

const ACTIONS = `name: CI
on:
  push:
    branches: [main]
jobs:
  build:
    runs-on: [self-hosted, gpu]
    container: node:20
    steps:
      - uses: actions/checkout@v4
      - uses: docker://ghcr.io/acme/lint:1
      - run: make
  publish:
    runs-on: macos-14
    steps:
      - uses: ./.github/actions/publish
`

describe('the report', () => {
  test('names the constructs that will not run here', async () => {
    const report = await reportOnWorkflows({ repositoryId: 0, files: [{ path: '.github/workflows/ci.yml', source: ACTIONS }] })

    const keys = report.workflows[0]!.differences.map(one => one.key)

    // `container:` at job level is the one every migration hits: it reads as a
    // toolchain and is isolation, and pretending to honour it would run the
    // steps on the host.
    expect(keys).toContain('jobs.<id>.container')
    expect(report.actions_needed.some(one => one.includes('container'))).toBe(true)
  })

  test('and the actions this instance could not resolve', async () => {
    const report = await reportOnWorkflows({ repositoryId: 0, files: [{ path: '.github/workflows/ci.yml', source: ACTIONS }] })
    const actions = report.workflows[0]!.actions

    expect(actions.map(one => one.uses)).toContain('actions/checkout@v4')

    // Unqualified, so it needs a default action host configured on the runner -
    // said before the move rather than discovered when the first run refuses it.
    const checkout = actions.find(one => one.uses === 'actions/checkout@v4')

    expect(checkout!.kind).toBe('remote')
    expect(String(checkout!.why)).toContain('default action host')

    // A local action is nobody's problem: it came with the repository.
    const local = actions.find(one => one.uses.startsWith('./'))

    expect(local!.kind).toBe('local')
    expect(local!.resolvable).toBe(true)
  })

  test('and the labels no machine here answers to', async () => {
    const report = await reportOnWorkflows({ repositoryId: 0, files: [{ path: '.github/workflows/ci.yml', source: ACTIONS }] })
    const labels = report.workflows[0]!.labels.map(one => one.label)

    // `runs-on: [self-hosted, gpu]` keeps meaning what it meant only if a
    // machine carries both, so both are reported.
    expect(labels).toContain('self-hosted')
    expect(labels).toContain('gpu')
    expect(labels).toContain('macos-14')
    expect(report.actions_needed.some(one => one.includes('queue forever'))).toBe(true)
  })

  test('and a file this instance will not register at all', async () => {
    const report = await reportOnWorkflows({
      repositoryId: 0,
      files: [{ path: '.github/workflows/broken.yml', source: 'name: Broken\njobs: []\n' }],
    })

    expect(report.workflows[0]!.error).toBeTruthy()
    expect(report.actions_needed[0]).toContain('will not register')
  })
})

describe('reading the settings from GitHub', () => {
  const answers: Record<string, unknown> = {
    'actions/variables?per_page=100': { variables: [{ name: 'DEPLOY_TARGET', value: 'production' }] },
    'actions/secrets?per_page=100': { secrets: [{ name: 'NPM_TOKEN' }, { name: 'DEPLOY_KEY' }] },
    'environments?per_page=100': {
      environments: [{
        name: 'production',
        protection_rules: [
          { type: 'wait_timer', wait_timer: 10 },
          { type: 'required_reviewers', reviewers: [{ id: 1 }, { id: 2 }] },
        ],
      }],
    },
  }

  const reader = githubCiReader({
    owner: 'acme',
    name: 'widgets',
    token: 'x',
    fetcher: (async (url: any) => {
      const path = String(url).split('/repos/acme/widgets/')[1] ?? ''

      return new Response(JSON.stringify(answers[path] ?? {}), { status: 200 })
    }) as any,
  })

  test('brings variables with their values', async () => {
    // Not credentials, and the endpoint that lists them returns them.
    expect(await reader.variables()).toEqual([{ name: 'DEPLOY_TARGET', value: 'production' }])
  })

  test('brings secret names and nothing else, because nothing else exists', async () => {
    // No forge hands a secret's value back, ours included: the feature is
    // write-only by design.
    expect(await reader.secretNames()).toEqual(['NPM_TOKEN', 'DEPLOY_KEY'])
  })

  test('and reads an environment\'s protection rather than only its name', async () => {
    const [production] = await reader.environments()

    // A deploy gate that silently did not move is a rule somebody believes is
    // on, which is worse than one they know they have to recreate.
    expect(production!.wait_minutes).toBe(10)
    expect(production!.reviewers).toBe(2)
  })
})

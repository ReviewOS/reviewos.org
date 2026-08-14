/**
 * One vocabulary for the CI side, before there is much of it to rename.
 *
 * Phase 15 builds Actions syntax on the front and a Buildkite-grade engine
 * underneath, and Buildkite has a different word for all five of the nouns
 * that matter: a workflow is a pipeline, a run is a build, a runner is an
 * agent, a runner pool is a cluster, run metadata is meta-data. Every one of
 * those is a word somebody will reach for while reading Buildkite's docs and
 * writing this codebase in the same afternoon.
 *
 * A synonym that lands once is permanent. `agent` is the expensive one: phase
 * 12 already means something else by it - a coding agent with a token - so the
 * word is taken, and the two meanings would be indistinguishable in a log line
 * a year from now.
 *
 * The same class of rule as "never repo", and checked the same way: against the
 * surface a client sees, plus the model and route names, rather than against
 * every comment. Prose *about* Buildkite is how the decision gets explained, so
 * comments and documentation are deliberately out of scope.
 */

import { describe, expect, test } from 'bun:test'
import { Glob } from 'bun'

/**
 * The Buildkite word, and the one that wins here.
 *
 * Paired rather than listed, for the reason `api-vocabulary.test.ts` gives: a
 * bare blocklist reads as arbitrary and the next person deletes the line
 * instead of renaming their endpoint.
 */
const SYNONYMS: Array<{ banned: RegExp, instead: string, why: string }> = [
  { banned: /\bpipelines?\b/i, instead: 'workflow', why: 'phase 9 named it, and it matches Actions' },
  { banned: /\bbuilds?\b/i, instead: 'workflow run', why: '"build" implies compilation, and most runs compile nothing' },
  { banned: /\bagents?\b/i, instead: 'runner', why: 'an agent here is a coding agent with a token, which is the more valuable meaning' },
  { banned: /\bclusters?\b/i, instead: 'runner pool', why: 'a pool is a group of queues and the workflows allowed to use them' },
  { banned: /meta-data/i, instead: 'run metadata', why: '`meta-data` with a hyphen is a Buildkite spelling, not a word' },
]

/** Only this application's surface. The framework's routes are not ours to rename. */
function ours(path: string): boolean {
  return !path.startsWith('/api/dashboard')
    && !path.startsWith('/api/commerce')
    && !path.startsWith('/api/cms')
    && !path.startsWith('/_stacks')
    && !path.startsWith('/__')
}

/**
 * Names that are allowed to contain a banned word, with the reason.
 *
 * `build` is an ordinary English verb and a build *step* is what a workflow
 * runs; the rule is about naming a workflow run a build, not about never
 * writing the word. Each exception is a specific string rather than a pattern,
 * so a new one has to be added deliberately.
 */
const ALLOWED = new Set([
  'BuildKitePlaceholder',
])

describe('the CI vocabulary', () => {
  test('no endpoint uses a Buildkite name for something already named', async () => {
    const spec: any = await Bun.file('storage/framework/api/openapi.json').json()
    const problems: string[] = []

    for (const path of Object.keys(spec.paths ?? {})) {
      if (!ours(path))
        continue

      for (const { banned, instead, why } of SYNONYMS) {
        if (banned.test(path))
          problems.push(`${path} - say ${instead}, because ${why}`)
      }
    }

    expect(problems).toEqual([])
  })

  test('and no parameter does either', async () => {
    const spec: any = await Bun.file('storage/framework/api/openapi.json').json()
    const problems: string[] = []

    for (const [path, item] of Object.entries(spec.paths ?? {}) as Array<[string, any]>) {
      if (!ours(path))
        continue

      for (const operation of Object.values(item) as any[]) {
        for (const parameter of operation?.parameters ?? []) {
          for (const { banned, instead } of SYNONYMS) {
            if (banned.test(String(parameter.name)))
              problems.push(`${path} takes ${parameter.name} - say ${instead}`)
          }
        }
      }
    }

    expect(problems).toEqual([])
  })

  test('no model is named for one', async () => {
    // A model name reaches a table name, a route, and every log line about it.
    const problems: string[] = []

    for await (const file of new Glob('*.ts').scan({ cwd: 'app/Models' })) {
      const name = file.replace('.ts', '')

      if (ALLOWED.has(name))
        continue

      for (const { banned, instead, why } of SYNONYMS) {
        if (banned.test(name))
          problems.push(`app/Models/${file} - say ${instead}, because ${why}`)
      }
    }

    expect(problems).toEqual([])
  })

  test('and no action is', async () => {
    const problems: string[] = []

    for await (const file of new Glob('**/*Action.ts').scan({ cwd: 'app/Actions' })) {
      const name = file.split('/').at(-1)?.replace('.ts', '') ?? ''

      if (ALLOWED.has(name))
        continue

      for (const { banned, instead, why } of SYNONYMS) {
        if (banned.test(name))
          problems.push(`app/Actions/${file} - say ${instead}, because ${why}`)
      }
    }

    expect(problems).toEqual([])
  })

  test('the words this product does use are the Actions ones', async () => {
    // The other half of the rule: a guard that only bans things passes on an
    // empty codebase. These are the nouns phase 9 built and phase 15 keeps.
    const spec: any = await Bun.file('storage/framework/api/openapi.json').json()
    const paths = Object.keys(spec.paths ?? {})

    expect(paths.some(path => path.includes('workflow-runs'))).toBe(true)
    expect(paths.some(path => path.includes('/runner/'))).toBe(true)
    expect(await Bun.file('app/Models/WorkflowRun.ts').exists()).toBe(true)
    expect(await Bun.file('app/Models/WorkflowJob.ts').exists()).toBe(true)
  })
})

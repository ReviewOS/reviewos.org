// Every `reviewos:` key, from the file to the row a runner is handed.
//
// The recurring failure in this phase has a shape: a key that parses, is stored
// somewhere, and is read by nothing. `fail-fast`, `timeout-minutes` and
// `permissions:` each shipped that way and each was found by accident. So this
// file is a table with one entry per key, and a test that fails when the table
// and the parser disagree - adding a key without covering it breaks the build.
//
// Three hops, because a value can be lost at each one:
//
//   the file  ->  the definition row  ->  the run's job row
//
// and, for the keys a machine acts on, the claim payload after that.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { dispatchPush } from '../../app/Actions/Workflow/dispatch'
import { EXTENSION_KEYS } from '../../app/Actions/Workflow/parse'
import { syncWorkflowFile } from '../../app/Actions/Workflow/sync'

const created = { ownerId: 0, repositoryId: 0, handle: '', name: '' }

let available = false
let db: any = null

function unique(prefix: string): string {
  return `${prefix}${Buffer.from(crypto.getRandomValues(new Uint8Array(5))).toString('hex')}`
}

/** A job's stored settings, whichever table it came from. */
function settingsOf(row: any): Record<string, any> {
  try {
    return JSON.parse(String(row?.settings ?? '{}'))
  }
  catch {
    return {}
  }
}

interface Attribute {
  /** The `reviewos:` keys this entry covers. */
  keys: string[]
  /** The job body, under `jobs:`, that uses them. */
  job: string
  /** What the definition row must say. */
  definition: (row: any) => void
  /** What the run's job row must say. */
  run: (row: any) => void
  /** Malformed forms, each with a phrase the error has to contain. */
  malformed?: Array<{ job: string, says: string }>
}

/*
 * One entry per key. The prose in each `definition`/`run` check is deliberately
 * about *where the value has to survive to*, not about what it means - the
 * meaning is tested beside the feature; this is about the plumbing.
 */
const ATTRIBUTES: Attribute[] = [
  {
    keys: ['group'],
    job: `  labelled:
    runs-on: ubuntu-latest
    reviewos:
      group: Build
    steps: [{ run: make }]`,
    definition: row => expect(String(row.group_label)).toBe('Build'),
    run: row => expect(String(row.group_label)).toBe('Build'),
  },
  {
    keys: ['priority'],
    job: `  urgent:
    runs-on: ubuntu-latest
    reviewos:
      priority: 10
    steps: [{ run: ./deploy }]`,
    definition: row => expect(Number(row.priority)).toBe(10),
    // A column rather than a settings key, because the claim orders by it on
    // every poll.
    run: row => expect(Number(row.priority)).toBe(10),
    malformed: [{ job: `  urgent:
    runs-on: ubuntu-latest
    reviewos:
      priority: high
    steps: [{ run: ./deploy }]`, says: 'not a whole number' }],
  },
  {
    keys: ['if-changed'],
    job: `  packaged:
    runs-on: ubuntu-latest
    reviewos:
      if-changed: packages/api/**
    steps: [{ run: make }]`,
    definition: row => expect(String(row.if_changed)).toContain('packages/api'),
    // Not carried onto the run: it is decided at dispatch, and the row records
    // the decision rather than the rule.
    run: row => expect(['queued', 'blocked', 'skipped']).toContain(String(row.state)),
  },
  {
    keys: ['retry'],
    job: `  flaky:
    runs-on: ubuntu-latest
    reviewos:
      retry: 2
    steps: [{ run: ./flaky }]`,
    definition: row => expect(Number(settingsOf(row).retry?.attempts)).toBe(2),
    run: row => expect(Number(settingsOf(row).retry?.attempts)).toBe(2),
    malformed: [{ job: `  flaky:
    runs-on: ubuntu-latest
    reviewos:
      retry: { exit-status: [7] }
    steps: [{ run: ./flaky }]`, says: 'needs a number of extra attempts' }],
  },
  {
    keys: ['agents'],
    job: `  gpu:
    runs-on: ubuntu-latest
    reviewos:
      agents: { gpu: a100 }
    steps: [{ run: ./train }]`,
    definition: row => expect(settingsOf(row).agents).toEqual(['gpu=a100']),
    run: row => expect(settingsOf(row).agents).toEqual(['gpu=a100']),
    malformed: [{ job: `  gpu:
    runs-on: ubuntu-latest
    reviewos:
      agents: [nonsense]
    steps: [{ run: ./train }]`, says: 'is not a tag query' }],
  },
  {
    keys: ['parallelism'],
    job: `  sharded:
    runs-on: ubuntu-latest
    reviewos:
      parallelism: 3
    steps: [{ run: ./test }]`,
    definition: row => expect(Number(settingsOf(row).parallelism)).toBe(3),
    // The run side is rows rather than a value: three of them, each knowing
    // which it is.
    run: row => expect(Number(row.parallel_total)).toBe(3),
    malformed: [{ job: `  sharded:
    runs-on: ubuntu-latest
    reviewos:
      parallelism: 0
    steps: [{ run: ./test }]`, says: 'at least 1' }],
  },
  {
    keys: ['artifact-paths'],
    job: `  keeps:
    runs-on: ubuntu-latest
    reviewos:
      artifact-paths: [out/**]
    steps: [{ run: make }]`,
    definition: row => expect(settingsOf(row).artifactPaths).toEqual(['out/**']),
    run: row => expect(settingsOf(row).artifactPaths).toEqual(['out/**']),
    malformed: [{ job: `  keeps:
    runs-on: ubuntu-latest
    reviewos:
      artifact-paths: [/etc/passwd]
    steps: [{ run: make }]`, says: 'outside the workspace' }],
  },
  {
    keys: ['secrets'],
    job: `  narrow:
    runs-on: ubuntu-latest
    reviewos:
      secrets: [DEPLOY_KEY]
    steps: [{ run: ./ship }]`,
    definition: row => expect(settingsOf(row).secrets).toEqual(['DEPLOY_KEY']),
    run: row => expect(settingsOf(row).secrets).toEqual(['DEPLOY_KEY']),
    malformed: [{ job: `  narrow:
    runs-on: ubuntu-latest
    reviewos:
      secrets: 12
    steps: [{ run: ./ship }]`, says: 'neither a name nor a list' }],
  },
  {
    keys: ['cancel-on-build-failing'],
    job: `  long:
    runs-on: ubuntu-latest
    reviewos:
      cancel-on-build-failing: true
    steps: [{ run: ./e2e }]`,
    definition: row => expect(settingsOf(row).cancelOnBuildFailing).toBe(true),
    run: row => expect(settingsOf(row).cancelOnBuildFailing).toBe(true),
  },
  {
    keys: ['checkout'],
    job: `  shallow:
    runs-on: ubuntu-latest
    reviewos:
      checkout: { depth: 1 }
    steps: [{ run: make }]`,
    definition: row => expect(Number(settingsOf(row).checkout?.depth)).toBe(1),
    run: row => expect(Number(settingsOf(row).checkout?.depth)).toBe(1),
    malformed: [{ job: `  shallow:
    runs-on: ubuntu-latest
    reviewos:
      checkout: { clean: true }
    steps: [{ run: make }]`, says: 'not a `checkout:` option' }],
  },
  {
    keys: ['concurrency', 'concurrency-group', 'concurrency-method'],
    job: `  locked:
    runs-on: ubuntu-latest
    reviewos:
      concurrency-group: production
      concurrency: 2
      concurrency-method: eager
    steps: [{ run: ./deploy }]`,
    definition: row => expect(settingsOf(row).concurrency).toEqual({ group: 'production', limit: 2, method: 'eager' }),
    run: row => expect(settingsOf(row).concurrency?.group).toBe('production'),
    malformed: [{ job: `  locked:
    runs-on: ubuntu-latest
    reviewos:
      concurrency: 2
    steps: [{ run: ./deploy }]`, says: 'has no `concurrency-group:`' }],
  },
  {
    keys: ['adjustments'],
    job: `  matrixed:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        node: [20, 22]
    reviewos:
      adjustments:
        - with: { node: 22 }
          soft-fail: true
    steps: [{ run: bun test }]`,
    definition: row => expect(settingsOf(row).adjustments?.[0]?.softFail).toBe(true),
    // On the run it is not a setting any more but a decision already applied to
    // the row it belongs to.
    run: (row) => {
      const values = JSON.parse(String(row.matrix_values ?? '{}'))

      expect(row.continue_on_error).toBe(Number(values.node) === 22)
    },
    malformed: [{ job: `  matrixed:
    runs-on: ubuntu-latest
    reviewos:
      adjustments: [{ soft-fail: true }]
    steps: [{ run: bun test }]`, says: 'which combination' }],
  },
  {
    keys: ['skip'],
    job: `  off:
    runs-on: ubuntu-latest
    reviewos:
      skip: The vendor API is down until Tuesday.
    steps: [{ run: ./vendor }]`,
    definition: row => expect(String(settingsOf(row).skip)).toContain('Tuesday'),
    run: (row) => {
      expect(String(row.state)).toBe('skipped')
      // The reason travels onto the row, which is the whole value of skipping
      // with words rather than commenting a job out.
      expect(String(row.condition_reason)).toContain('Tuesday')
    },
  },
  {
    keys: ['soft-fail'],
    job: `  tolerant:
    runs-on: ubuntu-latest
    reviewos:
      soft-fail: [1]
    steps: [{ run: ./lint }]`,
    definition: row => expect(settingsOf(row).softFail?.statuses).toEqual([1]),
    run: row => expect(settingsOf(row).softFail?.statuses).toEqual([1]),
  },
  {
    keys: ['branches'],
    job: `  mainly:
    runs-on: ubuntu-latest
    reviewos:
      branches: [main]
    steps: [{ run: ./deploy }]`,
    definition: row => expect(settingsOf(row).branches).toEqual(['main']),
    run: row => expect(settingsOf(row).branches).toEqual(['main']),
  },
  {
    keys: ['allow-dependency-failure'],
    job: `  anyway:
    runs-on: ubuntu-latest
    needs: [first]
    reviewos:
      allow-dependency-failure: true
    steps: [{ run: ./report }]
  first:
    runs-on: ubuntu-latest
    steps: [{ run: make }]`,
    definition: row => expect(settingsOf(row).continueOnFailure).toBe(true),
    run: row => expect(settingsOf(row).continueOnFailure).toBe(true),
  },
  {
    keys: ['wait'],
    job: `  everything-built:
    reviewos:
      wait: true
  first:
    runs-on: ubuntu-latest
    steps: [{ run: make }]`,
    definition: row => expect(String(row.kind)).toBe('wait'),
    run: (row) => {
      expect(String(row.kind)).toBe('wait')
      // Never queued: a barrier is the control plane's own work, and a runner
      // must never be offered one.
      expect(String(row.state)).toBe('blocked')
    },
  },
  {
    keys: ['block'],
    job: `  approve:
    reviewos:
      block:
        prompt: Ship it?`,
    definition: row => expect(String(row.kind)).toBe('block'),
    run: row => expect(String(row.kind)).toBe('block'),
  },
  {
    keys: ['trigger'],
    job: `  announce:
    reviewos:
      trigger:
        workflow: .github/workflows/other.yml`,
    definition: row => expect(String(row.kind)).toBe('trigger'),
    run: row => expect(String(row.kind)).toBe('trigger'),
  },
]

/** The definition row and the run row for the first job of a workflow. */
async function roundTrip(entry: Attribute, index: number): Promise<{ definition: any, runs: any[] }> {
  const path = `.github/workflows/rt-${index}.yml`

  await syncWorkflowFile({
    repositoryId: created.repositoryId,
    ownerType: 'user',
    ownerId: created.ownerId,
    path,
    source: `name: RT ${index}\non: push\njobs:\n${entry.job}\n`,
    sha: String(index).padStart(40, '0'),
  })

  const version: any = await db
    .selectFrom('workflow_versions')
    .innerJoin('workflows', 'workflows.id', '=', 'workflow_versions.workflow_id')
    .select(['workflow_versions.id as id'])
    .where('workflows.path', '=', path)
    .where('workflows.repository_id', '=', created.repositoryId)
    .orderBy('workflow_versions.id', 'desc')
    .executeTakeFirst()

  const definition: any = await db
    .selectFrom('workflow_version_jobs')
    .selectAll()
    .where('workflow_version_id', '=', Number(version.id))
    .orderBy('position')
    .executeTakeFirst()

  await dispatchPush({
    repositoryId: created.repositoryId,
    event: { ref: 'refs/heads/main' },
    headSha: unique('r').padEnd(40, '0').slice(0, 40),
  })

  const run: any = await db
    .selectFrom('workflow_runs')
    .select(['id'])
    .where('workflow_version_id', '=', Number(version.id))
    .orderBy('id', 'desc')
    .executeTakeFirst()

  const runs: any[] = await db
    .selectFrom('workflow_jobs')
    .selectAll()
    .where('workflow_run_id', '=', Number(run.id))
    .orderBy('position')
    .execute()

  // The workflow goes away again: every dispatch in this file starts a run of
  // every workflow the repository still has, and a file left behind makes the
  // next entry's dispatch slower and its lookups ambiguous.
  await db.deleteFrom('workflows').where('path', '=', path).where('repository_id', '=', created.repositoryId).execute()

  return { definition, runs }
}

beforeAll(async () => {
  try {
    const { injectGlobalAutoImports } = await import('@stacksjs/server')

    await injectGlobalAutoImports()
    db = (globalThis as any).db
    await db.selectFrom('users').select(['id']).limit(1).execute()

    created.handle = unique('rt')

    const owner: any = await db
      .insertInto('users')
      .values({ name: 'Round Trip', email: `${created.handle}@example.com`, handle: created.handle, password: 'x' })
      .returning(['id'])
      .executeTakeFirst()

    created.ownerId = Number(owner?.id)
    created.name = unique('repo')

    const repository: any = await db
      .insertInto('repositories')
      .values({
        owner_type: 'user',
        owner_id: created.ownerId,
        name: created.name,
        visibility: 'public',
        default_branch: 'main',
        disk_path: `${created.handle}/${created.name}.git`,
      })
      .returning(['id'])
      .executeTakeFirst()

    created.repositoryId = Number(repository?.id)

    available = true
  }
  catch (error) {
    console.warn(`[round-trip] skipping: ${error instanceof Error ? error.message : String(error)}`)
    available = false
  }
}, 120_000)

afterAll(async () => {
  try {
    if (created.repositoryId)
      await db.deleteFrom('repositories').where('id', '=', created.repositoryId).execute()
    if (created.ownerId)
      await db.deleteFrom('users').where('id', '=', created.ownerId).execute()
  }
  catch { /* the next run uses fresh names */ }
})

describe('the table itself', () => {
  test('covers every key the parser accepts', () => {
    /*
     * The point of this file. A key added to the parser and to nothing else is
     * the failure this phase keeps producing; from here on, adding one breaks
     * this test until somebody says where it is stored and what reads it.
     */
    const covered = new Set(ATTRIBUTES.flatMap(entry => entry.keys))

    expect([...EXTENSION_KEYS].filter(key => !covered.has(key))).toEqual([])
    expect([...covered].filter(key => !EXTENSION_KEYS.has(key))).toEqual([])
  })
})

describe('from the file to the row a runner sees', () => {
  for (const [index, entry] of ATTRIBUTES.entries()) {
    test(`${entry.keys.join(', ')} survives both hops`, async () => {
      if (!available)
        return

      const { definition, runs } = await roundTrip(entry, index)

      expect(definition).toBeTruthy()
      entry.definition(definition)

      const row = runs.find((one: any) => String(one.job_id) === String(definition.job_id))

      expect(row).toBeTruthy()

      // A matrix or a `parallelism:` produces several rows for one definition;
      // the check runs against every one of them, because a value that survived
      // onto the first row and not the third is exactly the bug this catches.
      for (const each of runs.filter((one: any) => String(one.job_id) === String(definition.job_id)))
        entry.run(each)
    }, 120_000)
  }
})

describe('the malformed forms', () => {
  for (const entry of ATTRIBUTES.filter(one => one.malformed?.length)) {
    test(`${entry.keys.join(', ')} is refused with a line and a fix`, async () => {
      if (!available)
        return

      const { parseWorkflow } = await import('../../app/Actions/Workflow/parse')

      for (const bad of entry.malformed!) {
        const result = parseWorkflow(`name: Bad\non: push\njobs:\n${bad.job}\n`, '.github/workflows/bad.yml')
        const matching = result.errors.filter(error => error.message.includes(bad.says))

        expect(matching.length).toBeGreaterThan(0)

        for (const error of matching) {
          // A validator that says "invalid" and not where or what to do is one
          // people work around by deleting the key.
          expect(error.line).toBeGreaterThan(0)
          expect(String(error.fix).length).toBeGreaterThan(0)
        }
      }
    }, 120_000)
  }
})

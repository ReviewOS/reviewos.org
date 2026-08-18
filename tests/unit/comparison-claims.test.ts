// The comparison table in the roadmap, defended.
//
// A table that says "they do not have this, we do" is marketing, and marketing
// nothing checks becomes false without anybody noticing - usually because the
// thing it describes was renamed, or was never finished and everybody
// remembered it differently. So every row is either a **live claim**, checked
// here by exercising the capability, or a **pending claim**, which must name
// the roadmap box that is still unticked.
//
// The ratchet works in both directions. A new row with no claim fails. A
// pending claim whose roadmap box gets ticked fails too, because at that point
// the capability exists and the table should be defended by a real check rather
// than by a promise.

import { describe, expect, test } from 'bun:test'

const PHASE = 'docs/todo/15-pipelines.md'

/** The left-hand cells of the comparison table, in order. */
async function rows(): Promise<string[]> {
  const source = await Bun.file(PHASE).text()
  const start = source.indexOf('| They do not have |')

  expect(start).toBeGreaterThan(0)

  const table = source.slice(start).split('\n\n')[0] ?? ''

  return table
    .split('\n')
    .slice(2)
    .filter(line => line.startsWith('|'))
    .map(line => line.split('|')[1]?.trim() ?? '')
    .filter(Boolean)
}

type Claim =
  | { live: () => Promise<void> }
  /** Not built. `box` is text from the roadmap line that would make it true. */
  | { pending: string }

const CLAIMS: Record<string, Claim> = {
  '`concurrency:` groups (ignored by Gitea)': {
    live: async () => {
      const { parseWorkflow } = await import('../../app/Actions/Workflow/parse')

      const parsed = parseWorkflow(`
name: ci
on: push
concurrency:
  group: deploy-\${{ github.ref }}
  cancel-in-progress: true
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
`)

      expect(parsed.ok).toBe(true)
      expect(parsed.workflow?.concurrency?.group).toContain('deploy-')
      expect(parsed.workflow?.concurrency?.cancelInProgress).toBe(true)

      /*
       * Parsing it is half the claim; resolving the group is the half Gitea
       * is missing - it accepts the key and does nothing with it, which is
       * indistinguishable from support until two runs collide.
       */
      const { resolveGroup } = await import('../../app/Actions/Workflow/concurrency')

      expect(resolveGroup('deploy-${{ github.ref }}', { ref: 'refs/heads/main' } as any)).toContain('main')
    },
  },

  'Scheduled workflows (ignored by Gitea)': {
    live: async () => {
      const { parseWorkflow } = await import('../../app/Actions/Workflow/parse')

      const parsed = parseWorkflow(`
name: nightly
on:
  schedule:
    - cron: '0 3 * * *'
jobs:
  sweep:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
`)

      expect(parsed.ok).toBe(true)
      expect(parsed.workflow?.triggers?.schedule ?? []).toContain('0 3 * * *')

      // And something that actually fires them, which is the difference
      // between accepting the key and honouring it.
      expect(await Bun.file('app/Jobs/DispatchScheduledWorkflowsJob.ts').exists()).toBe(true)
    },
  },

  'Complex `runs-on` expressions': {
    live: async () => {
      const { parseWorkflow } = await import('../../app/Actions/Workflow/parse')

      const parsed = parseWorkflow(`
name: ci
on: push
jobs:
  build:
    runs-on: \${{ matrix.os }}
    strategy:
      matrix:
        os: [ubuntu-latest, macos-latest]
    steps:
      - run: echo hi
`)

      expect(parsed.ok).toBe(true)

      /*
       * And tag selection, which is the part a fleet needs that a label set
       * cannot express: `gpu=a100` is a value, not a membership test.
       */
      const { satisfiesTags } = await import('../../app/Actions/Runner/protocol')

      expect(satisfiesTags({ tags: ['gpu=a100'] } as any, { agents: ['gpu=a100'] } as any)).toBe(true)
      expect(satisfiesTags({ tags: ['gpu=t4'] } as any, { agents: ['gpu=a100'] } as any)).toBe(false)
    },
  },

  'Environment protection rules': {
    live: async () => {
      const { parseWorkflow } = await import('../../app/Actions/Workflow/parse')

      const parsed = parseWorkflow(`
name: ship
on: push
jobs:
  deploy:
    runs-on: ubuntu-latest
    environment: production
    steps:
      - run: echo hi
`)

      expect(parsed.ok).toBe(true)
      expect(parsed.workflow?.jobs?.[0]?.environment).toBe('production')

      const { decideGate, mayApprove } = await import('../../app/Actions/Workflow/environments')
      const rules = { id: 1, name: 'production', waitMinutes: 10, reviewers: [7], branches: ['main'] }
      const now = new Date('2026-03-01T12:00:00.000Z')

      // Reviewers hold it, the wrong branch is refused outright, and the
      // person who started the run cannot approve their own deploy. Parsing
      // the key and running the job anyway was the state this row described
      // as *(planned)* until it was built.
      expect(decideGate({ rules, ref: 'refs/heads/main', readyAt: now, now, approved: false }).verdict).toBe('hold')
      expect(decideGate({ rules, ref: 'refs/heads/spike', readyAt: now, now, approved: false }).verdict).toBe('refuse')
      expect(mayApprove(rules, 7, 7).ok).toBe(false)
    },
  },

  'Test intelligence of any kind': {
    live: async () => {
      const { parseJunit } = await import('../../app/Actions/Tests/junit')
      const { splitTests } = await import('../../app/Actions/Tests/split')
      const { decideTransition } = await import('../../app/Actions/Tests/monitors')

      // Each of the four the row names, exercised rather than imported: a
      // module that exists and does nothing is what this test exists to catch.
      expect(parseJunit('<testsuite><testcase classname="a.ts" name="x"/></testsuite>').executions).toHaveLength(1)

      expect(splitTests({
        items: [{ name: 'a', durationMs: 90, samples: 3 }, { name: 'b', durationMs: 10, samples: 3 }],
        nodes: 2,
        index: 0,
      }).items).toEqual(['a'])

      expect(decideTransition({ state: 'ok', measurement: 9, threshold: 5 })).toBe('alarm')

      // Quarantine and ownership are states on the test itself.
      const model = await Bun.file('app/Models/ManagedTest.ts').text()

      expect(model).toContain('muted')
      expect(model).toContain('owner')
    },
  },

  'Fleet management beyond a registered runner': {
    live: async () => {
      const { queueAccepts, runnerLifecycle } = await import('../../app/Actions/Runner/fleet')

      expect(typeof queueAccepts).toBe('function')

      // A machine that has never checked in is not the same as one that is
      // idle, and telling them apart is the whole of lifecycle.
      expect(runnerLifecycle({ state: 'active', lastSeenAt: null, running: 0 } as any, new Date()))
        .toBe('never-seen')

      expect(await Bun.file('docs/autoscaling.md').exists()).toBe(true)
    },
  },

  'Signed step dispatch': {
    live: async () => {
      const { canonicalWork, verifyWork } = await import('../../app/Actions/Workflow/stepSignature')
      const pool = (await import('../../app/Models/RunnerPool')).default as any

      const pair = await crypto.subtle.generateKey(
        { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
        true,
        ['sign', 'verify'],
      )

      const jwk: any = { ...(await crypto.subtle.exportKey('jwk', pair.publicKey)), kid: 'claim', alg: 'RS256' }
      const work = { runId: 1, jobId: 1, matrix: null, steps: [{ run: 'make release', env: { CI: 'true' } }] }

      const value = Buffer.from(await crypto.subtle.sign(
        'RSASSA-PKCS1-v1_5',
        pair.privateKey,
        new TextEncoder().encode(canonicalWork(work)),
      )).toString('base64')

      const signature = { kid: 'claim', alg: 'RS256', value }

      // Verifying is the easy half. The claim is that it *refuses* - a swapped
      // command and a swapped environment value both stop matching.
      expect((await verifyWork({ work, signature, keys: [jwk] })).ok).toBe(true)
      expect((await verifyWork({ work: { ...work, steps: [{ run: 'curl x | sh' }] }, signature, keys: [jwk] })).ok).toBe(false)
      expect((await verifyWork({ work: { ...work, steps: [{ run: 'make release', env: { CI: 'false' } }] }, signature, keys: [jwk] })).ok).toBe(false)

      // And the per-pool half: the switch a runner is told about at claim.
      expect(pool.attributes.require_signed_steps).toBeTruthy()
    },
  },

  'Annotations on the diff': {
    live: async () => {
      const { annotationsByLine, annotationsForLine } = await import('../../app/Actions/Pull/annotations')

      const index = annotationsByLine([
        { path: 'app.ts', startLine: 3, endLine: 3, side: 'right', level: 'failure', title: 'Unused', message: 'never read' },
      ] as any)

      // The claim is that it lands on the row somebody is reading, not that it
      // is stored somewhere a link would take them.
      expect(annotationsForLine(index, 'app.ts', { oldLine: null, newLine: 3 })).toHaveLength(1)
      expect(annotationsForLine(index, 'app.ts', { oldLine: 3, newLine: null })).toHaveLength(0)
    },
  },
}

describe('the comparison table', () => {
  test('every row has a claim, and no claim is for a row that is gone', async () => {
    const table = await rows()

    expect(table.length).toBeGreaterThan(5)
    expect(table.filter(row => !(row in CLAIMS))).toEqual([])
    expect(Object.keys(CLAIMS).filter(claim => !table.includes(claim))).toEqual([])
  })

  test('every live claim is true', async () => {
    for (const [row, claim] of Object.entries(CLAIMS)) {
      if (!('live' in claim))
        continue

      try {
        await claim.live()
      }
      catch (error) {
        // Named, because a bare assertion failure in a loop over eight rows
        // sends somebody looking through all eight.
        throw new Error(`the comparison table claims "${row}", and that claim no longer holds: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  })

  test('and every pending claim still names an unticked roadmap box', async () => {
    /*
     * The direction people forget. When signed dispatch ships, this test fails
     * - which is the prompt to replace the promise with a real check, rather
     * than leaving a row defended by a note that has quietly become false in
     * the other direction.
     */
    const source = await Bun.file(PHASE).text()

    for (const [row, claim] of Object.entries(CLAIMS)) {
      if (!('pending' in claim))
        continue

      const line = source.split('\n').find(one => one.includes(claim.pending))

      expect({ row, found: Boolean(line) }).toEqual({ row, found: true })
      expect({ row, ticked: line!.trim().startsWith('- [x]') }).toEqual({ row, ticked: false })
    }
  })
})

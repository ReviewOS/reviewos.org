// What an automated repair may change, and when it must stop.
//
// The failure mode this guards is not an agent that writes bad code - bad code
// meets the same review everything else does. It is an agent that makes the
// evidence agree with it: edits the test that failed, relaxes the check that
// blocked it, regenerates the snapshot that disagreed, and presents a green
// pipeline as a fix.
//
// That is the locally optimal move for anything optimising "make the build
// pass". Every test here is one of the ways it would be taken.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import {
  defaultRepairPolicy,
  matchesPath,
  mayApproveRepair,
  mayAttemptRepair,
  mayProposeRepair,
  repairPolicyFor,
} from '../../app/Actions/Workflow/repairPolicy'

const on = { ...defaultRepairPolicy(), enabled: true }

function attempt(over: Record<string, unknown> = {}) {
  return mayAttemptRepair({
    policy: on,
    step: 'test',
    attempts: 0,
    minutesSpent: 0,
    costSpent: 0,
    ...over,
  } as any)
}

describe('whether a repair may start', () => {
  test('not until somebody turns it on', () => {
    // "An agent may push branches to this repository" is a decision somebody
    // makes, not one they discover.
    expect(attempt({ policy: defaultRepairPolicy() }).ok).toBe(false)
    expect(attempt({ policy: defaultRepairPolicy() }).refusal).toBe('not-enabled')
  })

  test('and only for the steps this repository asked about', () => {
    /*
     * A selected list is an allowlist. "Repair the flaky end-to-end suite" is a
     * sentence somebody means; "repair anything that goes red" is one nobody
     * does.
     */
    const policy = { ...on, steps: ['e2e'] }

    expect(attempt({ policy, step: 'e2e' }).ok).toBe(true)
    expect(attempt({ policy, step: 'lint' }).refusal).toBe('step-not-selected')
  })

  test('and stops at each budget, before anything is spent on the next one', () => {
    // A budget checked after the model has run is a budget that bills for the
    // answer it then throws away.
    expect(attempt({ attempts: 2 }).refusal).toBe('attempts-spent')
    expect(attempt({ minutesSpent: 20 }).refusal).toBe('time-spent')
    expect(attempt({ policy: { ...on, maxCost: 5 }, costSpent: 5 }).refusal).toBe('cost-spent')
  })

  test('with cost off unless an operator set one, since nobody shares a unit', () => {
    expect(attempt({ costSpent: 9_999_999 }).ok).toBe(true)
  })
})

describe('whether what came back may be proposed', () => {
  test('not if it relaxes a check a branch rule requires', () => {
    /*
     * The refusal the whole feature exists to make. An agent that may relax the
     * rule it failed can always succeed, and a pipeline made green by editing
     * what green means is worse than a red one - a red one is information.
     */
    const verdict = mayProposeRepair({ policy: on, paths: ['src/thing.ts'], weakensRequiredCheck: true })

    expect(verdict.ok).toBe(false)
    expect(verdict.refusal).toBe('weakens-a-required-check')
  })

  test('nor if it edits the tests that decide whether it worked', () => {
    for (const path of ['tests/unit/thing.test.ts', 'src/thing.spec.ts', 'spec/models/user.rb'])
      expect(mayProposeRepair({ policy: on, paths: [path] }).refusal).toBe('forbidden-path')
  })

  test('nor the workflows that decide what passing means', () => {
    expect(mayProposeRepair({ policy: on, paths: ['.github/workflows/ci.yml'] }).refusal).toBe('forbidden-path')
    expect(mayProposeRepair({ policy: on, paths: ['.reviewos/workflows/release.ts'] }).refusal).toBe('forbidden-path')
  })

  test('nor the snapshots and lockfiles that are the record of previous agreement', () => {
    for (const path of ['src/__snapshots__/a.snap', 'src/thing.snap', 'bun.lock', 'pnpm-lock.yaml'])
      expect(mayProposeRepair({ policy: on, paths: [path] }).refusal).toBe('forbidden-path')
  })

  test('and one forbidden path in a diff refuses the whole diff', () => {
    // Anything else would be a repair that gets merged on a Friday by somebody
    // reading the summary rather than the diff.
    const verdict = mayProposeRepair({ policy: on, paths: ['src/fix.ts', 'src/fix.test.ts'] })

    expect(verdict.ok).toBe(false)
    expect(String(verdict.reason)).toContain('src/fix.test.ts')
  })

  test('but an ordinary change is allowed, which is the point of the feature', () => {
    expect(mayProposeRepair({ policy: on, paths: ['src/parser.ts', 'README.md'] }).ok).toBe(true)
  })
})

describe('who may approve one', () => {
  test('not the account that proposed it, and no policy can permit it', () => {
    /*
     * A rule an operator could switch off is a rule that gets switched off
     * during the incident it exists for. An approval is a second person.
     */
    expect(mayApproveRepair({ proposedBy: 7, approvingAs: 7 }).refusal).toBe('self-approval')
    expect(mayApproveRepair({ proposedBy: 7, approvingAs: 8 }).ok).toBe(true)
  })
})

describe('the path matcher, which forbids and therefore must not under-match', () => {
  test('`**` crosses directories and `*` does not', () => {
    expect(matchesPath('tests/**', 'tests/unit/a.test.ts')).toBe(true)
    expect(matchesPath('*.snap', 'a/b.snap')).toBe(false)
    expect(matchesPath('**/*.snap', 'a/b.snap')).toBe(true)
  })

  test('and a dot is a dot', () => {
    // A matcher whose dots are wildcards forbids less than it appears to, and
    // this one's job is forbidding.
    expect(matchesPath('bun.lock', 'bunxlock')).toBe(false)
    expect(matchesPath('bun.lock', 'bun.lock')).toBe(true)
  })

  test('and a leading ./ does not smuggle a path past it', () => {
    expect(matchesPath('bun.lock', './bun.lock')).toBe(true)
  })
})

/*
 * The stored half. Everything above decides; this reads a row and hands the
 * decisions what they are given, which is the only place the two meet.
 */
describe('a repository\'s own policy', () => {
  let db: any = null
  let repositoryId = 0
  let available = false

  beforeAll(async () => {
    try {
      const { injectGlobalAutoImports } = await import('@stacksjs/server')

      await injectGlobalAutoImports()
      db = (globalThis as any).db

      const handle = `rp${Buffer.from(crypto.getRandomValues(new Uint8Array(5))).toString('hex')}`

      const owner: any = await db.insertInto('users')
        .values({ name: 'Repair', email: `${handle}@example.com`, handle, password: 'x' })
        .returning(['id']).executeTakeFirst()

      const repository: any = await db.insertInto('repositories').values({
        owner_type: 'user',
        owner_id: Number(owner.id),
        name: `${handle}repo`,
        visibility: 'public',
        default_branch: 'main',
        disk_path: `${handle}/${handle}repo.git`,
      }).returning(['id']).executeTakeFirst()

      repositoryId = Number(repository.id)
      available = true
    }
    catch (error) {
      console.warn(`[repair-policy] skipping: ${error instanceof Error ? error.message : String(error)}`)
      available = false
    }
  }, 120_000)

  afterAll(async () => {
    if (repositoryId)
      await db?.deleteFrom('repositories').where('id', '=', repositoryId).execute().catch(() => null)
  })

  test('is off when nobody has been asked', async () => {
    if (!available)
      return

    // No row is the answer for every repository on the instance, which is why
    // this is a table rather than a column that is false four thousand times.
    const policy = await repairPolicyFor(repositoryId)

    expect(policy.enabled).toBe(false)
    expect(policy.forbiddenPaths).toEqual(defaultRepairPolicy().forbiddenPaths)
  })

  test('and a row overrides the defaults field by field', async () => {
    if (!available)
      return

    /*
     * The property worth having: a repository that turned repair on and said
     * nothing else still gets the forbidden list somebody would write after the
     * first incident - and a default added next year protects it too.
     */
    await db.insertInto('repair_settings').values({
      repository_id: repositoryId,
      enabled: true,
      max_attempts: 5,
    }).execute()

    const policy = await repairPolicyFor(repositoryId)

    expect(policy.enabled).toBe(true)
    expect(policy.maxAttempts).toBe(5)
    expect(policy.maxMinutes).toBe(defaultRepairPolicy().maxMinutes)
    expect(policy.forbiddenPaths).toEqual(defaultRepairPolicy().forbiddenPaths)

    // And the decisions read it as their own input, which is the wiring.
    expect(mayAttemptRepair({ policy, step: 'test', attempts: 4, minutesSpent: 0, costSpent: 0 }).ok).toBe(true)
    expect(mayAttemptRepair({ policy, step: 'test', attempts: 5, minutesSpent: 0, costSpent: 0 }).refusal).toBe('attempts-spent')
  })

  test('and a list somebody wrote replaces the defaults rather than joining them', async () => {
    if (!available)
      return

    /*
     * Replacing is what writing a list means. Keeping the defaults for an
     * *empty* column is what never writing one means. The reading that would be
     * wrong is silently keeping the fourteen defaults when somebody deliberately
     * narrowed to three.
     */
    await db.updateTable('repair_settings')
      .set({ forbidden_paths: 'src/generated/**\ndocs/**', steps: 'e2e' })
      .where('repository_id', '=', repositoryId)
      .execute()

    const policy = await repairPolicyFor(repositoryId)

    expect(policy.forbiddenPaths).toEqual(['src/generated/**', 'docs/**'])
    expect(policy.steps).toEqual(['e2e'])

    // Which means this repository now allows a test edit, because it said so.
    expect(mayProposeRepair({ policy, paths: ['src/a.test.ts'] }).ok).toBe(true)
    expect(mayProposeRepair({ policy, paths: ['docs/readme.md'] }).refusal).toBe('forbidden-path')
  })
})

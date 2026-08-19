// Driving a workflow program on the machine where running it is allowed.
//
// The module loader is injected, because none of what matters here is a
// question about module resolution: it is what happens to a program that
// suspends, that throws, or that was never a program at all.

import { describe, expect, test } from 'bun:test'
import { drive, entrypointOf, MISSING_ENTRYPOINT } from '../../app/Actions/Runner/orchestrate'

/** A control plane that dispatches everything and records nothing. */
function permissive() {
  const reported: any[] = []
  let id = 0

  return {
    reported,
    transport: {
      async call() {
        id += 1
        return { decision: 'dispatch' as const, entry_id: id }
      },
      async report(body: any) {
        reported.push(body)
      },
    },
  }
}

describe('finding the function to run', () => {
  test('the default export, which is the documented form', () => {
    expect(entrypointOf({ default: () => 'x' })).toBeTypeOf('function')
  })

  test('and the named ones people write instead', () => {
    expect(entrypointOf({ workflow: () => 'x' })).toBeTypeOf('function')
    expect(entrypointOf({ run: () => 'x' })).toBeTypeOf('function')
    // `export default { workflow() {} }`, which is what a file written as an
    // object literal produces.
    expect(entrypointOf({ default: { workflow: () => 'x' } })).toBeTypeOf('function')
  })

  test('and nothing, for a file that exported none', () => {
    expect(entrypointOf({ helper: 1 })).toBeNull()
  })
})

describe('a program that finishes', () => {
  test('is done, and says how many calls it made', async () => {
    const plane = permissive()

    const outcome = await drive('release.ts', plane.transport, async () => ({
      default: async (workflow: any) => {
        await workflow.step('build', async () => 'built')
        await workflow.step('test', async () => 'tested')
      },
    }))

    expect(outcome.state).toBe('done')
    expect(outcome.calls).toBe(2)
    // Both results reported, which is what makes the second run of this
    // program skip them.
    expect(plane.reported.map(one => one.result)).toEqual(['built', 'tested'])
  })
})

describe('a program that suspends', () => {
  /**
   * The case that must not be a failure. A workflow waiting for an approval
   * that reported itself failed would put a red cross on somebody's commit for
   * a decision nobody has made yet.
   */
  test('is suspended rather than failed, and names when it may resume', async () => {
    const wakeAt = new Date(Date.now() + 3600_000).toISOString()

    const outcome = await drive('release.ts', {
      async call() {
        return { decision: 'wait' as const, entry_id: 1, wake_at: wakeAt }
      },
      async report() {},
    }, async () => ({
      default: async (workflow: any) => {
        await workflow.sleep('an hour', 3600_000)
        throw new Error('this line must not be reached')
      },
    }))

    expect(outcome.state).toBe('suspended')
    expect(outcome.wakeAt).toBe(wakeAt)
  })
})

describe('a program that cannot run', () => {
  test('reports the loader error rather than a generic failure', async () => {
    // A syntax error names its line; "the workflow failed" does not.
    const outcome = await drive('broken.ts', permissive().transport, async () => {
      throw new Error('Unexpected token at broken.ts:12')
    })

    expect(outcome.state).toBe('failed')
    expect(outcome.reason).toContain('broken.ts:12')
  })

  test('and a file that exported no function says what was expected', async () => {
    const outcome = await drive('empty.ts', permissive().transport, async () => ({ helper: 1 }))

    expect(outcome.state).toBe('failed')
    expect(outcome.reason).toBe(MISSING_ENTRYPOINT)
  })
})

describe('a program that throws', () => {
  test('fails the job with the program\'s own message', async () => {
    const outcome = await drive('release.ts', permissive().transport, async () => ({
      default: async () => {
        throw new Error('the release notes were empty')
      },
    }))

    expect(outcome.state).toBe('failed')
    expect(outcome.reason).toBe('the release notes were empty')
  })

  /**
   * A divergence is the end of the run and not retryable by anyone, so it fails
   * the job with the journal's own sentence - which names the call that
   * changed rather than saying the workflow is non-deterministic.
   */
  test('and a run that is over fails with the reason the journal gave', async () => {
    const outcome = await drive('release.ts', {
      async call() {
        return { decision: 'diverged' as const, reason: 'call 2 was step(install) and is now step(deploy)' }
      },
      async report() {},
    }, async () => ({
      default: async (workflow: any) => {
        await workflow.step('deploy', async () => 'deployed')
      },
    }))

    expect(outcome.state).toBe('failed')
    expect(outcome.reason).toContain('call 2')
  })
})

// Whether a claimed job goes into a machine, and what happens when it cannot.
//
// The branch this covers sits at the top of `runOnce`, ahead of the workspace
// and the step loop, because everything below it is machinery for running
// somebody's code as a process on the runner - which is the thing a microVM
// exists to avoid.

import { describe, expect, test } from 'bun:test'
import { executionMode, microvmRefusal } from '../../config/ci-execution'
import { policyFrom, runJobInMachine, stepsFor, wallSecondsFor } from '../../app/Actions/Runner/microvmRun'

/** A configured runner, as environment. */
const CONFIGURED = {
  REVIEWOS_EXECUTION: 'microvm',
  REVIEWOS_GUEST_KERNEL: '/var/lib/reviewos/vmlinux',
  REVIEWOS_GUEST_IMAGE: '/var/lib/reviewos/base.ext4',
  REVIEWOS_GUEST_IMAGE_DIGEST: `sha256:${'a'.repeat(64)}`,
}

function withEnv(values: Record<string, string | undefined>, run: () => void | Promise<void>) {
  const before = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]))

  for (const [key, value] of Object.entries(values)) {
    if (value === undefined)
      delete process.env[key]
    else
      process.env[key] = value
  }

  const restore = () => {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined)
        delete process.env[key]
      else
        process.env[key] = value
    }
  }

  const result = run()

  return result instanceof Promise ? result.finally(restore) : (restore(), undefined)
}

describe('the mode', () => {
  test('is what this runner has always done, when nobody said otherwise', () => {
    /*
     * The threat model's default is the mode that runs nothing special. A runner
     * is somebody else's machine started by somebody else's script, and an unset
     * variable must not change how their CI behaves.
     */
    expect(executionMode({})).toBe('host')
  })

  test('and a typo is `host` rather than an error', () => {
    // Taking their CI offline over a misspelling is worse than leaving it doing
    // what it did yesterday.
    expect(executionMode({ REVIEWOS_EXECUTION: 'microvms' })).toBe('host')
    expect(executionMode({ REVIEWOS_EXECUTION: 'MicroVM' })).toBe('microvm')
  })
})

describe('a runner that asked to isolate but cannot', () => {
  test('says which piece is missing rather than guessing', () => {
    expect(microvmRefusal({ REVIEWOS_EXECUTION: 'microvm' })).toContain('KERNEL')
    expect(microvmRefusal({ ...CONFIGURED, REVIEWOS_GUEST_IMAGE: '' })).toContain('IMAGE')
  })

  test('and refuses without a digest, which is about honesty rather than booting', () => {
    /*
     * A machine boots perfectly well from an image nobody named. What it cannot
     * do is tell the run what executed it, and that is the line this mode exists
     * to be able to answer.
     */
    expect(microvmRefusal({ ...CONFIGURED, REVIEWOS_GUEST_IMAGE_DIGEST: '' })).toContain('what executed it')
    expect(microvmRefusal(CONFIGURED)).toBeNull()
  })

  test('and fails the job rather than running it on the host', async () => {
    /*
     * The whole reason this is a refusal and not a fallback. A runner that ran
     * the job somewhere weaker would be claiming an isolation it does not have,
     * and the job would look exactly like one that was isolated.
     */
    await withEnv({ ...CONFIGURED, REVIEWOS_GUEST_KERNEL: '' }, async () => {
      const outcome = await runJobInMachine({ job: { id: 1, steps: [{ run: 'true' }] }, onOutput: async () => {} })

      expect(outcome.state).toBe('failed')
      expect(outcome.reason).toContain('KERNEL')
    })
  })
})

describe('the steps a job offers', () => {
  test('are its commands', () => {
    const found = stepsFor({ steps: [{ run: 'a' }, { name: 'x', run: 'b' }] })

    expect(found.ok && found.steps).toEqual([{ run: 'a' }, { run: 'b' }])
  })

  test('and an action refuses the job rather than being skipped', () => {
    /*
     * A `uses:` step is a program the runner fetches and executes with a
     * protocol around it, and none of that exists for a guest. Skipping it would
     * report success for work nobody did, which is worse than refusing.
     */
    const found = stepsFor({ steps: [{ run: 'a' }, { uses: 'actions/checkout@v4' }] })

    expect(found.ok).toBe(false)
    expect(!found.ok && found.reason).toContain('actions/checkout@v4')
    expect(!found.ok && found.reason).toContain('will not pretend')
  })

  test('and a job with nothing to run says so', () => {
    expect(stepsFor({ steps: [] }).ok).toBe(false)
  })
})

describe('the egress entries an operator wrote', () => {
  test('take an optional port, defaulting to the policy\'s own', () => {
    const built = policyFrom(['198.51.100.10:80'], [])

    expect(built.ok && built.policy.rules[0]).toEqual({ host: '198.51.100.10', ports: [80] })
  })

  test('and one the policy refuses fails the job rather than being dropped', () => {
    /*
     * An operator who wrote a rule the policy will not accept has a
     * misconfigured runner. Running their jobs against a quietly shorter
     * allowlist is how that goes unnoticed until it matters.
     */
    const built = policyFrom(['169.254.169.254:80'], [])

    expect(built.ok).toBe(false)
    expect(!built.ok && built.reason).toContain('169.254.169.254')
  })

  test('and nothing at all is a policy that reaches nothing', () => {
    const built = policyFrom([], [])

    expect(built.ok && built.policy.mode).toBe('deny')
  })
})

describe('how long the machine lives', () => {
  test('is the job\'s own timeout where it set one', () => {
    expect(wallSecondsFor({ timeout_minutes: 5 })).toBe(300)
  })

  test('and an hour where it did not', () => {
    expect(wallSecondsFor({})).toBe(3600)
    expect(wallSecondsFor({ timeout_minutes: 0 })).toBe(3600)
  })
})

describe('what the host concludes', () => {
  test('a machine that stopped without reporting failed, whatever its last step said', async () => {
    /*
     * The shape a job takes when the clock kills it. Reading the final exit code
     * would report the step *before* the one that ran out of time as the job's
     * result.
     */
    await withEnv(CONFIGURED, async () => {
      const outcome = await runJobInMachine({
        job: { id: 7, steps: [{ run: 'echo hi' }] },
        onOutput: async () => {},
        supervise: async () => ({
          ok: false,
          steps: [{ index: 0, exitCode: 0, output: 'hi\n' }],
          reason: 'the machine was killed after 60 seconds',
          noise: '',
        }),
      })

      expect(outcome.state).toBe('failed')
      expect(outcome.reason).toContain('killed')
    })
  })

  test('and a failing step is reported with the status a retry rule can read', async () => {
    await withEnv(CONFIGURED, async () => {
      const outcome = await runJobInMachine({
        job: { id: 8, steps: [{ run: 'exit 137' }] },
        onOutput: async () => {},
        supervise: async () => ({
          ok: false,
          steps: [{ index: 0, exitCode: 137, output: '' }],
          reason: undefined,
          noise: '',
        }),
      })

      expect(outcome.exitStatus).toBe(137)
      expect(outcome.reason).toContain('exited 137')
    })
  })

  test('and a clean finish succeeds', async () => {
    await withEnv(CONFIGURED, async () => {
      const outcome = await runJobInMachine({
        job: { id: 9, steps: [{ run: 'true' }] },
        onOutput: async () => {},
        supervise: async () => ({ ok: true, steps: [{ index: 0, exitCode: 0, output: '' }], noise: '' }),
      })

      expect(outcome.state).toBe('succeeded')
      expect(outcome.exitStatus).toBe(0)
    })
  })
})

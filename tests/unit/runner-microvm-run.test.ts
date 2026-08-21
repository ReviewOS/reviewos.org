// Whether a claimed job goes into a machine, and what happens when it cannot.
//
// The branch this covers sits at the top of `runOnce`, ahead of the workspace
// and the step loop, because everything below it is machinery for running
// somebody's code as a process on the runner - which is the thing a microVM
// exists to avoid.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { executionMode, microvmRefusal } from '../../config/ci-execution'
import { policyFrom, runJobInMachine, stepsFor, wallSecondsFor } from '../../app/Actions/Runner/microvmRun'

/**
 * A configured runner, as environment.
 *
 * The image and kernel are real files with their real digests, because the run
 * path measures them before it does anything else - a pin that was never checked
 * against the bytes was the defect that check exists for, so a test that stubbed
 * it out would be testing the version with the hole in it.
 */
const CONFIGURED: Record<string, string> = {
  REVIEWOS_EXECUTION: 'microvm',
  REVIEWOS_GUEST_KERNEL: '',
  REVIEWOS_GUEST_IMAGE: '',
  REVIEWOS_GUEST_IMAGE_DIGEST: '',
}

let pinRoot = ''

beforeAll(async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { measureFile, forgetMeasurements } = await import('../../app/Actions/Runner/vmImage')

  forgetMeasurements()

  pinRoot = mkdtempSync(join(tmpdir(), 'reviewos-pinned-'))

  const image = join(pinRoot, 'base.ext4')
  const kernel = join(pinRoot, 'vmlinux')

  writeFileSync(image, 'an image')
  writeFileSync(kernel, 'a kernel')

  CONFIGURED.REVIEWOS_GUEST_IMAGE = image
  CONFIGURED.REVIEWOS_GUEST_KERNEL = kernel
  CONFIGURED.REVIEWOS_GUEST_IMAGE_DIGEST = String(await measureFile(image))
})

afterAll(async () => {
  if (pinRoot) {
    const { rmSync } = await import('node:fs')

    rmSync(pinRoot, { recursive: true, force: true })
  }
})

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
  /** Expand with a resolver that answers from a table rather than a disk. */
  async function expand(steps: any[], actions: Record<string, { yml: string, local?: boolean }> = {}) {
    const { expandSteps } = await import('../../app/Actions/Runner/microvmActions')

    // `expandSteps` reads the manifest from a directory, so the table is written
    // to a temporary one - the point under test is the expansion, not the file.
    const { mkdtempSync, writeFileSync, mkdirSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')

    const root = mkdtempSync(join(tmpdir(), 'reviewos-actions-'))

    try {
      for (const [name, action] of Object.entries(actions)) {
        const dir = join(root, name.replace(/[^a-z0-9]/gi, '_'))

        mkdirSync(dir, { recursive: true })
        writeFileSync(join(dir, 'action.yml'), action.yml)
      }

      return await expandSteps({
        steps,
        workspace: '/work/workspace',
        actionsRoot: '/work/actions',
        resolve: async (uses) => {
          const action = actions[uses]

          if (!action)
            return { ok: false as const, reason: `no such action ${uses}` }

          return {
            ok: true as const,
            directory: join(root, uses.replace(/[^a-z0-9]/gi, '_')),
            local: action.local ?? false,
            label: uses,
            relative: uses.replace(/^\.\//, ''),
          }
        },
      })
    }
    finally {
      rmSync(root, { recursive: true, force: true })
    }
  }

  test('a plain command is one step', async () => {
    const found = await expand([{ run: 'a' }, { name: 'x', run: 'b' }])

    expect(found.ok && found.steps.map(s => s.run)).toEqual(['a', 'b'])
  })

  test('and a composite action becomes the commands it is made of', async () => {
    /*
     * The whole design: the host finishes the work and the guest runs commands.
     * Resolving an action needs the network, the cache and the policy, all of
     * which are the host's - a guest that could fetch its own actions would be a
     * guest with a route out and a say in what it runs.
     */
    const found = await expand(
      [{ uses: 'acme/setup@v1', with: { version: '20' } }],
      {
        'acme/setup@v1': {
          yml: [
            'name: setup',
            'inputs:',
            '  version:',
            '    description: v',
            'runs:',
            '  using: composite',
            '  steps:',
            '    - run: echo one',
            '    - run: echo two',
          ].join('\n'),
        },
      },
    )

    expect(found.ok && found.steps.map(s => s.run)).toEqual(['echo one', 'echo two'])
    // The action's inputs reach every step it is made of.
    expect(found.ok && found.steps[0]!.env?.INPUT_VERSION).toBe('20')
  })

  test('and a fetched action is carried onto the payload disk, a local one is not', async () => {
    /*
     * An action that lives in the repository arrived with the checkout and is
     * addressed where it already is. Copying it again would be a second copy of
     * the same bytes on a disk with a size limit.
     */
    const yml = 'runs:\n  using: composite\n  steps:\n    - run: echo hi'

    const remote = await expand([{ uses: 'acme/a@v1' }], { 'acme/a@v1': { yml } })
    const local = await expand([{ uses: './tools/a' }], { './tools/a': { yml, local: true } })

    expect(remote.ok && remote.ship).toHaveLength(1)
    expect(remote.ok && remote.steps[0]!.env?.GITHUB_ACTION_PATH).toBe('/work/actions/0')

    expect(local.ok && local.ship).toHaveLength(0)
    expect(local.ok && local.steps[0]!.env?.GITHUB_ACTION_PATH).toBe('/work/workspace/tools/a')
  })

  test('and a JavaScript action is refused by name rather than skipped', async () => {
    /*
     * Named rather than generic: a JavaScript action is a thing an *image* could
     * support and this one may not, which sends somebody to the image rather
     * than to the workflow. Skipping it would report success for work nobody
     * did.
     */
    const found = await expand(
      [{ uses: 'acme/js@v1' }],
      { 'acme/js@v1': { yml: 'runs:\n  using: node20\n  main: index.js' } },
    )

    expect(found.ok).toBe(false)
    expect(!found.ok && found.reason).toContain('JavaScript action')
    expect(!found.ok && found.reason).toContain('acme/js@v1')
  })

  test('and a container action is refused, because the machine is the boundary', async () => {
    const found = await expand(
      [{ uses: 'acme/d@v1' }],
      { 'acme/d@v1': { yml: 'runs:\n  using: docker\n  image: docker://alpine' } },
    )

    expect(!found.ok && found.reason).toContain('container action')
  })

  test('and an action that uses itself is refused rather than recursed', async () => {
    const found = await expand(
      [{ uses: 'acme/loop@v1' }],
      { 'acme/loop@v1': { yml: 'runs:\n  using: composite\n  steps:\n    - uses: acme/loop@v1' } },
    )

    expect(found.ok).toBe(false)
    expect(!found.ok && found.reason).toContain('uses itself')
  })

  test('and an action that cannot be resolved fails the job', async () => {
    const found = await expand([{ uses: 'acme/missing@v1' }])

    expect(found.ok).toBe(false)
  })
})

describe('a secret written into an action input', () => {
  test('stays a shell reference rather than becoming the value', async () => {
    /*
     * The one place this expansion could undo the secrets design. `with:` values
     * are filled in on the host, so writing the value here would put a
     * credential into a step script on the payload disk - at rest, on the
     * runner's real filesystem, which is exactly what that design refused.
     *
     * Left as `"$TOKEN"`, the guest's own shell substitutes it from the
     * environment it was handed over the console.
     */
    const { symbolicSecrets } = await import('../../app/Actions/Runner/microvmActions')

    expect(symbolicSecrets('curl -H "Bearer ${{ secrets.API_TOKEN }}"')).toBe('curl -H "Bearer "$API_TOKEN""')
    expect(symbolicSecrets('echo ${{ secrets.a_b }}')).toBe('echo "$A_B"')
  })

  test('and leaves everything else alone', async () => {
    const { symbolicSecrets } = await import('../../app/Actions/Runner/microvmActions')

    expect(symbolicSecrets('echo ${{ github.sha }}')).toBe('echo ${{ github.sha }}')
    expect(symbolicSecrets('echo plain')).toBe('echo plain')
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

describe('how the source reaches the guest', () => {
  /** The script `makeOverlay` would run, without running it. */
  async function overlayScript(sourcePath?: string) {
    const { makeOverlay } = await import('../../app/Actions/Runner/microvmSupervisor')

    let script = ''

    await makeOverlay(
      {
        firecracker: '/x', scratch: '/s', hostAddress: '172.20.0.1', guestAddress: '172.20.0.2',
        privileged: async (argv) => { script = String(argv[2] ?? ''); return { ok: true, output: '' } },
      },
      '/s/job-1.ext4',
      64,
      [{ run: 'echo hi' }],
      'n'.repeat(32),
      '172.20.0.2',
      '172.20.0.1',
      sourcePath,
    )

    return script
  }

  test('is copied in by the host, as bytes', async () => {
    /*
     * The security property, not a convenience. The host has the clone
     * credential and a route to the instance; the guest has neither and must
     * keep having neither - the egress policy refuses the instance's own
     * addresses, so a guest could not clone even if it were handed a token.
     */
    expect(await overlayScript('/s/checkout-1')).toContain(`cp -a '/s/checkout-1'/. "$M/workspace/"`)
  })

  test('and lands as the workspace rather than one level inside it', async () => {
    /*
     * `/.` rather than the directory itself. Without it the tree arrives at
     * `/work/workspace/checkout-1`, every step's relative path is wrong, and the
     * failure reads as "my files are missing" rather than as a copy written one
     * level off.
     */
    const script = await overlayScript('/s/checkout-1')

    expect(script).toContain('/. "$M/workspace/"')
    expect(script).not.toContain(`cp -a '/s/checkout-1' "$M/workspace/"`)
  })

  test('preserving modes, because the executable bit is the build', async () => {
    // A checked-in script that arrives without its executable bit is a step that
    // says "permission denied" for no visible reason.
    expect(await overlayScript('/s/checkout-1')).toContain('cp -a')
  })

  test('and a job that asked for no checkout gets no workspace copy at all', async () => {
    const script = await overlayScript(undefined)

    expect(script).not.toContain('cp -a')
    // The directory still exists, so the agent's `cd` succeeds either way.
    expect(script).toContain('"$M/workspace"')
  })

  test('and the payload disk still carries the steps and the nonce', async () => {
    const script = await overlayScript('/s/checkout-1')

    expect(script).toContain('"$M/steps/0.sh"')
    expect(script).toContain('"$M/nonce"')
  })
})

describe('a payload disk that could not be made', () => {
  test('is still cleaned up, and with privilege', async () => {
    /*
     * A regression from a host whose disk filled mid-run. `mkfs` failed partway
     * and left a root-owned gigabyte behind, and it survived teardown for two
     * compounding reasons: the cleanup was registered only *after* a successful
     * creation, so a partial disk was never registered at all - and the file it
     * left could not have been removed by the unprivileged process anyway,
     * because the chown that hands ownership over is the last line of a script
     * that had already failed.
     *
     * So the undo is armed before the attempt and goes through the privileged
     * path. Both halves are asserted here because either alone leaves the leak.
     */
    const { superviseJob } = await import('../../app/Actions/Runner/microvmSupervisor')
    const { machineSpec } = await import('../../app/Actions/Runner/microvm')

    const ran: string[][] = []

    const outcome = await superviseJob({
      spec: machineSpec({
        jobId: 5,
        imagePath: '/i',
        imageDigest: `sha256:${'a'.repeat(64)}`,
        kernelPath: '/k',
        overlayPath: '/s/job-5.ext4',
        policy: { mode: 'deny', rules: [], privateAllowed: false },
      }),
      steps: [{ run: 'true' }],
      host: {
        firecracker: '/x',
        scratch: '/s',
        hostAddress: '172.20.0.1',
        guestAddress: '172.20.0.2',
        privileged: async (argv) => {
          ran.push([...argv])

          // The disk is full: creation fails the way it did in the incident.
          return argv[0] === 'sh'
            ? { ok: false, output: 'dd: error writing: No space left on device' }
            : { ok: true, output: '' }
        },
      },
    })

    expect(outcome.ok).toBe(false)
    expect(outcome.reason).toContain('No space left')

    // The partial disk was removed, and by the privileged path.
    expect(ran.some(argv => argv[0] === 'rm' && argv.includes('/s/job-5.ext4'))).toBe(true)
  })

  test('and nothing later is set up after it fails', async () => {
    /*
     * A tap device and a filter table for a machine that will never boot are two
     * more things to leak. The order is: make the disk, then the network - so a
     * disk that failed stops before either exists.
     */
    const { superviseJob } = await import('../../app/Actions/Runner/microvmSupervisor')
    const { machineSpec } = await import('../../app/Actions/Runner/microvm')

    const ran: string[][] = []

    await superviseJob({
      spec: machineSpec({
        jobId: 6,
        imagePath: '/i',
        imageDigest: `sha256:${'a'.repeat(64)}`,
        kernelPath: '/k',
        overlayPath: '/s/job-6.ext4',
        policy: { mode: 'deny', rules: [], privateAllowed: false },
      }),
      steps: [{ run: 'true' }],
      host: {
        firecracker: '/x',
        scratch: '/s',
        hostAddress: '172.20.0.1',
        guestAddress: '172.20.0.2',
        privileged: async (argv) => {
          ran.push([...argv])
          return argv[0] === 'sh' && String(argv[2]).includes('mkfs')
            ? { ok: false, output: 'no space' }
            : { ok: true, output: '' }
        },
      },
    })

    expect(ran.some(argv => String(argv[2] ?? '').includes('ip tuntap add'))).toBe(false)
    expect(ran.some(argv => argv[0] === 'nft' && argv[1] === '-f')).toBe(false)
  })
})

describe('the address a guest is given', () => {
  test('is told to it, because every filter rule is anchored to it', async () => {
    /*
     * A guest that chose its own address would be a guest choosing which rules
     * apply to it: the ruleset says `ip saddr <guest>`, and a machine calling
     * itself something else matches none of it.
     */
    const { makeOverlay } = await import('../../app/Actions/Runner/microvmSupervisor')

    let script = ''

    await makeOverlay(
      {
        firecracker: '/x', scratch: '/s', hostAddress: '172.20.0.1', guestAddress: '172.20.0.2',
        privileged: async (argv) => { script = String(argv[2] ?? ''); return { ok: true, output: '' } },
      },
      '/s/job-1.ext4', 64, [{ run: 'echo hi' }], 'n'.repeat(32), '172.20.0.2', '172.20.0.1',
    )

    expect(script).toContain(`'172.20.0.2/30' '172.20.0.1' > "$M/net"`)
  })

  test('and the guest brings its interface up from it', async () => {
    /*
     * The defect this exists to stop coming back. The machine had a tap, a MAC
     * and a filter, and no address - so every destination was unreachable and
     * the first egress suite passed on a machine with no egress, which reads
     * exactly like the policy working.
     */
    const { guestAgent } = await import('../../app/Actions/Runner/microvmProtocol')

    expect(guestAgent()).toContain('/work/net')
    expect(guestAgent()).toContain('ip link set eth0 up')
    expect(guestAgent()).toContain('ip route add default via')
  })
})

describe('a runner whose image is not the one it was told to boot', () => {
  test('fails the job rather than running it', async () => {
    /*
     * The check that was missing entirely: the pinned digest was a string in a
     * configuration file that the runner never compared to the file it booted, so
     * it could boot one image and report another with nothing noticing.
     *
     * A job that ran anyway would record a digest that did not execute it - worse
     * than recording nothing, because it is checkable and wrong.
     */
    await withEnv(
      { ...CONFIGURED, REVIEWOS_GUEST_IMAGE_DIGEST: `sha256:${'0'.repeat(64)}` },
      async () => {
        const outcome = await runJobInMachine({
          job: { id: 3, steps: [{ run: 'true' }] },
          onOutput: async () => {},
          supervise: async () => {
            throw new Error('the machine must not be built when the pin does not match')
          },
        })

        expect(outcome.state).toBe('failed')
        expect(outcome.reason).toContain('not the')
      },
    )
  })
})

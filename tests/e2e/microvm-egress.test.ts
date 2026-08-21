// The two gates that needed a booted guest.
//
// The threat model's list has eight adversarial tests. Six were answerable from
// the control plane; these two were not, because "a job cannot reach the
// database, Redis, repository storage, or loopback" and "a job cannot reach the
// cloud metadata endpoint" are claims about packets, and until there was a
// machine to send them from there was nothing to attack.
//
// `runner-network-policy.test.ts` covers the rules. This covers the packets, and
// the difference is the whole point: a rule that refuses `169.254.169.254` is not
// the same achievement as a guest failing to reach it, and a ruleset can be
// perfectly correct and never applied.
//
// **Skips unless the machine can actually do it**, which is most machines: it
// needs KVM, Firecracker, a guest image and a kernel. That is the same shape
// `keys-gpg.test.ts` uses - a test nobody can run is worse than one that says
// why it did not.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'

const FIXTURE = 'tests/fixtures/microvm/egress-fixture.sh'

/** What a guest must never reach, and the one thing it may. */
const METADATA = '169.254.169.254'
const REGISTRY = '198.51.100.10'

let ready = false
let why = ''

async function run(argv: string[], input?: string) {
  const child = Bun.spawn(argv, {
    stdin: input === undefined ? 'ignore' : new TextEncoder().encode(input),
    stdout: 'pipe',
    stderr: 'pipe',
  })

  const out = await new Response(child.stdout).text()
  const err = await new Response(child.stderr).text()

  return { ok: (await child.exited) === 0, output: `${out}${err}` }
}

beforeAll(async () => {
  const missing: string[] = []

  if (!existsSync('/dev/kvm'))
    missing.push('no /dev/kvm')

  if (!existsSync(process.env.REVIEWOS_FIRECRACKER ?? '/usr/local/bin/firecracker'))
    missing.push('no firecracker')

  for (const name of ['REVIEWOS_GUEST_KERNEL', 'REVIEWOS_GUEST_IMAGE', 'REVIEWOS_GUEST_IMAGE_DIGEST']) {
    if (!process.env[name])
      missing.push(`${name} is not set`)
  }

  if (missing.length > 0) {
    why = missing.join(', ')
    console.warn(`[microvm-egress] skipping: ${why}`)

    return
  }

  const built = await run(['sudo', '-n', 'sh', FIXTURE])

  if (!built.ok) {
    why = `the fixture could not be built: ${built.output.slice(0, 200)}`
    console.warn(`[microvm-egress] skipping: ${why}`)

    return
  }

  ready = true
}, 300_000)

afterAll(async () => {
  if (ready)
    await run(['sudo', '-n', 'ip', 'netns', 'delete', 'rvos-egress']).catch(() => null)
})

/** Run one job in a machine and hand back everything it printed. */
async function probe(steps: { run: string }[], egress: string[] = []) {
  const before = process.env.REVIEWOS_EGRESS_ALLOW

  process.env.REVIEWOS_EGRESS_ALLOW = egress.join(',')

  try {
    const { runJobInMachine } = await import('../../app/Actions/Runner/microvmRun')

    let text = ''

    const outcome = await runJobInMachine({
      job: {
        id: 900,
        timeout_minutes: 3,
        run: { trusted: false },
        repository_full_name: 'acme/egress',
        steps,
      },
      onOutput: async (piece) => { text += piece },
    })

    return { outcome, text }
  }
  finally {
    if (before === undefined)
      delete process.env.REVIEWOS_EGRESS_ALLOW
    else
      process.env.REVIEWOS_EGRESS_ALLOW = before
  }
}

/** One shell line that says whether a destination answered. */
function reach(label: string, address: string) {
  return { run: `if wget -T 5 -q -O - http://${address}/ 2>/dev/null | head -c 40 | grep -q .; then echo "REACHED_${label}"; else echo "BLOCKED_${label}"; fi` }
}

describe('a job in a machine', () => {
  test('the fixture is reachable from the host, so a block below means the policy', async () => {
    if (!ready)
      return

    /*
     * The control, and the reason this suite proves anything. On a machine with
     * no metadata endpoint, "the guest could not reach it" is true and empty.
     * Here the host reaches both destinations first.
     */
    const metadata = await run(['curl', '-s', '--max-time', '5', `http://${METADATA}/`])
    const registry = await run(['curl', '-s', '--max-time', '5', `http://${REGISTRY}/`])

    expect(metadata.output).toContain('METADATA-CREDENTIALS')
    expect(registry.output).toContain('REGISTRY-OK')
  }, 120_000)

  test('cannot reach the cloud metadata endpoint', async () => {
    if (!ready)
      return

    /*
     * The destination an operator writing an allowlist is not thinking about,
     * which hands out the machine's cloud credentials to anything that asks. The
     * registry is allowlisted in the same run, so this is a policy refusing one
     * destination rather than a guest with no network.
     */
    const { text, outcome } = await probe(
      [reach('METADATA', METADATA), reach('REGISTRY', REGISTRY)],
      [`${REGISTRY}:80`],
    )

    expect(outcome.state).toBe('succeeded')
    expect(text).toContain('BLOCKED_METADATA')
    expect(text).toContain('REACHED_REGISTRY')
    expect(text).not.toContain('METADATA-CREDENTIALS')
  }, 300_000)

  test('cannot reach the runner host it is running on', async () => {
    if (!ready)
      return

    /*
     * "Loopback is every service running on the runner host itself" - the
     * database, the queue, the repository storage, and the supervisor holding
     * this machine open. Reached over the tap, which is the only address the
     * guest has for the host, and refused by the `input` chain rather than the
     * `forward` one: a packet addressed to the host never reaches `forward` at
     * all, which is how a forward-only ruleset left all of it open.
     */
    const host = process.env.REVIEWOS_MICROVM_HOST_IP ?? '172.20.0.1'

    const { text } = await probe([reach('HOST', `${host}:80`), reach('HOST_ALT', `${host}:5432`)])

    expect(text).toContain('BLOCKED_HOST')
    expect(text).toContain('BLOCKED_HOST_ALT')
  }, 300_000)

  test('and cannot reach an instance address the operator declared', async () => {
    if (!ready)
      return

    /*
     * The registry is a perfectly ordinary destination until an operator says it
     * is where the instance lives, at which point no allowlist may name it - a
     * job that can reach the control plane has escaped without escaping.
     */
    const before = process.env.REVIEWOS_INSTANCE_ADDRESSES

    process.env.REVIEWOS_INSTANCE_ADDRESSES = REGISTRY

    try {
      const { outcome } = await probe([reach('INSTANCE', REGISTRY)], [`${REGISTRY}:80`])

      /*
       * Refused before the machine boots, which is stronger than blocking the
       * packet: the operator wrote a rule naming their own instance and the job
       * fails saying so, rather than running against a quietly shorter
       * allowlist.
       */
      expect(outcome.state).toBe('failed')
      expect(outcome.reason).toContain(REGISTRY)
    }
    finally {
      if (before === undefined)
        delete process.env.REVIEWOS_INSTANCE_ADDRESSES
      else
        process.env.REVIEWOS_INSTANCE_ADDRESSES = before
    }
  }, 300_000)

  test('and reaches nothing at all when no allowlist was written', async () => {
    if (!ready)
      return

    // The default an operator gets by doing nothing.
    const { text } = await probe([reach('REGISTRY', REGISTRY)])

    expect(text).toContain('BLOCKED_REGISTRY')
  }, 300_000)
})

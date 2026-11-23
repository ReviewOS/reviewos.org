/**
 * The memory a step's processes may hold, enforced where the kernel counts it.
 *
 * A step runs in a transient systemd user scope with `MemoryMax=` (and
 * `MemorySwapMax=0` where swap is accounted), so the cgroup's `memory.max` is
 * the ceiling. A job that runs away is killed by the kernel inside its own
 * scope: the runner, the forge and anything else on the box keep their memory,
 * which is what the ceiling was always for - a job must not be able to take
 * the machine down.
 *
 * This replaced `ulimit -v` (RLIMIT_AS), which bounded address space instead of
 * memory. That broke ThreadSanitizer outright ("setrlimit() failed" on the
 * owned Linux executor), and AddressSanitizer, Go and every JIT that reserves
 * a large range it never touches, while not stopping a job from filling RAM
 * with pages it does touch. See `limits.ts`.
 *
 * ## Why a scope per step, from the runner
 *
 * The runner is a systemd *user* service on every Linux machine it is
 * installed on, and systemd's own `user@.service` delegates the memory
 * controller to the user manager, so an unprivileged runner can create a scope
 * with a memory limit and nothing about the box's own unit has to change. The
 * probe below checks that rather than assuming it. `systemd-run --scope` execs the step in place: same pid, same
 * process group, still the runner's child, so output, timeouts and the orphan
 * sweep work exactly as before.
 *
 * ## Fails open, and says so
 *
 * Asked once per runner process: a scope is started and asked what
 * `memory.max` it got. Only a scope that reports the limit it asked for is
 * trusted, because a user manager without the memory controller accepts the
 * property and enforces nothing. Anywhere else - macOS, a container, a host
 * without systemd or without delegation - steps run as before, unbounded, and
 * the runner logs why once. A runner that refused to build because it could
 * not apply a ceiling is a runner nobody keeps installed.
 */

import process from 'node:process'

/** What a step's scope is given: its limit, whether swap is held to zero too, and the systemd-run that makes it. */
export interface MemoryScope {
  memoryMb: number
  swap: boolean
  /**
   * `systemd-run` as an absolute path, found on the runner's own PATH.
   *
   * Never the bare name: the step is spawned with the job's environment, and a
   * bare argv[0] is resolved through *that* PATH. A job whose `env:` set PATH
   * to its own directory failed every step with nothing to run, and a job could
   * have put an executable of its own called `systemd-run` there instead.
   */
  binary: string
}

const SCOPE = ['--user', '--scope', '--quiet', '--collect']

/** The variables `systemd-run --user` finds the user manager by. */
const MANAGER_VARIABLES = ['XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS']

/** A step's argv inside its scope, or unchanged when there is no bound. */
export function boundedArgv(argv: readonly string[], scope: MemoryScope | null): string[] {
  if (!scope || scope.memoryMb <= 0)
    return [...argv]

  return [
    scope.binary,
    ...SCOPE,
    `--property=MemoryMax=${scope.memoryMb}M`,
    ...(scope.swap ? ['--property=MemorySwapMax=0'] : []),
    '--',
    ...argv,
  ]
}

/**
 * The step's environment, with what `systemd-run --user` needs to reach the
 * user manager borrowed from the runner when the job does not set it.
 * `systemd-run --scope` execs the step with this environment, so only the two
 * addresses are added, and a job's own values win.
 */
export function scopeEnvironment(
  environment: Record<string, string>,
  runner: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const merged = { ...environment }

  for (const name of MANAGER_VARIABLES) {
    if (merged[name] === undefined && runner[name])
      merged[name] = String(runner[name])
  }

  return merged
}

/** `systemd-run` on the runner's PATH, as an absolute path, or null. */
export function scopeBinary(path: string | undefined = process.env.PATH): string | null {
  const found = Bun.which('systemd-run', { PATH: path ?? '' })

  return found && found.startsWith('/') ? found : null
}

/** The probe: a 64 MiB scope that prints the `memory.max` the kernel gave it. */
export function probeCommand(swap: boolean, binary: string): string[] {
  return boundedArgv(
    ['/bin/sh', '-c', 'cat "/sys/fs/cgroup$(sed -n \'s/^0:://p\' /proc/self/cgroup)/memory.max"'],
    { memoryMb: 64, swap, binary },
  )
}

/** Whether a probe's scope really holds the 64 MiB it asked for. */
export function readProbe(result: { code: number, stdout: string }): boolean {
  return result.code === 0 && result.stdout.trim() === String(64 * 1_048_576)
}

let probed: Promise<{ swap: boolean, binary: string } | null> | null = null

/**
 * The scope to run a step in, for a step allowed `memoryMb`, or null when this
 * machine cannot enforce one. The probe runs once per runner process.
 */
export async function memoryScope(memoryMb: number): Promise<MemoryScope | null> {
  if (memoryMb <= 0 || process.platform !== 'linux')
    return null

  probed ??= probe()
  const support = await probed

  return support ? { memoryMb, swap: support.swap, binary: support.binary } : null
}

async function probe(): Promise<{ swap: boolean, binary: string } | null> {
  const binary = scopeBinary()

  // With swap held to zero first, which makes the bound strict; then without,
  // for a kernel booted without swap accounting.
  for (const swap of [true, false]) {
    if (binary && readProbe(await run(probeCommand(swap, binary))))
      return { swap, binary }
  }

  console.warn('[runner] steps run without a memory bound: no systemd user scope here enforces MemoryMax (needs systemd with the memory controller delegated to the user manager).')

  return null
}

async function run(argv: string[]): Promise<{ code: number, stdout: string }> {
  try {
    const child = Bun.spawn(argv, {
      env: scopeEnvironment({ PATH: process.env.PATH ?? '/usr/bin:/bin' }),
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'ignore',
      signal: AbortSignal.timeout(10_000),
    })
    const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited])

    return { code, stdout }
  }
  catch {
    // No systemd-run at all.
    return { code: -1, stdout: '' }
  }
}

/**
 * Ceilings a step cannot raise, applied before its first instruction.
 *
 * The honest scope first: **this is not isolation.** A step still runs as
 * ordinary processes on the host, and the sandbox that would change that is the
 * work the [security review](../../../docs/ci-security-review.md) gates. What
 * this stops is the ordinary accident - a test that forks until the box stops
 * answering, a loop that writes a 40GB file, a build that spins a core forever
 * after everything else has finished with it.
 *
 * Those are not attacks and they are what actually happens. A single-tenant
 * runner with no limits is one bad `while true` away from taking the forge down
 * with it, and the person who wrote the loop is on the same team as the person
 * whose review is now unreachable.
 *
 * ## Why `ulimit` and not something better
 *
 * Because it is the one mechanism that exists on both platforms this runner is
 * installed on. cgroups would be stronger and is Linux; a job object would be
 * stronger and is Windows. `ulimit` is POSIX, it is applied by the shell that
 * already wraps the command, and it is inherited by everything the step spawns -
 * which is the property that matters, since the fork bomb is never the first
 * process.
 *
 * **A step cannot raise what it was given.** Lowering a soft limit is allowed to
 * any process; raising it past the hard limit is not, and these set both.
 *
 * ## Every limit fails open
 *
 * A `ulimit` the platform does not support must not fail the step. macOS accepts
 * `-v` and ignores it; some shells refuse `-u` inside a container that already
 * capped it. Each is written `|| true`, because a runner that refuses to start a
 * build over a limit it could not apply is a runner nobody keeps installed - and
 * the limit that did apply is still applied.
 */

/** What a step may not exceed. Zero anywhere means "no ceiling from us". */
export interface StepLimits {
  /** Address space, in megabytes. Ignored on macOS, which accepts it and does nothing. */
  memoryMb: number
  /**
   * Processes, which is the one that must be opted into.
   *
   * `RLIMIT_NPROC` counts every process the **user** owns, not the ones this
   * step started - so on a machine where the runner shares a user with anything
   * else, a generous-looking number is already spent before the first step
   * runs. Turning it on by default made `/bin/sh: fork: Resource temporarily
   * unavailable` the second line of every build here, which is how this comment
   * came to exist.
   *
   * Worth setting on a machine dedicated to the runner, where it is the only
   * thing that bounds a fork bomb. Worth leaving alone anywhere else.
   */
  processes: number
  /** The largest file a step may write, in megabytes. */
  fileSizeMb: number
  /** CPU seconds, which bounds a spin that a wall-clock timeout would wait out. */
  cpuSeconds: number
}

/**
 * The defaults, which are generous on purpose: a limit that trips on ordinary
 * work is one an operator removes, and a removed limit protects nothing.
 */
export function limitsFrom(env: Record<string, string | undefined> = process.env): StepLimits {
  return {
    memoryMb: positive(env.CI_STEP_MEMORY_MB, 4096),
    // Off by default: see the note on the field. A per-user ceiling applied to
    // a build counts everything else the user is doing.
    processes: positive(env.CI_STEP_PROCESSES, 0),
    fileSizeMb: positive(env.CI_STEP_FILE_SIZE_MB, 4096),
    // Zero by default: CPU seconds and wall time bound different things, and a
    // build that legitimately uses eight cores for two minutes has spent
    // sixteen CPU minutes without being slow. An operator who wants this knows
    // their workload.
    cpuSeconds: positive(env.CI_STEP_CPU_SECONDS, 0),
  }
}

function positive(value: string | undefined, fallback: number): number {
  const raw = Number(value ?? Number.NaN)

  if (Number.isFinite(raw) && raw === 0)
    return 0

  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback
}

/**
 * The `ulimit` lines that go before a step's command.
 *
 * Empty when nothing is limited, so a shell invocation is unchanged for an
 * operator who turned everything off - a prelude of nothing but `true` would be
 * a diff in every log for no reason.
 *
 * **Neither `-S` nor `-H` is passed, and that is the whole point.** A `ulimit`
 * with no flag sets both the soft and the hard limit, which is what stops a
 * step raising its own ceiling back. Saying `-S -H` in one call means the same
 * thing in bash and zsh - and on dash, which is `/bin/sh` on Ubuntu and so on
 * every Linux runner and on the box, it is **accepted and does nothing**:
 *
 *     $ /bin/sh -c 'ulimit -S -H -f 1024; ulimit -f'
 *     unlimited
 *
 * No error, no diagnostic, and `2>/dev/null || true` below would have hidden
 * one anyway. Every ceiling in this file was inert on Linux and enforced on a
 * developer's Mac, which is the wrong way round. `tests/unit/runner-limits.test.ts`
 * runs a step that tries to exceed its limit rather than asserting the string,
 * and that is what caught it.
 *
 * Setting them one at a time does not work either: the hard limit cannot be
 * lowered past a soft limit that is still `unlimited`, so `ulimit -H -f 1024`
 * on a fresh shell is `error setting limit (Invalid argument)`. Both at once,
 * in the one form every shell agrees on.
 */
export function limitPrelude(limits: StepLimits): string {
  const lines: string[] = []

  // Blocks of 1024 bytes for `-f`, kilobytes for `-v`: both are historical and
  // both are what every shell means by those flags.
  if (limits.memoryMb > 0)
    lines.push(`ulimit -v ${limits.memoryMb * 1024} 2>/dev/null || true`)

  if (limits.processes > 0)
    lines.push(`ulimit -u ${limits.processes} 2>/dev/null || true`)

  if (limits.fileSizeMb > 0)
    lines.push(`ulimit -f ${limits.fileSizeMb * 1024} 2>/dev/null || true`)

  if (limits.cpuSeconds > 0)
    lines.push(`ulimit -t ${limits.cpuSeconds} 2>/dev/null || true`)

  return lines.length > 0 ? `${lines.join('\n')}\n` : ''
}

/**
 * A command with its ceilings in front of it.
 *
 * For the `run:` path, which already goes through `sh -c` - so this changes what
 * that shell is asked to do rather than adding a process.
 */
export function limitedCommand(command: string, limits: StepLimits): string {
  const prelude = limitPrelude(limits)

  return prelude ? `${prelude}${command}` : command
}

/**
 * And the argv path, which deliberately has no shell.
 *
 * A `uses:` step's arguments come off a workflow file, and putting them through
 * a shell would mean quoting them correctly forever. So the shell is introduced
 * *around* the limits and the program is handed to `exec` as positional
 * arguments, which never passes them through word splitting: `sh -c '<limits>;
 * exec "$@"' sh prog arg1 arg2`.
 *
 * `exec` matters. Without it the shell stays alive as the parent of the step,
 * which changes what a signal reaches and adds a process to the count the limit
 * above just set.
 */
export function limitedArgv(argv: readonly string[], limits: StepLimits): string[] {
  const prelude = limitPrelude(limits)

  if (!prelude || argv.length === 0)
    return [...argv]

  return ['/bin/sh', '-c', `${prelude}exec "$@"`, 'sh', ...argv]
}

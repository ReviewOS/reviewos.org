/**
 * The runner's extension points: hooks around a job, and around the runner.
 *
 * Buildkite's hook set, copied deliberately rather than invented, because each
 * entry solves a problem people have and the names are ones operators already
 * know. A fleet that must inject a proxy, warm a cache, wrap every command in a
 * profiler, or refuse work it should not run cannot say any of that in a
 * workflow file - the workflow is written by the repository, and these are the
 * machine's business.
 *
 * **Two scopes, and the difference is who wrote them.**
 *
 * - **Runner hooks** live on the machine, outside repository control. An
 *   operator put them there.
 * - **Repository hooks** live in the checkout, in `.reviewos/hooks/`. Anybody
 *   who can push to the repository wrote them, which is the same trust as the
 *   steps themselves - and no more.
 *
 * The precedence follows from that: for a stage that *decides* something -
 * `pre-bootstrap`, `checkout`, `command` - the runner's hook wins outright and
 * the repository's is not consulted. For the rest both run, the runner's first.
 * A repository hook that could replace a runner hook would make the runner
 * scope decorative, and the whole point of `pre-bootstrap` is that a repository
 * cannot reach it.
 *
 * **Plugin hooks are the third scope**, and they slot between the two above:
 * after the machine's own, before the repository's. A plugin is named by a
 * workflow file or attached to a pool, so it is trusted more than the steps -
 * an operator or an author chose it deliberately, at a commit - and less than
 * the machine, which is why it cannot take part in the deciding stages either.
 */

import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Every stage, in the order it happens.
 *
 * `pre-exit` is last and runs whatever happened, which is what makes it the
 * place to tear down a container or unmount a cache.
 */
export const HOOK_STAGES = [
  'pre-bootstrap',
  'environment',
  'pre-checkout',
  'checkout',
  'post-checkout',
  'pre-command',
  'command',
  'post-command',
  'pre-artifact',
  'post-artifact',
  'pre-exit',
] as const

export type HookStage = typeof HOOK_STAGES[number]

/** The runner's own lifecycle, either side of the poll loop. */
export const FLEET_STAGES = ['runner-startup', 'runner-shutdown'] as const

export type FleetStage = typeof FLEET_STAGES[number]

/**
 * Stages the repository may not take part in.
 *
 * `pre-bootstrap` is the refusal point: it runs before any repository code is
 * fetched, which is the only moment a decision about whether to run this
 * repository's code can be made without having already read it. A repository
 * hook there would be the code deciding whether to trust itself.
 *
 * `checkout` and `command` are *replacements* rather than additions. A
 * repository that could replace the command would not be running its own steps
 * any more, and a fleet that wraps every command in a profiler would find the
 * wrapper quietly removed by one repository.
 */
export const RUNNER_ONLY: readonly HookStage[] = ['pre-bootstrap', 'checkout', 'command']

/** A hook that will run: which stage, which file, and who wrote it. */
export interface ResolvedHook {
  stage: HookStage | FleetStage
  path: string
  scope: 'runner' | 'plugin' | 'repository'
  /** For a plugin hook, which plugin - it names the group in the log. */
  plugin?: string
  /** For a plugin hook, its parameters as environment. */
  environment?: Record<string, string>
}

/** A plugin as the runner has it on disk: a directory of hook scripts. */
export interface InstalledPlugin {
  name: string
  directory: string
  environment: Record<string, string>
}

/**
 * The hooks that run for one stage, in order.
 *
 * Both scopes for an ordinary stage, the runner's first; the runner's alone for
 * a stage in `RUNNER_ONLY`, and then only if it exists - a missing runner hook
 * for `checkout` or `command` means the built-in behaviour, not "nothing
 * happens".
 *
 * A file that is not executable is not a hook. That is not a tidiness rule: a
 * `README` dropped in a hooks directory would otherwise be run as a shell
 * script, and the failure would be reported as the job's.
 */
export function hooksFor(input: {
  stage: HookStage
  runnerDirectory?: string | null
  repositoryDirectory?: string | null
  plugins?: readonly InstalledPlugin[]
}): ResolvedHook[] {
  const found: ResolvedHook[] = []
  const runner = executableIn(input.runnerDirectory, input.stage)

  if (runner)
    found.push({ stage: input.stage, path: runner, scope: 'runner' })

  /*
   * A plugin cannot decide whether this repository's code runs, replace the
   * checkout, or replace the command, whoever attached it. Those three are the
   * machine's alone: a plugin that could take them over would make the runner
   * scope decorative for any fleet that uses plugins at all, which is most of
   * the fleets that would want either.
   */
  if (RUNNER_ONLY.includes(input.stage))
    return found

  for (const plugin of input.plugins ?? []) {
    const path = executableIn(plugin.directory, input.stage)

    if (path)
      found.push({ stage: input.stage, path, scope: 'plugin', plugin: plugin.name, environment: plugin.environment })
  }

  const repository = executableIn(input.repositoryDirectory, input.stage)

  if (repository)
    found.push({ stage: input.stage, path: repository, scope: 'repository' })

  return found
}

/** The runner's own lifecycle hook, which only ever has the runner's scope. */
export function fleetHook(runnerDirectory: string | null | undefined, stage: FleetStage): ResolvedHook | null {
  const path = executableIn(runnerDirectory, stage)

  return path ? { stage, path, scope: 'runner' } : null
}

/**
 * Whether a repository's hooks directory is allowed to matter at all.
 *
 * A fork's pull request is somebody else's code, and a hook is code that runs
 * *outside* the steps - before the checkout is even used, and after the job has
 * finished. This runner refuses untrusted runs outright, so this is a second
 * line rather than the only one, and it is here because the day the first line
 * is relaxed for a sandboxed runner, this must not be relaxed with it.
 */
export function repositoryHooksAllowed(job: any): boolean {
  return job?.run?.trusted !== false
}

/** An executable file for this stage, or null. */
function executableIn(directory: string | null | undefined, stage: string): string | null {
  if (!directory)
    return null

  const path = join(directory, stage)

  try {
    if (!existsSync(path))
      return null

    const stats = statSync(path)

    // Any execute bit. A hook nobody can execute is one the operator has not
    // finished installing, and running it through a shell anyway would hide
    // that from them.
    return stats.isFile() && (stats.mode & 0o111) !== 0 ? path : null
  }
  catch {
    return null
  }
}

/**
 * Everything a plugin reference has to survive before a job is created.
 *
 * Parse, resolve to a commit, read the manifest, check the parameters against
 * it, and check the reference against the policy. All of it here, at dispatch,
 * so a mistake is a red job with a sentence on it rather than a shell error
 * eleven minutes into a run from inside somebody else's hook.
 *
 * What is stored on the job is the *resolved* plugin: the commit, the
 * parameters as validated, the stages it hooks. The hook scripts themselves are
 * read again at claim, out of the same commit - bytes that cannot have changed,
 * without a copy of every plugin in every job row.
 */

import type { PluginPolicy } from './policy'
import { effectivePolicy, pluginVerdict } from './policy'
import { parameterEnvironment, validateParameters } from './manifest'
import { isProblem, parsePluginReference } from './reference'
import { resolvePlugin } from './resolve'

/** A plugin as stored on a job row, and as handed to a runner. */
export interface PreparedPlugin {
  reference: string
  kind: 'vendored' | 'repository'
  /** `owner/name`, or the vendored path. */
  source: string
  name: string
  /** The commit its files are read from. */
  sha: string
  /** The stages it ships a hook for. */
  hooks: string[]
  /** What it needs beyond an ordinary job, for the pool to allow or refuse. */
  requires: string[]
  /** Its parameters, validated and stringified, ready to be environment. */
  values: Record<string, string>
}

export type Preparation =
  | { ok: true, plugins: PreparedPlugin[] }
  | { ok: false, reason: string }

/**
 * Prepare the plugins one job asked for.
 *
 * The first failure wins and the rest are not reported, deliberately: these
 * arrive one job at a time and the message ends up on a job row, where a list
 * of five problems reads worse than the one that has to be fixed first.
 */
export async function preparePlugins(input: {
  /** The `plugins` entry of the job's stored settings, as the parser left it. */
  entries: Array<{ reference: string, parameters: Record<string, unknown> }>
  gitDir: string
  sha: string
  ownerType: string
  ownerId: number
  policies: readonly PluginPolicy[]
}): Promise<Preparation> {
  const plugins: PreparedPlugin[] = []
  const policy = effectivePolicy(input.policies)

  for (const entry of input.entries) {
    const reference = parsePluginReference(entry.reference)

    if (isProblem(reference))
      return { ok: false, reason: reference.reason }

    /*
     * The allowlist is checked *before* the repository is read: a plugin nobody
     * may use is not one this instance should be running git against on behalf
     * of whoever wrote the reference.
     *
     * The pinning rule is deliberately left out of this pass. A tag and a
     * branch are the same string in a workflow file, and only the resolution
     * below can tell which it was - so asking here would refuse every tag.
     */
    const allowed = pluginVerdict({ reference, policy: { ...policy, requirePinned: false } })

    if (!allowed.ok)
      return { ok: false, reason: allowed.reason }

    const resolution = await resolvePlugin({
      reference,
      gitDir: input.gitDir,
      sha: input.sha,
      ownerType: input.ownerType,
      ownerId: input.ownerId,
    })

    if (!resolution.ok)
      return { ok: false, reason: resolution.reason }

    const { plugin } = resolution

    // And again with what the resolution learned: whether the ref was a tag or
    // a branch, and what the manifest says the plugin needs.
    /*
     * Capabilities are deliberately *not* asked here.
     *
     * A capability is a statement about a machine - a docker socket, the host
     * network - and dispatch does not know which machine will take the job. If
     * this refused on the instance's behalf, a pool that grants a capability
     * could never receive a job that needs one, which would make the pool level
     * decorative. So the pinning rule and the allowlist are dispatch's, and the
     * capability is the pool's, at the claim.
     */
    const verdict = pluginVerdict({
      reference,
      policy,
      resolvedRef: plugin.refKind,
    })

    if (!verdict.ok)
      return { ok: false, reason: verdict.reason }

    const parameters = validateParameters(plugin.manifest, entry.parameters)

    if (!parameters.ok)
      return { ok: false, reason: parameters.errors.join('; ') }

    plugins.push({
      reference: reference.raw,
      kind: reference.kind,
      source: reference.source,
      name: plugin.manifest.name,
      sha: plugin.sha,
      hooks: Object.keys(plugin.hooks),
      requires: plugin.manifest.requires,
      values: parameters.values,
    })
  }

  return { ok: true, plugins }
}

/** The plugins stored on a job row, whatever shape the settings column is in. */
export function preparedPluginsOf(settings: unknown): PreparedPlugin[] {
  try {
    const parsed = typeof settings === 'string' ? JSON.parse(settings) : settings
    const plugins = (parsed as any)?.plugins

    if (!Array.isArray(plugins))
      return []

    // A job dispatched before this shipped carries the unresolved shape, which
    // has no `sha`. Ignoring it is right: there is nothing to run, and guessing
    // a commit for it would be running code nobody pinned.
    return plugins.filter((one: any) => one && typeof one === 'object' && typeof one.sha === 'string')
  }
  catch {
    return []
  }
}

/** The environment one plugin's hooks read their parameters from. */
export function environmentFor(plugin: PreparedPlugin): Record<string, string> {
  return {
    ...parameterEnvironment(plugin.name, plugin.values),
    REVIEWOS_PLUGIN_NAME: plugin.name,
    REVIEWOS_PLUGIN_REFERENCE: plugin.reference,
    REVIEWOS_PLUGIN_COMMIT: plugin.sha,
  }
}

/**
 * The hook scripts of one prepared plugin, read out of the commit it names.
 *
 * At claim rather than at dispatch, so a job row carries a reference and a
 * commit instead of a copy of every plugin it uses - and the bytes are the same
 * bytes either way, because the commit was fixed when the run was created.
 */
export async function hookScriptsFor(input: {
  plugin: PreparedPlugin
  /** The using repository's bare directory, for a vendored plugin. */
  gitDir: string
}): Promise<Record<string, string>> {
  const { runGit } = await import('../Git/git')
  const { repositoryPath } = await import('../Git/storage')

  let gitDir = input.gitDir
  let prefix = `${input.plugin.source}/`

  if (input.plugin.kind === 'repository') {
    const [handle = '', name = ''] = input.plugin.source.split('/')
    const located = repositoryPath(handle, name)

    if (!located.path)
      return {}

    gitDir = located.path
    prefix = ''
  }

  const scripts: Record<string, string> = {}

  for (const stage of input.plugin.hooks) {
    const result = await runGit(gitDir, ['show', `${input.plugin.sha}:${prefix}hooks/${stage}`], { timeoutMs: 15_000 }).catch(() => null)

    if (result?.code === 0)
      scripts[stage] = result.stdout
  }

  return scripts
}

/**
 * Whether the pool a machine is in permits these plugins.
 *
 * The half of the policy dispatch could not ask: which pool a job runs in is a
 * fact about the runner that claims it. A refusal here fails the job with the
 * reason rather than leaving it in the queue, because a job no machine in this
 * pool may run is not one to leave looking like work nobody has got to.
 */
export function poolVerdict(input: {
  plugins: readonly PreparedPlugin[]
  policy: PluginPolicy
}): { ok: true } | { ok: false, reason: string } {
  for (const plugin of input.plugins) {
    const reference = parsePluginReference(plugin.reference)

    if (isProblem(reference))
      return { ok: false, reason: reference.reason }

    const verdict = pluginVerdict({
      reference,
      policy: input.policy,
      requires: plugin.requires,
      // Resolved at dispatch and recorded as a commit, which is what the row
      // holds: by the time a machine claims the job there is no tag left to
      // ask about.
      resolvedRef: 'commit',
    })

    if (!verdict.ok)
      return verdict
  }

  return { ok: true }
}

/**
 * The plugins attached to a pool, resolved for a job about to run in it.
 *
 * This is the half a workflow file cannot express: a fleet that has to wrap
 * every command in a profiler, or mount a cache, or refuse work on a machine
 * that is low on disk, without that being written into four hundred workflow
 * files and without a repository being able to remove it.
 *
 * Resolved at claim rather than at dispatch, because the pool is not known
 * until a machine takes the job - and because an operator who attaches a plugin
 * expects the jobs already queued to get it.
 */
export async function poolPlugins(poolId: number | null | undefined): Promise<Preparation> {
  if (!poolId)
    return { ok: true, plugins: [] }

  const { db } = await import('@stacksjs/database')

  const pool: any = await db
    .selectFrom('runner_pools')
    .select(['plugins'])
    .where('id', '=', Number(poolId))
    .executeTakeFirst()
    .catch(() => null)

  const references = String(pool?.plugins ?? '')
    .split('\n')
    .map(one => one.trim())
    .filter(one => one.length > 0)

  if (references.length === 0)
    return { ok: true, plugins: [] }

  const plugins: PreparedPlugin[] = []

  for (const raw of references) {
    const reference = parsePluginReference(raw)

    if (isProblem(reference))
      return { ok: false, reason: `this pool attaches ${reference.reason}` }

    if (reference.kind === 'vendored')
      return { ok: false, reason: `this pool attaches \`${raw}\`, and a vendored plugin belongs to one repository rather than to a pool` }

    const resolution = await resolvePlugin({
      reference,
      gitDir: '',
      sha: '',
      ownerType: '',
      ownerId: 0,
      /*
       * The visibility rule is skipped here, deliberately. It exists to stop a
       * workflow reading a private repository by referencing it as a plugin -
       * and there is no workflow here: an operator attached this to their own
       * pool, which is the same act as putting a hook on the machine.
       */
      operatorAttached: true,
    })

    if (!resolution.ok)
      return { ok: false, reason: `this pool attaches ${resolution.reason}` }

    /*
     * An attached plugin takes no parameters, so one that declares a required
     * parameter cannot be attached. Said plainly rather than run with an empty
     * value, which is how a profiler ends up writing to `/`.
     */
    const parameters = validateParameters(resolution.plugin.manifest, {})

    if (!parameters.ok)
      return { ok: false, reason: `this pool attaches \`${raw}\`, which needs parameters a pool cannot give it: ${parameters.errors.join('; ')}` }

    plugins.push({
      reference: reference.raw,
      kind: 'repository',
      source: reference.source,
      name: resolution.plugin.manifest.name,
      sha: resolution.plugin.sha,
      hooks: Object.keys(resolution.plugin.hooks),
      requires: resolution.plugin.manifest.requires,
      values: parameters.values,
    })
  }

  return { ok: true, plugins }
}

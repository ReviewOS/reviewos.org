/**
 * A plugin's declaration of itself: what it hooks, what it needs, and what it
 * takes.
 *
 * `plugin.yml` at the plugin's root, and the parameters in it are the point.
 * **They are checked before dispatch rather than by the plugin at runtime**,
 * which is the difference between "you misspelled `registry`" on the screen
 * where somebody wrote it and a job that fails eleven minutes in with an
 * unhelpful shell error from inside somebody else's hook.
 */

import { HOOK_STAGES } from '../Runner/hooks'

export type ParameterType = 'string' | 'number' | 'boolean'

export interface ParameterDeclaration {
  type: ParameterType
  required: boolean
  default: string | number | boolean | null
  /** The permitted values, when the plugin declares a closed set. */
  enum: Array<string | number> | null
  description: string | null
}

export interface PluginManifest {
  name: string
  description: string | null
  /** The stages this plugin has a hook for. */
  hooks: string[]
  /**
   * What this plugin needs beyond an ordinary job: a docker socket, the host
   * network, privileged containers. Declared by the plugin and refused by the
   * pool, rather than discovered when a hook quietly succeeds at something the
   * operator would not have allowed.
   */
  requires: string[]
  parameters: Record<string, ParameterDeclaration>
}

/** Capabilities a plugin may declare, and a pool may permit. */
export const CAPABILITIES = ['docker-socket', 'host-network', 'privileged', 'host-mounts'] as const

export type Capability = typeof CAPABILITIES[number]

export const MAX_MANIFEST_BYTES = 64 * 1024

/**
 * Parse a manifest.
 *
 * Every failure is a sentence about the plugin rather than about YAML, because
 * the person reading it is usually not the plugin's author - they wrote one
 * line in a workflow file and got told something they did not write is wrong.
 */
export function parseManifest(source: string, fallbackName = ''): { manifest: PluginManifest } | { error: string } {
  if (source.length > MAX_MANIFEST_BYTES)
    return { error: `plugin.yml is larger than ${MAX_MANIFEST_BYTES} bytes` }

  let document: any

  try {
    document = Bun.YAML.parse(source)
  }
  catch (error) {
    return { error: `plugin.yml is not valid YAML: ${error instanceof Error ? error.message : String(error)}` }
  }

  if (!document || typeof document !== 'object' || Array.isArray(document))
    return { error: 'plugin.yml is a mapping' }

  const hooks = Array.isArray(document.hooks) ? document.hooks.map((one: unknown) => String(one)) : []
  const unknown = hooks.filter((stage: string) => !(HOOK_STAGES as readonly string[]).includes(stage))

  if (unknown.length > 0)
    return { error: `plugin.yml names a hook this runner has no stage for: ${unknown.join(', ')}` }

  const requires = Array.isArray(document.requires) ? document.requires.map((one: unknown) => String(one)) : []
  const unknownCapability = requires.filter((one: string) => !(CAPABILITIES as readonly string[]).includes(one))

  if (unknownCapability.length > 0)
    return { error: `plugin.yml requires a capability this instance does not define: ${unknownCapability.join(', ')}` }

  const parameters: Record<string, ParameterDeclaration> = {}
  const declared = document.parameters

  if (declared !== null && declared !== undefined) {
    if (typeof declared !== 'object' || Array.isArray(declared))
      return { error: 'plugin.yml `parameters:` is a mapping of name to declaration' }

    for (const [name, raw] of Object.entries(declared as Record<string, any>)) {
      if (!/^[A-Z_a-z]\w*$/.test(name))
        return { error: `plugin.yml declares a parameter named \`${name}\`, which cannot become an environment variable` }

      // A bare `type` string is the common case, and writing `registry: string`
      // rather than `registry: { type: string }` is what people try first.
      const declaration = typeof raw === 'string' ? { type: raw } : raw

      if (!declaration || typeof declaration !== 'object' || Array.isArray(declaration))
        return { error: `plugin.yml parameter \`${name}\` is a type or a declaration` }

      const type = String(declaration.type ?? 'string')

      if (!['string', 'number', 'boolean'].includes(type))
        return { error: `plugin.yml parameter \`${name}\` has type \`${type}\`, which is not string, number or boolean` }

      parameters[name] = {
        type: type as ParameterType,
        required: declaration.required === true,
        default: declaration.default === undefined ? null : declaration.default,
        enum: Array.isArray(declaration.enum) ? declaration.enum : null,
        description: declaration.description ? String(declaration.description) : null,
      }
    }
  }

  const name = String(document.name ?? fallbackName ?? '').trim()

  if (!name)
    return { error: 'plugin.yml has no `name`' }

  return {
    manifest: {
      name,
      description: document.description ? String(document.description) : null,
      hooks,
      requires,
      parameters,
    },
  }
}

/**
 * Check what a workflow passed against what the plugin declared.
 *
 * Unknown parameters are an error rather than a warning, and that is the
 * decision worth defending: the failure this catches is a typo, and a typo
 * silently ignored is a plugin that runs with its default while somebody reads
 * the line they wrote and believes it took effect.
 */
export function validateParameters(
  manifest: PluginManifest,
  given: Record<string, unknown>,
): { ok: true, values: Record<string, string> } | { ok: false, errors: string[] } {
  const errors: string[] = []
  const values: Record<string, string> = {}

  for (const name of Object.keys(given)) {
    if (!(name in manifest.parameters))
      errors.push(`\`${manifest.name}\` has no parameter \`${name}\``)
  }

  for (const [name, declaration] of Object.entries(manifest.parameters)) {
    const supplied = given[name]
    const value = supplied === undefined || supplied === null ? declaration.default : supplied

    if (value === null || value === undefined) {
      if (declaration.required)
        errors.push(`\`${manifest.name}\` needs \`${name}\``)

      continue
    }

    if (declaration.type === 'number' && typeof value !== 'number')
      errors.push(`\`${manifest.name}.${name}\` is a number`)

    if (declaration.type === 'boolean' && typeof value !== 'boolean')
      errors.push(`\`${manifest.name}.${name}\` is true or false`)

    if (declaration.type === 'string' && typeof value === 'object')
      errors.push(`\`${manifest.name}.${name}\` is a string`)

    if (declaration.enum && !declaration.enum.some(one => String(one) === String(value)))
      errors.push(`\`${manifest.name}.${name}\` is one of ${declaration.enum.join(', ')}`)

    values[name] = String(value)
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, values }
}

/**
 * The environment a plugin's hooks read its parameters from.
 *
 * Namespaced by plugin, because two plugins that both take a `registry` are
 * ordinary and one of them reading the other's value is not a bug anybody
 * would find quickly.
 */
export function parameterEnvironment(pluginName: string, values: Record<string, string>): Record<string, string> {
  const prefix = `REVIEWOS_PLUGIN_${pluginName.replace(/[^A-Z0-9]+/gi, '_').toUpperCase()}_`

  return Object.fromEntries(Object.entries(values).map(([name, value]) => [`${prefix}${name.toUpperCase()}`, value]))
}

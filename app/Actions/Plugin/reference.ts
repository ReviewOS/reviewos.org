/**
 * What a `plugins:` entry names, and whether it names it precisely.
 *
 * **A plugin is not an action, and the difference is where it runs.** `uses:`
 * runs *as* a step; a plugin wraps the job around the steps - before the
 * checkout, after the artifacts, on every job in a pool without being written
 * into any workflow file. Actions is still the primary extension mechanism and
 * nothing here competes with it. See `docs/plugins.md` for the decision rule.
 *
 * Two sources, both git, both on this instance:
 *
 * - **Vendored**, `./.reviewos/plugins/<name>`, resolved out of the repository
 *   at the commit the run is for. It cannot drift, because it is the run's own
 *   code.
 * - **A repository here**, `owner/name#ref`. Fetching from another host is not
 *   supported, and that is a decision rather than a gap: a plugin is code that
 *   runs outside the steps, and an instance whose jobs execute whatever a
 *   third-party host serves today has no boundary left to enforce.
 */

/** A plugin reference nobody has resolved yet. */
export interface PluginReference {
  /** As written, for messages. */
  raw: string
  kind: 'vendored' | 'repository'
  /** `owner/name` for a repository plugin, the path for a vendored one. */
  source: string
  /** The name a hook directory and its environment variables are keyed on. */
  name: string
  /** The ref written after `#`, or null. */
  ref: string | null
  /** How precisely the ref names a commit, as far as syntax can tell. */
  pin: 'own-commit' | 'commit' | 'named' | 'none'
}

export interface ReferenceProblem {
  raw: string
  reason: string
}

/** A job may not carry an unbounded list of them. */
export const MAX_PLUGINS = 10

const VENDORED = /^\.?\/?\.reviewos\/plugins\/([\w.-]+)$/
const REPOSITORY = /^([\w.-]+)\/([\w.-]+)$/

/**
 * Parse one reference.
 *
 * Returns a problem rather than throwing, because these arrive in a workflow
 * file and the answer somebody needs is which line is wrong and why - not a
 * stack trace in a log they have to go and find.
 */
export function parsePluginReference(raw: string): PluginReference | ReferenceProblem {
  const trimmed = String(raw ?? '').trim()

  if (!trimmed)
    return { raw: String(raw ?? ''), reason: 'a plugin entry with no reference' }

  if (/^[a-z][\w+.-]*:\/\//i.test(trimmed) || trimmed.includes('@'))
    return { raw: trimmed, reason: 'a plugin comes from this instance: `owner/name#ref`, or `./.reviewos/plugins/<name>` in this repository' }

  const [source = '', ...rest] = trimmed.split('#')

  if (rest.length > 1)
    return { raw: trimmed, reason: 'more than one `#` in a plugin reference' }

  const ref = rest[0]?.trim() || null
  const vendored = VENDORED.exec(source.trim())

  if (vendored) {
    if (ref)
      return { raw: trimmed, reason: 'a vendored plugin has no ref: it is the commit this run is for' }

    return {
      raw: trimmed,
      kind: 'vendored',
      source: `.reviewos/plugins/${vendored[1]}`,
      name: vendored[1]!,
      ref: null,
      /*
       * Pinned by construction, and worth naming separately from `commit`: it
       * is not that somebody wrote a sha down, it is that there is nothing to
       * write - the plugin travels with the code that uses it.
       */
      pin: 'own-commit',
    }
  }

  const repository = REPOSITORY.exec(source.trim())

  if (!repository)
    return { raw: trimmed, reason: 'a plugin reference is `owner/name#ref` or `./.reviewos/plugins/<name>`' }

  return {
    raw: trimmed,
    kind: 'repository',
    source: `${repository[1]}/${repository[2]}`,
    name: repository[2]!,
    ref,
    pin: !ref ? 'none' : /^[0-9a-f]{40}$/i.test(ref) ? 'commit' : 'named',
  }
}

/** Whether a parsed result is the problem branch. */
export function isProblem(value: PluginReference | ReferenceProblem): value is ReferenceProblem {
  return 'reason' in value
}

/**
 * The `plugins:` list of one job, as written.
 *
 * Buildkite's shape, because it is the one people have seen: a list whose
 * entries are either a bare reference or a single-key mapping of reference to
 * parameters.
 */
export function readPluginList(value: unknown): Array<{ raw: string, parameters: Record<string, unknown> }> | { error: string } {
  if (value === null || value === undefined)
    return []

  if (!Array.isArray(value))
    return { error: '`plugins:` is a list' }

  if (value.length > MAX_PLUGINS)
    return { error: `a job may use at most ${MAX_PLUGINS} plugins` }

  const entries: Array<{ raw: string, parameters: Record<string, unknown> }> = []

  for (const entry of value) {
    if (typeof entry === 'string') {
      entries.push({ raw: entry, parameters: {} })
      continue
    }

    if (!entry || typeof entry !== 'object' || Array.isArray(entry))
      return { error: 'a plugin entry is a reference, or a reference with parameters under it' }

    const keys = Object.keys(entry as Record<string, unknown>)

    if (keys.length !== 1)
      return { error: 'a plugin entry names exactly one plugin' }

    const parameters = (entry as Record<string, unknown>)[keys[0]!]

    if (parameters !== null && parameters !== undefined && (typeof parameters !== 'object' || Array.isArray(parameters)))
      return { error: `parameters for \`${keys[0]}\` are a mapping` }

    entries.push({ raw: keys[0]!, parameters: (parameters ?? {}) as Record<string, unknown> })
  }

  return entries
}

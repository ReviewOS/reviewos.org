/**
 * `env:` and its precedence.
 *
 * Three levels, narrowest wins: a step's `env` overrides the job's, which
 * overrides the workflow's. That is Actions' rule and it is the whole of it -
 * there is no merging of values, only of names, and a name defined twice takes
 * the definition from the innermost level that has it.
 *
 * Kept as a pure function over the three maps because the interesting part is
 * not the merge, it is being able to answer *where a value came from* when
 * somebody asks why their step saw `production`. `resolveEnv` returns the
 * effective map; `explainEnv` returns the same thing with the level that won.
 */

export type EnvLevel = 'workflow' | 'job' | 'step'

export interface EnvSource {
  name: string
  value: string
  /** The narrowest level that defined it, which is the one in effect. */
  level: EnvLevel
  /** The levels that defined it and lost, outermost first. */
  overridden: EnvLevel[]
}

/** The three levels a run's environment is built from, outermost first. */
export interface EnvLevels {
  workflow?: Record<string, string> | null
  job?: Record<string, string> | null
  step?: Record<string, string> | null
}

/**
 * Parse a stored `env` column.
 *
 * Anything that is not an object of strings is read as nothing rather than as
 * an error: a version whose env cannot be read still runs, with less in its
 * environment, which is the failure a person can see and fix. Values are
 * stringified, because that is what a process receives - a `PORT: 8080` in
 * YAML is the number 8080 and the runner is handed `"8080"`.
 */
export function envFrom(stored: unknown): Record<string, string> {
  if (stored === null || stored === undefined)
    return {}

  let parsed: unknown = stored

  if (typeof stored === 'string') {
    const text = stored.trim()

    if (!text)
      return {}

    try {
      parsed = JSON.parse(text)
    }
    catch {
      return {}
    }
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    return {}

  const values: Record<string, string> = {}

  for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!name)
      continue

    // `null` is a name with no value in YAML, and Actions passes it as empty
    // rather than dropping it: a step testing `if [ -z "$THING" ]` should see
    // an empty string, not an unset variable.
    values[name] = value === null || value === undefined ? '' : String(value)
  }

  return values
}

/**
 * The environment a step actually sees.
 *
 * Names are compared exactly. Actions does not case-fold them, and neither do
 * the systems underneath on anything but Windows: `Path` and `PATH` are two
 * variables here, which is surprising once and correct forever.
 */
export function resolveEnv(levels: EnvLevels): Record<string, string> {
  return {
    ...envFrom(levels.workflow),
    ...envFrom(levels.job),
    ...envFrom(levels.step),
  }
}

/**
 * The same answer, with the reason.
 *
 * "Why did my step see `staging` when the job says `production`" is the
 * question this exists for, and it is unanswerable from the merged map alone.
 * Sorted by name so two runs of the same workflow read the same way.
 */
export function explainEnv(levels: EnvLevels): EnvSource[] {
  const byLevel: Array<[EnvLevel, Record<string, string>]> = [
    ['workflow', envFrom(levels.workflow)],
    ['job', envFrom(levels.job)],
    ['step', envFrom(levels.step)],
  ]

  const sources = new Map<string, EnvSource>()

  for (const [level, values] of byLevel) {
    for (const [name, value] of Object.entries(values)) {
      const existing = sources.get(name)

      sources.set(name, {
        name,
        value,
        level,
        // The one that was there before this level is now overridden, along
        // with whatever it had already overridden.
        overridden: existing ? [...existing.overridden, existing.level] : [],
      })
    }
  }

  return [...sources.values()].sort((one, two) => one.name.localeCompare(two.name))
}

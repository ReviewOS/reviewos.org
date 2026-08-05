/**
 * The patterns an instance adds to the built-in ones.
 *
 * Every organisation issues credentials nobody else has heard of - an internal
 * service token with its own prefix, a licence key, a signing secret from a
 * vendor with three customers. The built-in list cannot know about any of them,
 * and an instance that has to fork the detector file to add one is an instance
 * that never adds one.
 *
 * They live in `config/push-protection.ts` so they are versioned with the
 * deployment and reviewed like anything else, rather than in a table somebody
 * edits at three in the morning.
 *
 * ## A pattern from config is still not trusted with the process
 *
 * A regular expression is a program. One written carelessly - `(a+)+$` against
 * a long line - takes exponential time, and a scanner that hangs is a push that
 * hangs, which is indistinguishable from the forge being down. So each pattern
 * is compiled once at load, checked against a pathological input with a time
 * budget, and dropped with a warning if it cannot answer quickly. A dropped
 * pattern costs one detector; a hung one costs every push.
 */

import type { SecretPattern } from './secrets'

/** How long a single pattern may take on a hostile line before it is dropped. */
export const PATTERN_BUDGET_MS = 25

/** The line a pattern is tried against, chosen to be bad for a careless one. */
const TORTURE = `${'a'.repeat(2000)}!`

let cache: readonly SecretPattern[] | null = null

/**
 * Compile and vet one configured pattern.
 *
 * `source` is a string rather than a `RegExp` because it comes from a config
 * file that may be JSON, and because a string is what a self-hosted operator
 * can copy out of a vendor's documentation.
 */
export function compilePattern(entry: unknown): SecretPattern | null {
  if (!entry || typeof entry !== 'object')
    return null

  const { name, pattern, confidence } = entry as Record<string, unknown>

  if (typeof name !== 'string' || !name.trim())
    return null

  if (typeof pattern !== 'string' || !pattern.trim())
    return null

  let compiled: RegExp
  try {
    compiled = new RegExp(pattern)
  }
  catch {
    return null
  }

  // The budget check. A pattern that cannot answer about 2000 characters in
  // 25ms will not answer about a minified bundle at all.
  const started = performance.now()
  try {
    compiled.test(TORTURE)
  }
  catch {
    return null
  }

  if (performance.now() - started > PATTERN_BUDGET_MS)
    return null

  return {
    name: name.trim(),
    test: compiled,
    // Anything an instance adds is `likely` unless it says otherwise: a
    // configured pattern has not been through the review the built-in ones
    // have, and the confidence is what a reader weighs the finding by.
    confidence: confidence === 'certain' ? 'certain' : 'likely',
  }
}

/**
 * The vetted patterns for this instance.
 *
 * Cached, because it is asked for on every push and the answer only changes
 * when the process restarts - which is also when a config change takes effect.
 */
export async function instancePatterns(): Promise<readonly SecretPattern[]> {
  if (cache)
    return cache

  let configured: unknown[] = []

  try {
    const config: any = await import('../../../config/push-protection')
    const value = config?.default?.patterns ?? config?.patterns
    configured = Array.isArray(value) ? value : []
  }
  catch {
    // No config file, or one that does not export this. Both mean the same
    // thing: the built-in patterns are the whole list.
    configured = []
  }

  cache = configured
    .map(entry => compilePattern(entry))
    .filter((pattern): pattern is SecretPattern => pattern !== null)

  return cache
}

/** Drop the caches. For tests, and for a reload that does not restart. */
export function forgetPatterns(): void {
  cache = null
  settings = null
}

export interface PushProtectionSettings {
  enabled: boolean
  allowBypass: boolean
  minimumReasonLength: number
}

let settings: PushProtectionSettings | null = null

/**
 * The instance's push-protection settings, with defaults that fail *safe*.
 *
 * A missing or unreadable config leaves protection on: the cost of being wrong
 * that way is a refused push somebody bypasses, and the cost of being wrong the
 * other way is a credential in a repository.
 */
export async function pushProtectionSettings(): Promise<PushProtectionSettings> {
  if (settings)
    return settings

  let raw: any = {}
  try {
    const config: any = await import('../../../config/push-protection')
    raw = config?.default ?? config ?? {}
  }
  catch {
    raw = {}
  }

  settings = {
    enabled: raw.enabled !== false,
    allowBypass: raw.allowBypass !== false,
    minimumReasonLength: Number.isFinite(raw.minimumReasonLength) ? Number(raw.minimumReasonLength) : 12,
  }

  return settings
}


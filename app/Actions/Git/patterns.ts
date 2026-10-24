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
 * is checked at load and every subsequent match runs through the framework's
 * killable process boundary. A sample cannot prove that another input is safe.
 * A detector that cannot complete a scan is an incomplete check, not a clean one.
 */

import type { SecretPattern } from './secrets'
import { matchBoundedRegex, RegexTimeoutError } from '@stacksjs/security'
import { isNotFalse } from '../Support/sql'

/** Maximum execution time for one configured pattern match. */
export const PATTERN_BUDGET_MS = 25

/** Leaves time for the hook to receive a refusal before its 15-second timeout. */
export const CONFIGURED_SCAN_BUDGET_MS = 1000

export function assertConfiguredScanBudget(deadline: number): void {
  if (performance.now() >= deadline)
    throw new ConfiguredPatternError(new RegexTimeoutError())
}

/** The line a pattern is tried against, chosen to be bad for a careless one. */
const TORTURE = `${'a'.repeat(2000)}!`

/** Distinguishes an incomplete configured scan from unrelated optional scans. */
export class ConfiguredPatternError extends Error {
  constructor(cause: unknown) {
    super('A configured credential detector could not complete. Ask an instance administrator to check push-protection patterns.', { cause })
    this.name = 'ConfiguredPatternError'
  }
}

let cache: readonly SecretPattern[] | null = null

/**
 * Compile and vet one configured pattern.
 *
 * `source` is a string rather than a `RegExp` because it comes from a config
 * file that may be JSON, and because a string is what a self-hosted operator
 * can copy out of a vendor's documentation.
 */
export function compilePattern(entry: unknown, options: { timeoutMs?: number, validationTimeoutMs?: number } = {}): SecretPattern | null {
  const timeoutMs = options.timeoutMs ?? PATTERN_BUDGET_MS
  const validationTimeoutMs = options.validationTimeoutMs ?? timeoutMs
  if (!entry || typeof entry !== 'object')
    return null

  const { name, pattern, confidence } = entry as Record<string, unknown>

  if (typeof name !== 'string' || !name.trim())
    return null

  if (typeof pattern !== 'string' || !pattern.trim())
    return null

  try {
    matchBoundedRegex(pattern, TORTURE, { timeoutMs: validationTimeoutMs })
  }
  catch (error) {
    if (error instanceof SyntaxError || error instanceof RangeError || error instanceof RegexTimeoutError)
      return null
    throw new ConfiguredPatternError(error)
  }

  const exec = (subject: string): RegExpExecArray | null => {
    try {
      const match = matchBoundedRegex(pattern, subject, { timeoutMs })
      if (!match)
        return null
      const values: [string] = [match.value]
      return Object.assign(values, { index: match.index, input: subject, groups: undefined })
    }
    catch (error) {
      throw new ConfiguredPatternError(error)
    }
  }

  return {
    name: name.trim(),
    test: { exec, test: subject => exec(subject) !== null },
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
export async function instancePatterns(deadline = performance.now() + CONFIGURED_SCAN_BUDGET_MS): Promise<readonly SecretPattern[]> {
  if (cache) {
    if (cache.length)
      assertConfiguredScanBudget(deadline)
    return cache
  }

  let configured: unknown[]

  try {
    const config: any = await import('../../../config/push-protection')
    const value = config?.default?.patterns ?? config?.patterns
    if (!Array.isArray(value))
      throw new Error('Configured credential detectors must be an array')
    configured = value
  }
  catch (error) {
    throw new ConfiguredPatternError(error)
  }

  const compiled: SecretPattern[] = []
  for (const entry of configured) {
    assertConfiguredScanBudget(deadline)
    const pattern = compilePattern(entry)
    if (!pattern)
      throw new ConfiguredPatternError(new Error('Unusable configured credential detector'))
    compiled.push(pattern)
  }
  cache = compiled

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
    enabled: isNotFalse(raw.enabled),
    allowBypass: raw.allowBypass !== false,
    minimumReasonLength: Number.isFinite(raw.minimumReasonLength) ? Number(raw.minimumReasonLength) : 12,
  }

  return settings
}


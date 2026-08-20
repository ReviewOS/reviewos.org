/**
 * **What the repair agent runs on**
 *
 * The policy in `app/Actions/Workflow/repairPolicy.ts` answers what a repair may
 * do. This answers what performs it, which is a different kind of question: the
 * policy is a decision an operator makes about their repositories, and this is a
 * fact about the instance's environment.
 *
 * ## Off unless a key is present
 *
 * There is no default key and no fallback provider. An instance with no
 * `ANTHROPIC_API_KEY` cannot repair anything, and `configured()` is what the
 * agent checks before it spends a budget - a repository that turned repair on
 * against an instance that cannot perform one should be told that, not left
 * with attempts that fail for a reason nobody can see from the repository.
 *
 * This is deliberately a second switch. `repair_settings.enabled` is the
 * repository saying an agent may push branches here; a key is the operator
 * saying this instance can call a model at all. Neither implies the other, and
 * an instance that stores a key does not thereby enable repair on four thousand
 * repositories.
 *
 * ## Why the model is named here rather than per repository
 *
 * Whoever pays for the tokens picks the model. A repository-level choice would
 * let one team's setting spend an operator's money at a rate the operator never
 * agreed to, and the thing a repository actually wants to control - how much may
 * be spent on it - is already `max_cost` and `max_attempts`.
 */

export interface CiRepairConfig {
  /** The key the agent authenticates with. Empty means repair cannot run. */
  apiKey: string
  /** The model it calls. */
  model: string
  /** How hard it thinks, as the API's effort levels. */
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  /** The ceiling on one proposal's output. */
  maxTokens: number
  /** The most log lines handed to the model, as context. */
  logLines: number
  /** The most files one repair may change. */
  maxFiles: number
}

/**
 * The default model.
 *
 * Named as a bare id with no date suffix, which is the form the API takes. A
 * pinned snapshot here would be a string this file has to chase, and the
 * operator who needs one has `CI_REPAIR_MODEL`.
 */
const DEFAULT_MODEL = 'claude-opus-5'

export function repairApiKey(env: Record<string, string | undefined> = process.env): string {
  return String(env.ANTHROPIC_API_KEY ?? '').trim()
}

export function repairModel(env: Record<string, string | undefined> = process.env): string {
  return String(env.CI_REPAIR_MODEL ?? '').trim() || DEFAULT_MODEL
}

/**
 * How hard it thinks.
 *
 * `high` rather than `xhigh`, which is the harder setting for coding work,
 * because a repair is reviewed by a person before it lands and the marginal
 * quality is not obviously worth the marginal spend on somebody else's bill.
 * An operator who disagrees sets `CI_REPAIR_EFFORT`.
 */
export function repairEffort(env: Record<string, string | undefined> = process.env): CiRepairConfig['effort'] {
  const raw = String(env.CI_REPAIR_EFFORT ?? '').trim().toLowerCase()
  const allowed = ['low', 'medium', 'high', 'xhigh', 'max'] as const

  return (allowed as readonly string[]).includes(raw) ? raw as CiRepairConfig['effort'] : 'high'
}

export function repairMaxTokens(env: Record<string, string | undefined> = process.env): number {
  const raw = Number(env.CI_REPAIR_MAX_TOKENS ?? 0)

  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 16000
}

/**
 * How much of the failing log the model sees.
 *
 * The tail, because a failure's cause is at the end of the step that failed.
 * Bounded because a log is attacker-controlled in the ordinary case - it is
 * whatever the repository's own test suite printed - and an unbounded one is
 * both a bill and a prompt somebody else wrote.
 */
export function repairLogLines(env: Record<string, string | undefined> = process.env): number {
  const raw = Number(env.CI_REPAIR_LOG_LINES ?? 0)

  return Number.isFinite(raw) && raw > 0 ? Math.min(Math.floor(raw), 2000) : 200
}

/**
 * The most files one repair may rewrite.
 *
 * A ceiling on blast radius rather than on cost. A repair touching forty files
 * is not a repair; it is a refactor nobody asked for, and the reviewer who has
 * to read it is the person this limit protects.
 */
export function repairMaxFiles(env: Record<string, string | undefined> = process.env): number {
  const raw = Number(env.CI_REPAIR_MAX_FILES ?? 0)

  return Number.isFinite(raw) && raw > 0 ? Math.min(Math.floor(raw), 50) : 10
}

/** Whether this instance can perform a repair at all. */
export function configured(env: Record<string, string | undefined> = process.env): boolean {
  return repairApiKey(env).length > 0
}

export default {
  apiKey: repairApiKey(),
  model: repairModel(),
  effort: repairEffort(),
  maxTokens: repairMaxTokens(),
  logLines: repairLogLines(),
  maxFiles: repairMaxFiles(),
} satisfies CiRepairConfig

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
  /** The most repairs running at once across the instance. Zero for no limit. */
  maxRunning: number
  /** The same for one repository. */
  maxRunningPerRepository: number
  /** And for one owner, across every repository they have. */
  maxRunningPerOwner: number
  /** How long a started repair may be counted as running before it is presumed dead. */
  staleMinutes: number
  /** How long a repair waits before asking for capacity again. */
  waitSeconds: number
  /** How many times it may ask before giving the attempt back. */
  maxWaits: number
  /** How long one model call may take before it is killed. */
  callSeconds: number
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

/**
 * **How many repairs may run at once**
 *
 * `config/ci-quotas.ts` bounds how much of the *fleet* one repository may hold,
 * and these are the same idea for repair. They are not the same numbers, and
 * more importantly they are not off by default, which is a deliberate departure
 * worth explaining.
 *
 * A machine ceiling is off by default because machines are this instance's own
 * hardware: if a ceiling holds a job back while a runner sits idle, capacity
 * somebody already paid for is wasted, and on a single-team instance the limit
 * only ever gets in the way.
 *
 * A repair does not take a machine. It takes a call to somebody else's API,
 * which has a rate limit, and it takes money. The failure mode with no ceiling
 * is not a slow queue - it is a monorepository whose push fans out into eighty
 * failing jobs, eighty simultaneous model calls, a rate limit that then refuses
 * everybody's repairs including the ones that mattered, and an invoice nobody
 * agreed to. That is worth a conservative default that an operator raises,
 * rather than an unbounded one they discover.
 *
 * Being over a ceiling is a **wait, not a refusal**, exactly as it is for a job
 * that finds the fleet full: nothing about being over a limit says the work is
 * wrong, only that it is not this repair's turn yet.
 */

/** Across the whole instance, which is the one the model's rate limit cares about. */
export function repairMaxRunning(env: Record<string, string | undefined> = process.env): number {
  return ceiling(env.CI_REPAIR_MAX_RUNNING, 4)
}

/**
 * And per repository, which is what stops one busy repository holding all of it.
 *
 * Two by default, which is one run's worth at the default `max_attempts`: a
 * repository can have both of a run's attempts in flight and no more.
 */
export function repairMaxRunningPerRepository(env: Record<string, string | undefined> = process.env): number {
  return ceiling(env.CI_REPAIR_MAX_RUNNING_PER_REPOSITORY, 2)
}

/** And per owner, for the instance hosting several organizations. */
export function repairMaxRunningPerOwner(env: Record<string, string | undefined> = process.env): number {
  return ceiling(env.CI_REPAIR_MAX_RUNNING_PER_OWNER, 3)
}

/**
 * How long a started repair counts against the ceilings.
 *
 * A repair whose process died leaves a row that says it is running, and without
 * a horizon that row holds a slot forever - one crash at a time, until repair
 * stops happening at all and nothing says why. An hour is far longer than any
 * repair should take and short enough that a dead one is forgotten the same
 * morning.
 */
export function repairStaleMinutes(env: Record<string, string | undefined> = process.env): number {
  return ceiling(env.CI_REPAIR_STALE_MINUTES, 60) || 60
}

/** How long it waits before asking for capacity again. */
export function repairWaitSeconds(env: Record<string, string | undefined> = process.env): number {
  return ceiling(env.CI_REPAIR_WAIT_SECONDS, 30) || 30
}

/**
 * How many times it may ask before giving the attempt back.
 *
 * Bounded because an unbounded wait is a queue nobody can see the end of. At
 * the defaults this is ten minutes, after which the attempt is handed back as a
 * refusal rather than a failure - it never ran, so it has spent nothing and
 * should not consume one of the run's tries.
 */
export function repairMaxWaits(env: Record<string, string | undefined> = process.env): number {
  return ceiling(env.CI_REPAIR_MAX_WAITS, 20) || 20
}

/**
 * How long one model call may take before the process running it is killed.
 *
 * Generous, because adaptive thinking on a hard failure is genuinely slow, and
 * bounded because a call that never returns holds an attempt open - and that
 * attempt is holding a slot against the fleet ceiling. A ceiling whose entries
 * can never leave is not a ceiling.
 */
export function repairCallSeconds(env: Record<string, string | undefined> = process.env): number {
  return ceiling(env.CI_REPAIR_CALL_SECONDS, 300) || 300
}

/** A ceiling from the environment, or the default. Zero means no limit. */
function ceiling(raw: string | undefined, fallback: number): number {
  if (raw === undefined || String(raw).trim() === '')
    return fallback

  const value = Number(raw)

  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback
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
  maxRunning: repairMaxRunning(),
  maxRunningPerRepository: repairMaxRunningPerRepository(),
  maxRunningPerOwner: repairMaxRunningPerOwner(),
  staleMinutes: repairStaleMinutes(),
  waitSeconds: repairWaitSeconds(),
  maxWaits: repairMaxWaits(),
  callSeconds: repairCallSeconds(),
} satisfies CiRepairConfig

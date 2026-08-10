/**
 * What a protected branch rule may be set to.
 *
 * Pure, like `settings.ts` beside it and for the same reason: every one of
 * these is a decision with a consequence outside the row. `required_approvals`
 * set too high is a branch nobody can merge to; `allow_force_push` set at all
 * is history somebody can lose. So the rules are here and testable, and the
 * action does the database work against answers it did not have to work out.
 */

/** Everything a rule can say, as a caller sends it. */
export interface RulePatch {
  pattern?: unknown
  required_approvals?: unknown
  dismiss_stale_reviews?: unknown
  require_conversation_resolution?: unknown
  required_checks?: unknown
  allow_force_push?: unknown
  allow_deletion?: unknown
  require_linear_history?: unknown
  require_human_approval_for_agents?: unknown
}

export interface BranchRuleRow {
  pattern: string
  required_approvals: number
  dismiss_stale_reviews: boolean
  require_conversation_resolution: boolean
  /** A JSON array of check names, as the column stores it. */
  required_checks: string
  allow_force_push: boolean
  allow_deletion: boolean
  require_linear_history: boolean
  require_human_approval_for_agents: boolean
}

export type RuleDecision =
  | { ok: true, rule: BranchRuleRow }
  | { ok: false, error: string, status: number }

/**
 * More than this and the branch is unmergeable rather than protected.
 *
 * There is no organization on earth with fifty reviewers on one branch, and the
 * number that gets typed by accident is the one with an extra zero. A rule
 * nobody can satisfy is a rule somebody deletes, which leaves the branch with
 * no protection at all.
 */
const MAX_APPROVALS = 20

/** A pattern this long is a mistake, and the column is 255. */
const MAX_PATTERN = 255

export function decideRule(patch: RulePatch): RuleDecision {
  const pattern = String(patch.pattern ?? '').trim()

  if (!pattern)
    return { ok: false, error: 'A branch pattern is required', status: 422 }

  if (pattern.length > MAX_PATTERN)
    return { ok: false, error: `A branch pattern is at most ${MAX_PATTERN} characters`, status: 422 }

  /*
   * A pattern is matched against a branch name, so it cannot contain the things
   * a branch name cannot contain. Refused here rather than accepted and left to
   * match nothing: a rule that silently protects no branch is worse than no
   * rule, because the settings page shows it and everybody believes it.
   */
  if (/[\s~^:?[\\]/.test(pattern) || pattern.includes('..'))
    return { ok: false, error: 'That is not a usable branch pattern', status: 422 }

  const approvals = Number(patch.required_approvals ?? 0)

  if (!Number.isInteger(approvals) || approvals < 0 || approvals > MAX_APPROVALS)
    return { ok: false, error: `Required approvals is a whole number from 0 to ${MAX_APPROVALS}`, status: 422 }

  const checks = readChecks(patch.required_checks)

  if (!checks.ok)
    return { ok: false, error: checks.error, status: 422 }

  return {
    ok: true,
    rule: {
      pattern,
      required_approvals: approvals,
      dismiss_stale_reviews: readFlag(patch.dismiss_stale_reviews),
      require_conversation_resolution: readFlag(patch.require_conversation_resolution),
      required_checks: JSON.stringify(checks.names),
      allow_force_push: readFlag(patch.allow_force_push),
      allow_deletion: readFlag(patch.allow_deletion),
      require_linear_history: readFlag(patch.require_linear_history),
      require_human_approval_for_agents: readFlag(patch.require_human_approval_for_agents),
    },
  }
}

/**
 * The check names a rule requires.
 *
 * Accepts a JSON array or a comma-separated list, because a form field sends
 * the second and an API client sends the first, and demanding JSON of a text
 * input is how a checkbox page ends up with its own parser.
 *
 * **Absent means none, not "leave it alone".** Every field on this rule is sent
 * every time, since the endpoint upserts a whole rule rather than patching one:
 * a partial save that kept an old required check would be a protection nobody
 * asked for, appearing on a branch somebody just edited.
 */
function readChecks(raw: unknown): { ok: true, names: string[] } | { ok: false, error: string } {
  if (raw === undefined || raw === null || raw === '')
    return { ok: true, names: [] }

  if (Array.isArray(raw))
    return { ok: true, names: clean(raw.map(String)) }

  const text = String(raw).trim()

  if (text.startsWith('[')) {
    try {
      const parsed = JSON.parse(text)

      if (!Array.isArray(parsed))
        return { ok: false, error: 'Required checks is a list of check names' }

      return { ok: true, names: clean(parsed.map(String)) }
    }
    catch {
      return { ok: false, error: 'Required checks is a list of check names' }
    }
  }

  return { ok: true, names: clean(text.split(',')) }
}

/** Trimmed, blank-free, and deduplicated, in the order given. */
function clean(names: string[]): string[] {
  const seen = new Set<string>()

  return names
    .map(name => name.trim())
    .filter(name => name && !seen.has(name) && seen.add(name) !== undefined)
}

/**
 * A checkbox, as a form sends it.
 *
 * Unlike the repository settings' version this treats absent as **false**
 * rather than "leave it alone", and the difference is the same one `readChecks`
 * turns on: an unticked HTML checkbox sends nothing at all, and a rule that
 * kept its old value for every box somebody just cleared would be impossible to
 * turn off from the page that displays it.
 */
function readFlag(value: unknown): boolean {
  if (value === undefined || value === null || value === '')
    return false

  return ['1', 'true', 'on', 'yes'].includes(String(value).toLowerCase())
}

/**
 * A rule's settings, without the bookkeeping.
 *
 * Ids and timestamps are dropped before a rule goes into an audit entry: a
 * `from`/`to` pair is only readable if the two sides differ exactly where the
 * change was, and a line saying the id did not change is noise on the page
 * somebody is reading under pressure.
 */
export function settingsOf(row: BranchRuleRow | Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(row)) {
    if (key === 'id' || key === 'repository_id' || key === 'created_at' || key === 'updated_at')
      continue

    out[key] = value
  }

  return out
}

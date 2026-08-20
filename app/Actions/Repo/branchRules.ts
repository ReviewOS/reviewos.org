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
  require_up_to_date?: unknown
  enforce_admins?: unknown
  push_restrictions?: unknown
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
  require_up_to_date: boolean
  enforce_admins: boolean
  /** `{"users":[],"teams":[]}` as the column stores it, or `''` for none. */
  push_restrictions: string
}

/** Who a branch may be written by, once the column has been read. */
export interface PushRestrictions {
  users: string[]
  teams: string[]
}

/** As much of somebody as a restriction needs to know. Both lowercased. */
export interface RestrictedActor {
  handle: string | null
  teams: readonly string[]
}

/**
 * Whether a restriction admits this person.
 *
 * Shared by the push gate and the merge action deliberately. A merge writes to
 * the base branch exactly as a push does, and a restriction enforced on only
 * one of the two doors is a restriction with a button beside it - somebody
 * refused at the command line opens a pull request and lands the same commit a
 * minute later.
 *
 * **Nobody is refused.** This is the one place in branch protection that fails
 * closed, and it is deliberate: everywhere else, guessing wrong means a rule
 * that does not apply for a moment, while here it would mean "anyone we could
 * not identify may write to the release branch" - not a weakened protection but
 * the absence of one.
 */
export function restrictionPermits(restriction: PushRestrictions, actor: RestrictedActor | null): boolean {
  if (!actor)
    return false

  if (actor.handle && restriction.users.includes(actor.handle))
    return true

  return actor.teams.some(team => restriction.teams.includes(team))
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

  const restrictions = readRestrictions(patch.push_restrictions)

  if (!restrictions.ok)
    return { ok: false, error: restrictions.error, status: 422 }

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
      require_up_to_date: readFlag(patch.require_up_to_date),
      /*
       * The one flag that is not `readFlag`, because its absent value is not
       * false.
       *
       * Every other box on this form is off when nobody ticked it. This one
       * defaults to *on*: a caller that leaves `enforce_admins` out of a save
       * is not asking for an admin exemption, and reading silence as one would
       * quietly unbind the rule from the people most able to break it every
       * time somebody edited an unrelated field.
       *
       * The form posts a hidden `0` alongside the checkbox so an unticked box
       * still arrives, which is what makes turning it off possible at all.
       */
      enforce_admins: patch.enforce_admins === undefined ? true : readFlag(patch.enforce_admins),
      push_restrictions: writeRestrictions(restrictions.value),
    },
  }
}

/**
 * Who may write to the branch, as a caller sends it.
 *
 * Accepts GitHub's shape - `{"users": [...], "teams": [...]}`, and `null` for
 * unrestricted - as well as the two things a form can send: a comma-separated
 * list of handles in `push_restrictions_users` merged in by the caller, or the
 * whole object as a JSON string.
 *
 * **Empty is unrestricted, and there is no way to spell "nobody".** A branch
 * with an empty allowlist would be a branch that refuses every push including
 * the one that would fix the rule, and the difference between "I cleared this
 * field" and "I want nobody to push here" is not something a text input can
 * carry. Somebody who wants that has `allow_force_push` off and a rule with
 * required approvals, which stops the pushes that lose work rather than all of
 * them.
 */
export function readRestrictions(raw: unknown): { ok: true, value: PushRestrictions | null } | { ok: false, error: string } {
  if (raw === undefined || raw === null || raw === '')
    return { ok: true, value: null }

  let source: unknown = raw

  if (typeof raw === 'string') {
    const text = raw.trim()

    if (!text)
      return { ok: true, value: null }

    if (text.startsWith('{')) {
      try {
        source = JSON.parse(text)
      }
      catch {
        return { ok: false, error: 'Push restrictions is a list of user handles and team slugs' }
      }
    }
    else {
      // A single form field. Handles and slugs are indistinguishable as text,
      // so a bare list is read as users - the common case by a wide margin, and
      // the settings page has a separate field for teams.
      source = { users: text.split(',') }
    }
  }

  if (Array.isArray(source))
    source = { users: source }

  if (typeof source !== 'object' || source === null)
    return { ok: false, error: 'Push restrictions is a list of user handles and team slugs' }

  const record = source as Record<string, unknown>
  const users = readNames(record.users)
  const teams = readNames(record.teams)

  if (users === null || teams === null)
    return { ok: false, error: 'Push restrictions is a list of user handles and team slugs' }

  if (users.length === 0 && teams.length === 0)
    return { ok: true, value: null }

  return { ok: true, value: { users, teams } }
}

/** One side of the restriction. Null when it is not a list of names at all. */
function readNames(raw: unknown): string[] | null {
  if (raw === undefined || raw === null || raw === '')
    return []

  /*
   * An array or a string, and nothing else.
   *
   * `String({})` is `'[object Object]'`, which `clean` would happily accept as
   * a handle - so a caller sending `{"users": {"login": "ada"}}` would get a
   * branch restricted to a user who cannot exist, and the first they would hear
   * of it is a refused push.
   */
  if (!Array.isArray(raw) && typeof raw !== 'string')
    return null

  const list = Array.isArray(raw)
    ? raw.map((entry) => {
        // GitHub answers with objects and takes names, and a client that reads
        // one before writing the other sends `{"login": "ada"}` straight back.
        if (entry && typeof entry === 'object')
          return String((entry as Record<string, unknown>).login ?? (entry as Record<string, unknown>).slug ?? '')

        return String(entry ?? '')
      })
    : raw.split(',')

  /*
   * Lowercased *before* the deduplication, not after.
   *
   * A handle is matched against this, and `Ada` and `ada` are the same person -
   * a restriction that depends on how somebody typed it lets the wrong person
   * through, or keeps the right one out at the moment they are needed. Cleaning
   * first would leave both spellings in the list: harmless to matching, and a
   * settings page that shows the same person twice with no way to remove one.
   */
  return clean(list.map(name => String(name).toLowerCase()))
}

/** The column's value for a set of restrictions. `''` when there are none. */
export function writeRestrictions(value: PushRestrictions | null): string {
  return value ? JSON.stringify(value) : ''
}

/**
 * The restrictions a stored rule carries.
 *
 * **A column that will not parse is read as unrestricted**, which is the
 * opposite of how `required_checks` is treated one file over, and the reason is
 * the direction each one fails in. An unreadable check list read as "no checks"
 * would quietly weaken a rule, so it is read as unsatisfiable instead. An
 * unreadable allowlist read as "nobody" would lock every writer out of the
 * branch - including whoever would fix the row - so it fails the other way, and
 * the rest of the rule still applies.
 */
export function parseRestrictions(raw: unknown): PushRestrictions | null {
  const decided = readRestrictions(raw)

  return decided.ok ? decided.value : null
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

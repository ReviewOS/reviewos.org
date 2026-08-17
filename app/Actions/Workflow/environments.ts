import { db } from '@stacksjs/database'

/**
 * Deployment environments, and the rules that hold a job at one.
 *
 * `environment: production` on a job is the line everybody writes and almost
 * nobody checks. Parsing it and running the job anyway is worse than refusing
 * the key outright: the workflow says the deploy is protected, the interface
 * shows an environment, and nothing at all is enforced - which is the state
 * this file was written to end.
 *
 * Three rules, and each is one somebody actually asks for:
 *
 * - **Required reviewers.** A named list, and the person who *started* the run
 *   cannot be the one who approves it. Self-approval turns a two-person rule
 *   into a formality, and it is the failure people assume cannot happen because
 *   the list looked right.
 * - **A wait timer.** Minutes between the job becoming ready and it being
 *   allowed to run, so somebody who notices a mistake has a window to cancel.
 *   Released automatically, because a timer that needs a person defeats itself.
 * - **A branch policy.** Which refs may deploy here at all. Refused rather than
 *   held: waiting for an approval that must not be given is worse than a clear
 *   no, and a reviewer asked to approve a deploy from the wrong branch will
 *   eventually approve one.
 */

export interface EnvironmentRules {
  id: number
  name: string
  /** Minutes to hold a job after it becomes ready. Zero for none. */
  waitMinutes: number
  /** User ids who may approve. Empty means nobody is required. */
  reviewers: number[]
  /**
   * Refs allowed to deploy here, as branch names or `*` patterns. Empty allows
   * any branch, which is what an environment with no policy means.
   */
  branches: string[]
}

export type GateDecision =
  /** Nothing holds this job: run it. */
  | { verdict: 'run' }
  /** Held. `until` is set when a timer is what holds it, `reviewers` when people are. */
  | { verdict: 'hold', reason: string, until: string | null, needsReviewer: boolean }
  /** This ref may never deploy here. Not a wait - a refusal. */
  | { verdict: 'refuse', reason: string }

/**
 * What an environment does to a job that is ready to run.
 *
 * Pure, because it is the part that must be right: the queries around it can be
 * re-read, and this cannot be re-decided once a deploy has gone out.
 */
export function decideGate(input: {
  rules: EnvironmentRules | null
  /** The full ref this run is for, e.g. `refs/heads/main`. */
  ref: string
  /** When the job became ready. */
  readyAt: Date
  now: Date
  /** Already approved by somebody, so only the timer can still hold it. */
  approved: boolean
}): GateDecision {
  if (!input.rules)
    return { verdict: 'run' }

  const branch = input.ref.startsWith('refs/heads/') ? input.ref.slice('refs/heads/'.length) : input.ref

  if (input.rules.branches.length > 0 && !input.rules.branches.some(pattern => matchesBranch(pattern, branch))) {
    return {
      verdict: 'refuse',
      reason: `\`${branch}\` may not deploy to ${input.rules.name}. Allowed: ${input.rules.branches.join(', ')}.`,
    }
  }

  if (input.rules.reviewers.length > 0 && !input.approved) {
    return {
      verdict: 'hold',
      reason: `${input.rules.name} needs an approval from a reviewer.`,
      until: null,
      needsReviewer: true,
    }
  }

  if (input.rules.waitMinutes > 0) {
    const until = new Date(input.readyAt.getTime() + input.rules.waitMinutes * 60_000)

    /*
     * The timer runs from when the job became ready, not from the approval.
     * A reviewer who approves immediately should not restart the clock -
     * the window exists so somebody can catch a mistake, and both events are
     * evidence the deploy is wanted.
     */
    if (until > input.now) {
      return {
        verdict: 'hold',
        reason: `${input.rules.name} holds a deploy for ${input.rules.waitMinutes} minutes.`,
        until: until.toISOString(),
        needsReviewer: false,
      }
    }
  }

  return { verdict: 'run' }
}

/** `main`, `release/*`, or `*`. Deliberately not a regular expression. */
export function matchesBranch(pattern: string, branch: string): boolean {
  const clean = String(pattern ?? '').trim()

  if (!clean)
    return false

  if (clean === '*')
    return true

  if (!clean.includes('*'))
    return clean === branch

  /*
   * One wildcard shape, `prefix/*`, and nothing else. A policy language here
   * would be a second thing to learn and a second thing to get wrong, and the
   * only pattern anybody writes for a deploy policy is a release-branch prefix.
   */
  const escaped = clean.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')

  return new RegExp(`^${escaped}$`).test(branch)
}

/** An environment's rules, by name, for one repository. */
export async function environmentRules(repositoryId: number, name: string): Promise<EnvironmentRules | null> {
  const clean = String(name ?? '').trim()

  if (!repositoryId || !clean)
    return null

  const row: any = await db
    .selectFrom('environments')
    .select(['id', 'name', 'wait_minutes', 'branches'])
    .where('repository_id', '=', repositoryId)
    .where('name', '=', clean)
    .executeTakeFirst()
    .catch(() => null)

  /*
   * An environment nothing has configured is not protected.
   *
   * `environment: staging` on a job in a repository with no `staging` is a
   * label, and refusing to run it would break every workflow that uses the key
   * for its own documentation - which is most of them.
   */
  if (!row)
    return null

  const reviewers: any[] = await db
    .selectFrom('environment_reviewers')
    .select(['user_id'])
    .where('environment_id', '=', Number(row.id))
    .execute()
    .catch(() => [])

  return {
    id: Number(row.id),
    name: String(row.name),
    waitMinutes: Number(row.wait_minutes ?? 0) || 0,
    reviewers: reviewers.map(one => Number(one.user_id)).filter(Boolean),
    branches: String(row.branches ?? '')
      .split(',')
      .map(one => one.trim())
      .filter(Boolean),
  }
}

/**
 * Whether this person may open this environment's gate.
 *
 * **The run's actor may not**, even when they are on the list. A required
 * reviewer who can approve their own deploy is a rule that reads as two people
 * and behaves as one, and it is the failure nobody notices because the list
 * looks right.
 */
export function mayApprove(rules: EnvironmentRules, userId: number, actorId: number | null): { ok: boolean, reason?: string } {
  if (rules.reviewers.length === 0)
    return { ok: true }

  if (!rules.reviewers.includes(userId))
    return { ok: false, reason: `${rules.name} is approved by its reviewers, and you are not one of them.` }

  if (actorId && Number(actorId) === Number(userId))
    return { ok: false, reason: 'You started this run. Somebody else has to approve the deploy.' }

  return { ok: true }
}

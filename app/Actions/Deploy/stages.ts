/**
 * A deployment that arrives in stages, and what decides the next one.
 *
 * The alternative every provider offers is one opaque operation: you call
 * `deploy --canary`, something happens for eleven minutes, and either it worked
 * or a support ticket begins. What is missing there is not features, it is
 * *legibility* - nobody can say which stage it reached, what the health check
 * actually returned, or why it went back.
 *
 * So a rollout here is the same rows as everything else. Each stage is a
 * deployment status with a name and a share, a health check is a reported fact
 * rather than a callback nobody sees, and a rollback names the deployment it
 * restored. The run screen and the history read the same way afterwards as they
 * did during, which is the entire point of expressing this as durable records
 * instead of a provider call.
 *
 * ## Why the decision is pure
 *
 * "Promote, hold, or go back" is the rule people will argue about at the worst
 * possible moment - during an incident, reading a history. An argument settled
 * by reading a test is shorter than one settled by re-running a deployment.
 */

/** One step of a rollout: a name, and how much of the traffic it carries. */
export interface Stage {
  name: string
  /** The share this stage serves, 1 to 100. */
  percent: number
}

/**
 * What a health check said.
 *
 * Three values rather than a boolean, and the third is the one that matters:
 * a check that has not reported yet is not a check that failed. Treating
 * "unknown" as failure rolls back every deployment whose probe is a second
 * slow; treating it as success promotes on no evidence at all.
 */
export type Health = 'healthy' | 'unhealthy' | 'unknown'

export type StageVerdict =
  /** Move to the next stage, which is named. */
  | { action: 'promote', stage: Stage, reason: string }
  /** Stay here: the check has not answered yet, or a person is holding it. */
  | { action: 'hold', reason: string }
  /** Put the previous deployment back. */
  | { action: 'roll-back', reason: string }
  /** Nothing left to promote to: the rollout is finished. */
  | { action: 'complete', reason: string }

/**
 * Read a rollout plan, as a workflow or an operator writes one.
 *
 * `10,50,100` is the short form, because a list of percentages is what people
 * actually mean; `canary:10, half:50, all:100` names them when the names are
 * worth having on a screen.
 *
 * A plan that does not end at 100 is completed by adding it. A rollout that
 * stops at 50% and calls itself finished is a deployment half the users never
 * receive, and nobody writes that on purpose.
 */
export function stagesFrom(plan: string | null | undefined): Stage[] {
  const terms = String(plan ?? '')
    .split(/[\n,]/)
    .map(one => one.trim())
    .filter(Boolean)

  const stages: Stage[] = []

  for (const term of terms) {
    const [left, right] = term.includes(':') ? term.split(':', 2) : [null, term]
    const percent = Math.round(Number(String(right ?? '').replace('%', '').trim()))

    if (!Number.isFinite(percent) || percent <= 0 || percent > 100)
      continue

    stages.push({
      name: String(left ?? '').trim() || `${percent}%`,
      percent,
    })
  }

  // Ordered by share rather than as written: a plan listing 50 before 10 is a
  // typo, and running it in that order would put half the users on an untested
  // build to be careful.
  stages.sort((left, right) => left.percent - right.percent)

  if (stages.length === 0)
    return []

  if (stages[stages.length - 1]!.percent !== 100)
    stages.push({ name: 'all', percent: 100 })

  return stages
}

/**
 * What to do next, given where the rollout is and what the check said.
 *
 * `held` is a person pressing pause, and it beats a healthy check: somebody
 * watching a graph they do not like is the reason pause exists, and a rollout
 * that promoted anyway would be a pause button that does nothing.
 */
export function decideStage(input: {
  stages: readonly Stage[]
  /** Which stage the deployment is serving now, counting from zero. */
  current: number
  health: Health
  /** Whether an operator has held this rollout where it is. */
  held?: boolean
}): StageVerdict {
  const stages = [...input.stages]

  if (stages.length === 0)
    return { action: 'complete', reason: 'this deployment has no stages, so there is nothing to promote through.' }

  if (input.health === 'unhealthy') {
    /*
     * Back, immediately, and before the pause is considered. A held rollout
     * that has gone unhealthy is not a decision anybody is still weighing -
     * holding it would leave the bad build serving traffic while somebody
     * decides what to do about a question already answered.
     */
    return { action: 'roll-back', reason: 'the health check failed, so the previous deployment goes back.' }
  }

  if (input.held)
    return { action: 'hold', reason: 'somebody has held this rollout where it is.' }

  if (input.health === 'unknown')
    return { action: 'hold', reason: 'the health check has not reported yet.' }

  const next = input.current + 1

  if (next >= stages.length)
    return { action: 'complete', reason: 'every stage is serving, so the rollout is finished.' }

  return {
    action: 'promote',
    stage: stages[next]!,
    reason: `the health check passed, so ${stages[next]!.name} takes ${stages[next]!.percent}%.`,
  }
}

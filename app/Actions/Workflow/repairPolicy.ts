/**
 * What an automated repair may change, and when it must stop.
 *
 * Written before any agent exists, deliberately. Guardrails bolted on after the
 * thing they guard are guardrails somebody has already worked around - and the
 * failure mode here is not an agent that writes bad code. Bad code is caught by
 * the same review everything else goes through. The failure mode is an agent
 * that **makes the evidence agree with it**: edits the test that failed, relaxes
 * the check that blocked it, regenerates the snapshot that disagreed, and
 * presents a green pipeline as a fix.
 *
 * That is not a hypothetical failure of alignment. It is the locally optimal
 * move for anything optimising "make the build pass", and it is what a person
 * under deadline sometimes does too. The difference is that a person leaves a
 * commit somebody recognises.
 *
 * ## Refusals, not warnings
 *
 * Every rule here refuses. A repair that touched a forbidden path and said so in
 * its description would be a repair that gets merged on a Friday by somebody
 * reading the summary rather than the diff.
 *
 * ## Where this sits
 *
 * Pure, and separate from anything that runs an agent, for the reason
 * `reusePlan` and `rerunPlan` are: this is the decision people will argue about,
 * and an argument settled by reading a test is shorter than one settled by
 * inspecting a merged pull request. Nothing here talks to a model, a runner, or
 * a repository.
 */

/** What a repository allows an automated repair to touch. */
export interface RepairPolicy {
  /**
   * Whether repair is on at all.
   *
   * Off by default and opt-in per repository or workflow, because "an agent may
   * push branches to this repository" is a decision somebody makes rather than
   * one they discover.
   */
  enabled: boolean
  /**
   * Paths a repair may never change, as `*` patterns.
   *
   * The defaults are the validation surface: the workflows that decide what
   * passing means, the tests that decide whether it did, the lockfiles that
   * decide what was run against, and the generated snapshots that are the
   * record of previous agreement. An agent that may edit these can always make
   * the build green, which makes a green build worth nothing.
   */
  forbiddenPaths: string[]
  /** How many repair attempts one failing run may produce. */
  maxAttempts: number
  /** How long a repair may take, in minutes, across all its attempts. */
  maxMinutes: number
  /** What one repair may cost, in whatever unit the operator is billed in. Zero for no ceiling. */
  maxCost: number
  /** Which failed steps may trigger one. Empty means any of them. */
  steps: string[]
}

/**
 * The defaults, which are the safe reading of every question.
 *
 * A repository that has said nothing has not opted in, and the forbidden list is
 * the one somebody would write after the first incident rather than before it.
 */
export function defaultRepairPolicy(): RepairPolicy {
  return {
    enabled: false,
    forbiddenPaths: [
      '.github/workflows/**',
      '.reviewos/workflows/**',
      '.reviewos/branch-protection*',
      '**/*.test.*',
      '**/*.spec.*',
      'tests/**',
      'spec/**',
      '**/__snapshots__/**',
      '**/*.snap',
      'bun.lock',
      'package-lock.json',
      'pnpm-lock.yaml',
      'yarn.lock',
    ],
    maxAttempts: 2,
    maxMinutes: 20,
    maxCost: 0,
    steps: [],
  }
}

export type RepairRefusal =
  | 'not-enabled'
  | 'step-not-selected'
  | 'attempts-spent'
  | 'time-spent'
  | 'cost-spent'
  | 'forbidden-path'
  | 'weakens-a-required-check'
  | 'self-approval'

export interface RepairVerdict {
  ok: boolean
  refusal?: RepairRefusal
  /** One sentence, for the audit entry and for whoever reads the refusal. */
  reason?: string
}

const ALLOWED: RepairVerdict = { ok: true }

/**
 * Whether a failing step may start a repair at all.
 *
 * Asked before anything is spent - a budget checked after the model has run is
 * a budget that bills for the answer it then throws away.
 */
export function mayAttemptRepair(input: {
  policy: RepairPolicy
  /** The step that failed, by name. */
  step: string
  /** Repairs already attempted for this run. */
  attempts: number
  /** Minutes already spent across those attempts. */
  minutesSpent: number
  /** Cost already incurred, in the operator's unit. */
  costSpent: number
}): RepairVerdict {
  if (!input.policy.enabled)
    return { ok: false, refusal: 'not-enabled', reason: 'Automated repair is not enabled for this repository.' }

  /*
   * A selected-steps list is an allowlist. "Repair the flaky end-to-end suite"
   * is a sentence somebody means; "repair anything that goes red" is one nobody
   * does, and the second is what an empty list would mean if it were a denylist.
   */
  if (input.policy.steps.length > 0 && !input.policy.steps.includes(input.step))
    return { ok: false, refusal: 'step-not-selected', reason: `\`${input.step}\` is not a step this repository asks for repairs on.` }

  if (input.attempts >= input.policy.maxAttempts)
    return { ok: false, refusal: 'attempts-spent', reason: `This run has already had ${input.attempts} repair attempts.` }

  if (input.minutesSpent >= input.policy.maxMinutes)
    return { ok: false, refusal: 'time-spent', reason: `Repair for this run has used its ${input.policy.maxMinutes} minutes.` }

  if (input.policy.maxCost > 0 && input.costSpent >= input.policy.maxCost)
    return { ok: false, refusal: 'cost-spent', reason: 'Repair for this run has used its cost budget.' }

  return ALLOWED
}

/**
 * Whether the change a repair produced may be proposed.
 *
 * The second gate, and the one that matters. The first says a repair may be
 * *tried*; this says what came back may be *offered* - and an agent that spent
 * its budget producing a diff nobody may see has cost money, which is far
 * cheaper than one that produced a diff nobody should have seen.
 */
export function mayProposeRepair(input: {
  policy: RepairPolicy
  /** Every path the repair changed. */
  paths: readonly string[]
  /** Whether the change would relax a check a branch rule requires. */
  weakensRequiredCheck?: boolean
}): RepairVerdict {
  if (input.weakensRequiredCheck) {
    /*
     * The refusal the whole feature exists to make. An agent that may relax the
     * rule it failed can always succeed, and a green pipeline that was made
     * green by editing what green means is worse than a red one - a red one is
     * information.
     */
    return {
      ok: false,
      refusal: 'weakens-a-required-check',
      reason: 'This repair would relax a check a branch rule requires, which is making the evidence agree with it rather than fixing anything.',
    }
  }

  for (const path of input.paths) {
    const forbidden = input.policy.forbiddenPaths.find(pattern => matchesPath(pattern, path))

    if (forbidden) {
      return {
        ok: false,
        refusal: 'forbidden-path',
        reason: `This repair changes \`${path}\`, which this repository does not allow an automated repair to touch (\`${forbidden}\`).`,
      }
    }
  }

  return ALLOWED
}

/**
 * Whether the account that proposed a repair may also approve it.
 *
 * It may not, ever, and this takes no policy: an approval is a second person,
 * and a rule an operator could switch off would be a rule that gets switched
 * off during the incident it exists for.
 */
export function mayApproveRepair(input: { proposedBy: number | null, approvingAs: number | null }): RepairVerdict {
  if (input.proposedBy !== null && input.proposedBy === input.approvingAs) {
    return {
      ok: false,
      refusal: 'self-approval',
      reason: 'The account that proposed this repair cannot approve it. An approval is a second person.',
    }
  }

  return ALLOWED
}

/**
 * A path against a `*` / `**` pattern.
 *
 * `**` crosses directory separators and `*` does not, which is the convention
 * every one of these files already uses. Escaped before the wildcards go back,
 * so a dot in a pattern is a dot - a matcher whose dots are wildcards forbids
 * less than it appears to, and this one's job is forbidding.
 */
export function matchesPath(pattern: string, path: string): boolean {
  const cleaned = String(path ?? '').replace(/^\.\//, '')

  const expression = String(pattern ?? '')
    .split('**')
    .map(part => part
      .split('*')
      .map(piece => piece.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
      .join('[^/]*'))
    .join('.*')

  return new RegExp(`^${expression}$`).test(cleaned)
}

/**
 * Whether a restart-from-step may actually skip the steps it was told to skip.
 *
 * The control plane decides *which* steps a restart keeps, in `reusePlan`, and
 * it decides it from the recorded step rows: unchanged, succeeded, and with a
 * result to hand on. That is the right test for what a step **returned**. It
 * is no test at all for what a step **left on disk**, and for most steps the
 * output that matters is the second kind - the checkout, the installed tools,
 * the dependencies, the build.
 *
 * `reusePlan` cannot see a workspace. It runs in the API, hours earlier, and
 * the machine that will claim the next attempt has not been chosen yet. The
 * runner is the only place that knows, and it knows it at exactly one moment:
 * after the workspace is acquired, before the first step runs.
 *
 * ## The failure this exists for
 *
 * A deploy job on a temporary-workspace runner was restarted from its verify
 * step. The attempt landed in a fresh `/tmp/reviewos-job-12983-xF3QYB`, the
 * five steps before it reported "Kept from an earlier attempt", and the verify
 * step then died in seven seconds:
 *
 *     buddy: could not locate CLI entrypoint. Tried: ...
 *
 * because nothing had ever been installed in that directory. The job had been
 * told its dependencies were there on the strength of a row in a database.
 *
 * It does not reproduce on every runner, which is why it survived: a runner
 * with a configured `workspaceRoot` uses `job-<id>`, which is the same path on
 * every attempt, so the earlier attempt's files really are still there and the
 * skip really is sound. A runner on temporary workspaces journals a new
 * directory per attempt, and there the same skip is a lie.
 *
 * ## Why an empty workspace is the test
 *
 * It is the one thing that is both knowable and decisive. Nothing can tell
 * whether step 4 of a particular workflow left anything behind - that is the
 * workflow author's business - but a workspace with nothing in it cannot be
 * holding the output of a step that has supposedly already run. It is the
 * precise condition for the bug above, and it is false on every runner where
 * from-step restart works today, so the feature keeps working where it worked.
 *
 * The answer when the skip cannot be honoured is to run those steps, not to
 * refuse the job: the person pressed restart because they wanted the job run
 * again, and running more of it than they asked for is the safe direction to
 * be wrong in. Running *less* of it is how a deploy reports success having
 * deployed nothing.
 */
export interface ResumeDecision {
  /** Whether the kept steps stand. */
  keep: boolean
  /**
   * Why not, when not. Empty when the steps stand.
   *
   * Written for the job log rather than for a developer, because that is where
   * it is read: by somebody who pressed "Restart here" and is about to watch
   * the job do more than they asked.
   */
  reason: string
}

export function keepResumedSteps(input: {
  /** How many leading steps this attempt was told it may skip. */
  kept: number
  /**
   * Whether this attempt's workspace is a directory of its own, made for it.
   *
   * The decisive one, and the reason this is not simply "is the workspace
   * empty". A runner on temporary workspaces journals a new directory per
   * attempt, so whatever the earlier steps left is in a directory this attempt
   * has no path to - and that stays true however full this one gets. A runner
   * that checks the repository out before the first step would otherwise look
   * like it had inherited something, when all it has is a checkout and none of
   * the installing and building the skipped steps were supposed to have done.
   */
  fresh: boolean
  /**
   * How many entries the workspace holds before the first step runs.
   *
   * Only consulted for a workspace that was not made for this attempt. A
   * stable `job-<id>` that is empty has been cleaned between attempts, and is
   * then no better than a fresh one.
   */
  entries: number
}): ResumeDecision {
  // Nothing to decide: an ordinary attempt skips nothing, so the state of the
  // workspace is just a description of the checkout about to happen.
  if (input.kept <= 0)
    return { keep: true, reason: '' }

  const steps = input.kept === 1 ? 'step' : 'steps'
  const them = input.kept === 1 ? 'it' : 'they'

  if (input.fresh) {
    return {
      keep: false,
      reason: `This restart was told it could begin after ${input.kept} ${steps}, but this attempt has a new workspace of its own, so whatever ${them} left on disk - a checkout, installed tools, dependencies - is in the directory the earlier attempt used and not in this one. Running ${them} again rather than running later steps against a workspace that does not have what they need.`,
    }
  }

  if (input.entries === 0) {
    return {
      keep: false,
      reason: `This restart was told it could begin after ${input.kept} ${steps}, but the workspace it is running in is empty, so whatever ${them} left on disk is not here. Running ${them} again rather than running later steps against a workspace that does not have what they need.`,
    }
  }

  return { keep: true, reason: '' }
}

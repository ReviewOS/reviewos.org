import { Job } from '@stacksjs/queue'
import { db } from '@stacksjs/database'
import { repairPolicyFor } from '../Actions/Workflow/repairPolicy'
import { finishAttempt } from '../Actions/Workflow/repairAttempts'
import { mintRepairCredential, revokeRepairCredential } from '../Actions/Workflow/repairCredential'
import { proposeRepair, repairBranch } from '../Actions/Workflow/repairAgent'
import { configured } from '../../config/ci-repair'

/**
 * Perform one repair attempt, off the request path.
 *
 * The failure hook decides *whether*; this does it. The split is not
 * organisational - a repair calls a model and writes a commit, and doing either
 * inside a runner's report would make a runner's `POST` wait on somebody else's
 * inference.
 *
 * ## What "the same isolation boundary as any other untrusted job" means here
 *
 * The roadmap asks for repair to run inside the runner sandbox, on the grounds
 * that it is untrusted work. That framing is worth being precise about, because
 * the honest answer is a *narrower* claim than the roadmap's, not a wider one.
 *
 * This job never executes the repository's code. It reads blobs, calls a model,
 * and writes a commit through git plumbing - so the sandbox that exists to
 * contain somebody else's `npm test` is not the thing protecting anybody here.
 * What is untrusted is the **content**: the log the model reads is written by
 * the repository, and the diff the model returns is a stranger's proposal. Both
 * are handled by containment on the output side - `mayProposeRepair` refuses the
 * whole diff on one forbidden path - rather than by containment on the process.
 *
 * The part the roadmap actually wants is still true, and by construction rather
 * than by assertion: whether the repair *works* is never decided here. It is
 * decided by an ordinary workflow run against the proposed branch, on a runner,
 * in the same sandbox and under the same quotas as anything else - because a
 * branch is a branch, and nothing about this one is special-cased.
 *
 * `tries: 1`, deliberately. A repair that failed halfway has spent an attempt
 * from a budget somebody is billed for, and a queue that silently tried again
 * would make `max_attempts` a number that means something other than what it
 * says. Retrying is a decision for the next failure, through the hook, with the
 * budget checked.
 */
export default new Job({
  name: 'RepairJob',
  description: 'Propose an automated repair for a failed workflow job',
  queue: 'default',
  tries: 1,

  async handle(payload: {
    attemptId: number
    repositoryId: number
    runId: number
    jobId: number
    step: string
  }) {
    const attemptId = Number(payload?.attemptId ?? 0)
    const repositoryId = Number(payload?.repositoryId ?? 0)
    const runId = Number(payload?.runId ?? 0)

    if (!attemptId || !repositoryId || !runId)
      return { skipped: 'the repair was dispatched without enough to identify it' }

    /*
     * The instance's own switch, checked here as well as being the reason the
     * key exists. A repository can turn repair on against an instance that
     * cannot perform one, and the useful thing to do about that is write a
     * refusal somebody can read from the repository rather than fail silently.
     */
    if (!configured()) {
      await finishAttempt(attemptId, {
        state: 'failed',
        reason: 'This instance has no model credentials, so it cannot perform a repair.',
      })

      return { skipped: 'no model credentials' }
    }

    const policy = await repairPolicyFor(repositoryId)

    /*
     * Re-read rather than carried in the payload.
     *
     * A policy that was turned off between the hook and this job must win. The
     * queue is not instant, and "we disabled it" is exactly the thing somebody
     * does while an agent is doing something they did not expect.
     */
    if (!policy.enabled) {
      await finishAttempt(attemptId, {
        state: 'refused',
        refusal: 'not-enabled',
        reason: 'Automated repair was turned off before this attempt ran.',
      })

      return { skipped: 'repair was turned off' }
    }

    const run: any = await db
      .selectFrom('workflow_runs')
      .select(['actor_id'])
      .where('id', '=', runId)
      .executeTakeFirst()
      .catch(() => null)

    const actorId = Number(run?.actor_id ?? 0) || null

    // The same name the agent will write to. Computed in one place, because two
    // copies of a branch name is a credential scoped to a branch nothing uses.
    const branch = repairBranch(runId, attemptId)

    /*
     * Minted before the model runs and revoked in `finally`, so the window
     * where a credential exists is the window where work is happening - not the
     * hour an expiry would otherwise leave it lying in.
     */
    const credential = await mintRepairCredential({
      attemptId,
      repositoryId,
      actorId,
      branch,
      minutes: policy.maxMinutes,
    })

    const started = Date.now()

    try {
      const outcome = await proposeRepair({
        attemptId,
        repositoryId,
        runId,
        jobId: Number(payload?.jobId ?? 0),
        step: String(payload?.step ?? ''),
        policy,
        actorId,
      })

      const minutes = Math.max(0, Math.round((Date.now() - started) / 60_000))

      if (!outcome.ok) {
        await finishAttempt(attemptId, {
          // A refusal and a failure are different rows on purpose: "not allowed
          // to" and "could not" are the two answers anybody asks this table
          // for, and one state would merge them.
          state: outcome.refusal ? 'refused' : 'failed',
          refusal: outcome.refusal ?? null,
          reason: outcome.reason,
          minutes,
          tokens: outcome.tokens ?? 0,
          cost: outcome.cost ?? 0,
        })

        return { proposed: false, reason: outcome.reason }
      }

      await finishAttempt(attemptId, {
        state: 'proposed',
        /*
         * The summary, and the pull request's failure when there was one.
         *
         * A branch that landed without a pull request is still a proposal - the
         * commit is the artefact - but it is one nobody will be shown, so the
         * reason it was not offered belongs where somebody reading the attempt
         * will find it rather than only in a log line.
         */
        reason: outcome.pullRequestError
          ? `${outcome.summary}\n\nNo pull request was opened: ${outcome.pullRequestError}`
          : outcome.summary,
        branch: outcome.branch,
        commitSha: outcome.sha,
        pullRequestId: outcome.pullRequest?.id ?? null,
        minutes,
        tokens: outcome.tokens,
        cost: outcome.cost,
      })

      /*
       * The original run is **not** touched, and there is deliberately no code
       * here that could. A repair that marked its own trigger green would be
       * the failure the whole policy exists to prevent, and the way to be sure
       * of that is for this file to have no such statement in it.
       */
      return {
        proposed: true,
        branch: outcome.branch,
        commit: outcome.sha,
        paths: outcome.paths,
        pullRequest: outcome.pullRequest?.number ?? null,
      }
    }
    catch (error) {
      await finishAttempt(attemptId, {
        state: 'failed',
        reason: String((error as Error)?.message ?? error).slice(0, 2000),
        minutes: Math.max(0, Math.round((Date.now() - started) / 60_000)),
      })

      return { proposed: false, reason: 'the repair job failed' }
    }
    finally {
      if (credential)
        await revokeRepairCredential(attemptId)
    }
  },
})

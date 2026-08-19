/**
 * Running a run again, without losing the run that failed.
 *
 * The button everybody presses, and the one this instance did not have. Every
 * decision here is about the same thing: **a re-run must not make the first
 * attempt unreadable.** Somebody re-runs a job to compare it against the
 * failure, and a system that overwrites the failure has thrown away the reason
 * they pressed it.
 *
 * So a re-run is not a second run. The commit, the workflow version and the
 * number are the same, and two rows would leave a reader guessing which was the
 * answer; it is a second *attempt*, which is what `GITHUB_RUN_ATTEMPT` means and
 * what every action naming a cache after it expects. The logs of the earlier
 * attempt keep their attempt number and stay where they are.
 */

import { db } from '@stacksjs/database'
import type { RecordedStep, ReuseDecision } from './reuse'
import { recordedOutputs, reusePlan, signatureOf, skipThrough } from './reuse'
import { settleRun } from './settle'

/**
 * What to run again.
 *
 * `step` is the narrow one and the only one that skips work: it restarts a
 * single job from a named step and keeps what the steps before it recorded.
 * The other three start every job they touch from the top, because a re-run
 * lands on a fresh machine with none of the workspace the earlier attempt left
 * behind - skipping a checkout there hands the next step an empty directory.
 */
export type RerunScope = 'all' | 'failed' | 'job' | 'step'

export interface RerunCandidate {
  id: number
  job_id: string
  state: string
  needs?: string | null
  kind?: string | null
}

/**
 * Which jobs a re-run touches.
 *
 * Pure, because this is the decision people will argue about and the one a test
 * can pin: re-running "failed jobs" has to include the jobs that never ran
 * *because* those failed, or the second attempt reports a run that is still
 * missing half its work and calls it green.
 */
export function rerunPlan(input: {
  jobs: readonly RerunCandidate[]
  scope: RerunScope
  /** The job to re-run, for `scope: 'job'`. */
  jobKey?: string | null
}): RerunCandidate[] {
  if (input.scope === 'all')
    return [...input.jobs]

  const chosen = new Map<number, RerunCandidate>()

  const take = (job: RerunCandidate): void => {
    chosen.set(job.id, job)
  }

  if (input.scope === 'job' || input.scope === 'step') {
    for (const job of input.jobs) {
      if (String(job.job_id) === String(input.jobKey ?? ''))
        take(job)
    }
  }
  else {
    for (const job of input.jobs) {
      // `cancelled` counts as failed here: a job somebody stopped, or that
      // fail-fast stopped, is one nobody has an answer for.
      if (['failed', 'cancelled'].includes(String(job.state)))
        take(job)
    }
  }

  /*
   * And everything downstream of what was chosen.
   *
   * A job that was skipped because its dependency failed has no result, and
   * re-running only the failure would leave the run finishing with those jobs
   * still skipped - green, with half the pipeline never having run. Repeated to
   * a fixed point, because the graph is deeper than one layer.
   */
  for (let pass = 0; pass < 20; pass++) {
    const before = chosen.size

    for (const job of input.jobs) {
      if (chosen.has(job.id))
        continue

      const needs = String(job.needs ?? '').split('\n').map(one => one.trim()).filter(Boolean)

      if (needs.some(need => [...chosen.values()].some(one => String(one.job_id) === need)))
        take(job)
    }

    if (chosen.size === before)
      break
  }

  return [...chosen.values()]
}

/** The state a job goes back to: `queued` if nothing gates it, `blocked` if something does. */
export function resetState(job: RerunCandidate): 'queued' | 'blocked' {
  const needs = String(job.needs ?? '').split('\n').map(one => one.trim()).filter(Boolean)

  /*
   * The same rule the dispatcher uses when it creates the graph: anything the
   * control plane resolves itself - a barrier, a gate, a trigger - starts
   * blocked even with nothing to wait for, because `queued` means "a runner may
   * take this" and no runner may take those.
   */
  return needs.length > 0 || String(job.kind ?? 'command') !== 'command' ? 'blocked' : 'queued'
}

export interface RerunResult {
  ok: boolean
  /** The attempt number this run is now on. */
  attempt: number
  /** How many jobs went back into the graph. */
  jobs: number
  /** How many recorded step results this restart kept, for `scope: 'step'`. */
  reused?: number
  /**
   * Why the restart did not begin where it was asked to, when it did not.
   *
   * Empty when it did. A restart asked to skip further than `reusePlan` allows
   * is honoured as far as it can be rather than refused - the person still
   * wants the job run again - but silently starting eight steps earlier than
   * they asked would look like the feature not working.
   */
  reason?: string
  error?: string
  status?: number
}

/**
 * How far into a job a restart may actually skip, and why not further.
 *
 * `before` is what this job's rows say ran; `now` is what the workflow says the
 * job is. They are two records of one thing and they normally agree - the rows
 * were copied from the definition at dispatch - which is exactly why the
 * comparison is worth making: the cases where they *disagree* are a run
 * dispatched before steps were rows at all, and a definition that has been
 * rewritten underneath. Both are restarts that would skip a step whose recorded
 * result answers a question nobody is asking any more.
 */
export async function restartPlan(input: {
  runId: number
  jobId: number
  jobKey: string
  /** Where the caller asked to start, counting from zero. */
  from: number
}): Promise<{ decisions: ReuseDecision[], skip: number, reason: string }> {
  const recorded = await db
    .selectFrom('workflow_steps')
    .select(['position', 'state', 'outputs', 'command', 'uses', 'inputs', 'env', 'shell', 'working_directory', 'condition'])
    .where('workflow_job_id', '=', input.jobId)
    .orderBy('position')
    .execute()
    .catch(() => [])

  const before: RecordedStep[] = (recorded as any[]).map(step => ({
    position: Number(step.position ?? 0),
    signature: signatureOf(step),
    state: String(step.state ?? ''),
    outputs: recordedOutputs(step.outputs),
  }))

  const defined = await db
    .selectFrom('workflow_version_steps')
    .innerJoin(
      'workflow_version_jobs',
      'workflow_version_jobs.id',
      '=',
      'workflow_version_steps.workflow_version_job_id',
    )
    .innerJoin('workflow_runs', 'workflow_runs.workflow_version_id', '=', 'workflow_version_jobs.workflow_version_id')
    .select([
      'workflow_version_steps.position as position',
      'workflow_version_steps.command as command',
      'workflow_version_steps.uses as uses',
      'workflow_version_steps.inputs as inputs',
      'workflow_version_steps.env as env',
      'workflow_version_steps.shell as shell',
      'workflow_version_steps.working_directory as working_directory',
      'workflow_version_steps.condition as condition',
    ])
    .where('workflow_runs.id', '=', input.runId)
    .where('workflow_version_jobs.job_id', '=', input.jobKey)
    .orderBy('workflow_version_steps.position')
    .execute()
    .catch(() => [])

  /*
   * A generated job is compared against itself, and that is not a loophole.
   *
   * A job another job uploaded was in no workflow file, so the version tables
   * have nothing to compare it to - and treating "no definition" as "the
   * definition changed" would refuse every restart of exactly the jobs whose
   * steps are longest. Its rows *are* the definition; the state and outputs
   * checks still decide, which are the two that carry the safety.
   */
  const now: RecordedStep[] = defined.length > 0
    ? (defined as any[]).map(step => ({
        position: Number(step.position ?? 0),
        signature: signatureOf(step),
        state: '',
        outputs: null,
      }))
    : before.map(step => ({ ...step }))

  const decisions = reusePlan(before, now)
  const allowed = skipThrough(decisions)
  const skip = Math.max(0, Math.min(input.from, allowed))

  return {
    decisions,
    skip,
    reason: skip < input.from
      ? `this restart begins at step ${skip + 1} rather than ${input.from + 1}: ${decisions[skip]?.reason ?? 'an earlier step cannot be skipped'}`
      : '',
  }
}

/**
 * Run it again.
 *
 * Refuses a run that has not finished. Re-running a live run would mean two
 * attempts of the same job in flight, and the second one's report landing on a
 * row the first is still holding - the exact confusion the lease exists to
 * prevent.
 */
export async function rerunRun(input: {
  runId: number
  scope: RerunScope
  jobKey?: string | null
  /**
   * Which step to restart from, for `scope: 'step'`.
   *
   * A step's `id:`, its name, or a position counting from one - because those
   * are the three things a person has in front of them, and asking which one
   * the API wants is asking them to know how the row is keyed.
   */
  step?: string | null
  now?: Date
}): Promise<RerunResult> {
  const now = input.now ?? new Date()

  const run = await db
    .selectFrom('workflow_runs')
    .select(['id', 'state', 'attempt'])
    .where('id', '=', input.runId)
    .executeTakeFirst()

  if (!run)
    return { ok: false, attempt: 0, jobs: 0, error: 'No such run', status: 404 }

  if (!['succeeded', 'failed', 'cancelled'].includes(String(run.state))) {
    return {
      ok: false,
      attempt: Number(run.attempt ?? 1),
      jobs: 0,
      error: 'This run has not finished. Cancel it first, or wait for it.',
      status: 409,
    }
  }

  const jobs = await db
    .selectFrom('workflow_jobs')
    .select(['id', 'job_id', 'state', 'needs', 'kind', 'attempt'])
    .where('workflow_run_id', '=', input.runId)
    .execute()

  const chosen = rerunPlan({ jobs, scope: input.scope, jobKey: input.jobKey })

  if (chosen.length === 0) {
    return {
      ok: false,
      attempt: Number(run.attempt ?? 1),
      jobs: 0,
      // Said rather than answered with a cheerful nothing: "re-run failed jobs"
      // on a run that did not fail is somebody looking at the wrong run.
      error: input.scope === 'job' || input.scope === 'step'
        ? 'This run has no job by that name.'
        : 'Nothing in this run failed, so there is nothing to run again.',
      status: 422,
    }
  }

  const attempt = Number(run.attempt ?? 1) + 1

  /*
   * Where a restart-from-step actually begins.
   *
   * Resolved before anything is written, because the answer can be a refusal:
   * a step nobody can name is a typo, and starting the job from the top
   * "helpfully" would run twenty minutes of work the person was trying to skip.
   */
  let restart: { jobId: number, skip: number, reason: string } | null = null

  if (input.scope === 'step') {
    const target = chosen.find(job => String(job.job_id) === String(input.jobKey ?? ''))
    const asked = await positionOfStep(Number(target?.id ?? 0), input.step)

    if (!target || asked === null) {
      return {
        ok: false,
        attempt: Number(run.attempt ?? 1),
        jobs: 0,
        error: `This job has no step \`${String(input.step ?? '')}\`. Name it by its \`id:\`, by its name, or by its position.`,
        status: 422,
      }
    }

    const plan = await restartPlan({
      runId: input.runId,
      jobId: Number(target.id),
      jobKey: String(target.job_id),
      from: asked,
    })

    restart = { jobId: Number(target.id), skip: plan.skip, reason: plan.reason }
  }

  for (const job of chosen) {
    /*
     * The job's steps go back to pending, and until now they did not.
     *
     * A re-run reset the job row and left the step rows holding the last
     * attempt's states, so the run screen showed a queued job made of succeeded
     * steps - which reads as work that is somehow both waiting and done.
     */
    const skip = restart && restart.jobId === Number(job.id) ? restart.skip : 0

    await resetSteps(Number(job.id), skip, Number((job as any).attempt ?? 1))

    await db
      .updateTable('workflow_jobs')
      .set({
        state: resetState(job),
        // Where this attempt starts, which is the beginning unless somebody
        // asked otherwise and `reusePlan` agreed.
        resume_from_step: skip > 0 ? skip : null,
        /*
         * Everything the last attempt left behind goes with it. A row that kept
         * its runner or its lease would be claimable by the machine that held
         * it, and one that kept its outputs would hand a dependent job values
         * from a run that has been superseded.
         */
        attempt: Number((job as any).attempt ?? 1) + 1,
        runner_id: null,
        lease_expires_at: null,
        job_token_hash: null,
        /*
         * And the approval, which is the one that matters most.
         *
         * An approval belongs to the attempt it was given for. A re-run that
         * kept it would ship a deployment on a decision somebody made about a
         * different attempt - the same failure as a green check surviving a
         * re-run, one step further down the pipeline, and with the fleet's
         * machines already pointed at production.
         *
         * The gate is asked again when the job becomes eligible, by the same
         * code that asked the first time.
         */
        approved_at: null,
        approved_by_id: null,
        queued_at: resetState(job) === 'queued' ? now.toISOString() : null,
        started_at: null,
        finished_at: null,
        outputs: null,
        condition_reason: null,
      })
      .where('id', '=', job.id)
      .execute()
  }

  await db
    .updateTable('workflow_runs')
    .set({ state: 'queued', attempt, finished_at: null, conclusion_reason: null })
    .where('id', '=', input.runId)
    .execute()

  // Settled straight away: a re-run whose first job is a barrier or a gate has
  // work for the control plane before any machine is involved.
  await settleRun(input.runId, now)

  return {
    ok: true,
    attempt,
    jobs: chosen.length,
    reused: restart?.skip ?? 0,
    reason: restart?.reason ?? '',
  }
}

/**
 * Which step somebody meant.
 *
 * Three ways to say it, in the order they are unambiguous: a step's `id:` is a
 * name the workflow author chose and the only one guaranteed unique, its `name`
 * is what the screen shows, and a bare number is the position a person counts
 * off that screen - from one, because no interface anywhere numbers the first
 * step zero.
 */
async function positionOfStep(jobId: number, reference: string | null | undefined): Promise<number | null> {
  const wanted = String(reference ?? '').trim()

  if (!wanted)
    return null

  const steps = await db
    .selectFrom('workflow_steps')
    .select(['position', 'name', 'step_id'])
    .where('workflow_job_id', '=', jobId)
    .orderBy('position')
    .execute()
    .catch(() => [])

  const byId = (steps as any[]).find(step => String(step.step_id ?? '') === wanted)

  if (byId)
    return Number(byId.position ?? 0)

  const byName = (steps as any[]).find(step => String(step.name ?? '') === wanted)

  if (byName)
    return Number(byName.position ?? 0)

  const counted = Number(wanted)

  if (Number.isInteger(counted) && counted >= 1) {
    const byPosition = (steps as any[]).find(step => Number(step.position ?? 0) === counted - 1)

    if (byPosition)
      return counted - 1
  }

  return null
}

/**
 * Put a job's steps back, keeping the first `skip` of them.
 *
 * The kept rows are not rewritten except to say who produced them: their state,
 * timings and outputs are the earlier attempt's answers, which is the entire
 * value of keeping them. `reused_from_attempt` is what stops the next screen
 * from claiming this attempt did that work - and it carries forward across a
 * second restart, so a result produced on attempt one still says one after
 * being kept through attempts two and three.
 */
async function resetSteps(jobId: number, skip: number, attempt: number): Promise<void> {
  if (skip > 0) {
    await db
      .updateTable('workflow_steps')
      .set({ reused_from_attempt: attempt })
      .where('workflow_job_id', '=', jobId)
      .where('position', '<', skip)
      .whereNull('reused_from_attempt')
      .execute()
      .catch(() => null)
  }

  await db
    .updateTable('workflow_steps')
    .set({
      state: 'pending',
      exit_code: null,
      started_at: null,
      finished_at: null,
      outputs: null,
      queued_ms: null,
      active_ms: null,
      attempts: 0,
      reused_from_attempt: null,
    })
    .where('workflow_job_id', '=', jobId)
    .where('position', '>=', skip)
    .execute()
    .catch(() => null)
}

/**
 * Move a run's graph forward, from wherever it now is.
 *
 * Four decisions, in an order that matters: stop the matrix combinations a
 * `fail-fast` failure takes with it, skip whatever can no longer run, queue
 * whatever has just been unblocked, and then say what the run itself is.
 *
 * **It lives here rather than in the reporter because two things move a run.** A
 * report is one; the sweep that force-cancels an unacknowledged job or reclaims
 * a dead runner's work is the other, and it used to recompute only the run's
 * state. So a job the sweep cancelled left its dependants in `blocked` forever,
 * and a run with a blocked job never reaches a terminal state - a pull request
 * whose checks stay pending on work that ended an hour ago.
 *
 * Derived from the rows rather than accumulated, so a control plane that
 * restarted mid-run reaches the same answer as one that watched every
 * transition.
 */

import { db } from '@stacksjs/database'
import type { GateDecision } from './environments'
import { decideGate, environmentRules } from './environments'
import { dispatchWorkflowRun, releaseGroup, startRun } from './dispatch'
import { callMarkerOf, resolveCallOutputs } from './callOutputs'
import { alreadySent, waitPlan, waitSettingsOf } from './awaits'
import type { ChecksState } from './environments'
import { deliverJobNotify } from './notify'
import { deliverRunNotifications } from './notifyDelivery'
import { withRedeliveryKey } from './redelivery'
import type { JobState } from './states'
import { cancelOnFailingCasualties, effectiveState, eligibleJobs, failFastCasualties, runStateFromJobs, unreachableJobs } from './states'
import { isNotFalse, isTrue, rowsChanged } from '../Support/sql'
import { announceActionRequiredFor } from './announce'

/**
 * What a job cancelled by a sibling is told, on its own row.
 *
 * A cancelled job with no reason is the worst row on a run page: no logs, no
 * failure, no explanation, and the obvious guess - that somebody pressed
 * cancel - is wrong. `fail-fast` is a decision the workflow made, so it says so
 * where the decision landed.
 *
 * Plain prose, no markup: it is rendered as text on the run page, and backticks
 * that read as code in a file read as typing mistakes on a screen.
 */
/**
 * How far a chain of triggers may go.
 *
 * Five, which is more than any real pipeline nests and few enough that a loop
 * costs five runs rather than a database. The same shape as the reusable
 * workflow call depth, and for the same reason.
 */
export const MAX_TRIGGER_DEPTH = 5

export const FAIL_FAST_REASON = 'Stopped because another combination of this matrix failed and fail-fast is on.'

/**
 * What a job stopped by a sunk run is told, on its own row.
 *
 * The same rule as the fail-fast reason above: a cancelled job with no
 * explanation is the worst row on a run page, and the obvious guess - that
 * somebody pressed cancel - is wrong.
 */
export const CANCEL_ON_FAILING_REASON = 'Stopped because the run had already failed and this job asked not to keep going.'

async function jobsOfRun(runId: number): Promise<any[]> {
  return db
    .selectFrom('workflow_jobs')
    .select(['id', 'job_id', 'state', 'needs', 'continue_on_error', 'fail_fast', 'kind', 'settings', 'approved_at', 'started_at', 'notified_at'])
    .where('workflow_run_id', '=', runId)
    .execute()
}

/** A job's `reviewos:` settings, which are JSON in a column. */
function settingsOf(job: any): Record<string, unknown> {
  try {
    const parsed = JSON.parse(String(job?.settings ?? '{}'))

    return parsed && typeof parsed === 'object' ? parsed : {}
  }
  catch {
    return {}
  }
}

/**
 * The run's jobs in the shape the graph reads, ids and all.
 *
 * The id travels with the row rather than being looked up afterwards, and that
 * is a fix rather than a tidy-up: this used to find the row to move by matching
 * `job_id`, which finds *one* row per name - so a matrix of four had three
 * combinations that could never be unblocked or skipped.
 */
function graphRows(jobs: readonly any[]): Array<{
  id: number
  job_id: string
  state: JobState
  needs: string | null
  continue_on_error: boolean
  fail_fast: boolean
  allow_failure: boolean
  cancel_on_build_failing: boolean
  kind: string
}> {
  return jobs.map(job => ({
    id: Number(job.id),
    job_id: String(job.job_id),
    state: String(job.state) as JobState,
    needs: job.needs ?? null,
    continue_on_error: isTrue(job.continue_on_error),
    fail_fast: isNotFalse(job.fail_fast),
    // A barrier that was told to let the run past a failure. The graph reads
    // this; nothing else needs to know it came from `wait:`.
    allow_failure: settingsOf(job).continueOnFailure === true,
    // And whether this job asked to be stopped once the run is going to fail,
    // out of the same blob rather than a second read.
    cancel_on_build_failing: settingsOf(job).cancelOnBuildFailing === true,
    kind: String(job.kind ?? 'command'),
  }))
}

/** The run's state after settling it, which is what the caller announces. */
export async function settleRun(runId: number, now: Date = new Date()): Promise<string> {
  /*
   * Settled to a fixed point rather than in one pass.
   *
   * A pass can move the graph in a way that lets the next one move it again: a
   * barrier satisfies itself the moment its dependencies finish, and the gate
   * behind it becomes eligible *in the same instant* - but eligibility was
   * computed from rows read before the barrier moved. One pass left the gate
   * blocked until something unrelated happened to settle the run again, which
   * is the shape of bug that looks like "sometimes the approval never appears".
   *
   * Bounded, because a fixed-point loop with a bug in it is an infinite one.
   * Ten is far more than the deepest chain of control-plane jobs a graph can
   * have, since each pass resolves a whole layer.
   */
  for (let pass = 0; pass < 10; pass++) {
    if (!await settleOnce(runId, now))
      break
  }

  return recordRunState(runId, now)
}

/**
 * One pass over the graph. Answers whether anything moved.
 *
 * Split out from `settleRun` so the loop above has something to ask.
 */
/**
 * Whether this run is holding for somebody to approve it.
 *
 * Read rather than passed in, because every caller of the settler would
 * otherwise have to know about the fork policy - and the one that forgot would
 * be the one that released a stranger's code.
 */
/**
 * Which repository a run belongs to.
 *
 * Read on demand rather than threaded through the settler: this is asked only
 * when something has actually stopped and needs announcing, which on almost
 * every settle is never.
 */
async function repositoryOfRun(runId: number): Promise<number> {
  const run = await db
    .selectFrom('workflow_runs')
    .select(['repository_id'])
    .where('id', '=', runId)
    .executeTakeFirst()
    .catch(() => null)

  return Number(run?.repository_id ?? 0)
}

async function awaitingApproval(runId: number): Promise<boolean> {
  const run = await db
    .selectFrom('workflow_runs')
    .select(['approval_state'])
    .where('id', '=', runId)
    .executeTakeFirst()
    .catch(() => null)

  return String(run?.approval_state ?? 'not-required') === 'required'
}

async function settleOnce(runId: number, now: Date): Promise<boolean> {
  /*
   * A run waiting for a person to approve it moves for nobody.
   *
   * The fork policy's hold. Without this the settler would release the graph
   * the moment the run was created - the jobs have no unmet `needs:`, which is
   * exactly why they are eligible - and the hold would be a state on a row that
   * nothing enforced.
   */
  if (await awaitingApproval(runId))
    return false

  let moved = false
  let jobs = await jobsOfRun(runId)

  /*
   * Anybody a finished job was told to notify.
   *
   * Here rather than in the report endpoint because a job reaches a terminal
   * state by four different routes - a runner reporting, a lease lapsing,
   * `fail-fast`, a cancellation - and a notification wired to one of them is
   * one that silently does not happen for the other three. The delivery is
   * claimed with a guarded write, so running on every pass costs a query rather
   * than a duplicate.
   */
  for (const job of jobs) {
    const state = String(job.state ?? '')

    if (['succeeded', 'failed', 'cancelled'].includes(state) && !job.notified_at)
      await deliverJobNotify({ jobId: Number(job.id), state })
  }

  /*
   * `fail-fast` first, because it decides what the rest of the graph is looking
   * at: a combination this stops is one nothing downstream should be unblocked
   * by, and running it in the other order would queue a job for a matrix that
   * is already being torn down.
   */
  const casualties = failFastCasualties(graphRows(jobs))

  for (const job of casualties.cancel) {
    await db
      .updateTable('workflow_jobs')
      .set({ state: 'cancelled', finished_at: now.toISOString(), condition_reason: FAIL_FAST_REASON })
      .where('id', '=', job.id)
      .where('state', 'in', ['blocked', 'queued'])
      .execute()
  }

  for (const job of casualties.stop) {
    /*
     * A combination already on a machine is asked to stop, not declared
     * stopped - the same cooperative shape as cancelling a run, and for the
     * same reason: this instance does not control the machine. The lease is
     * revoked in the same write, so whatever holds it can no longer report a
     * result over a decision that has been made.
     */
    await db
      .updateTable('workflow_jobs')
      .set({ state: 'cancelling', lease_expires_at: now.toISOString(), condition_reason: FAIL_FAST_REASON })
      .where('id', '=', job.id)
      .where('state', '=', 'running')
      .execute()
  }

  if (casualties.cancel.length > 0 || casualties.stop.length > 0) {
    moved = true
    jobs = await jobsOfRun(runId)
  }

  /*
   * And the jobs that asked to be stopped once the run is going to fail.
   *
   * After `fail-fast` rather than folded into it, because they answer different
   * questions: `fail-fast` is about one matrix's siblings and is on by default,
   * this is run-wide and opt-in. Running them in one pass would mean one rule
   * with two defaults, which is the shape nobody can read off a run page.
   */
  const sunk = cancelOnFailingCasualties(graphRows(jobs))

  for (const job of sunk.cancel) {
    await db
      .updateTable('workflow_jobs')
      .set({ state: 'cancelled', finished_at: now.toISOString(), condition_reason: CANCEL_ON_FAILING_REASON })
      .where('id', '=', job.id)
      .where('state', 'in', ['blocked', 'queued'])
      .execute()
  }

  for (const job of sunk.stop) {
    // Asked, not declared - and the lease goes with the ask, so whatever holds
    // it can no longer report a result over a decision already made.
    await db
      .updateTable('workflow_jobs')
      .set({ state: 'cancelling', lease_expires_at: now.toISOString(), condition_reason: CANCEL_ON_FAILING_REASON })
      .where('id', '=', job.id)
      .where('state', '=', 'running')
      .execute()
  }

  if (sunk.cancel.length > 0 || sunk.stop.length > 0) {
    moved = true
    jobs = await jobsOfRun(runId)
  }

  // Anything that can never run now, so the run can finish rather than wait on
  // a job whose dependency failed.
  const unreachable = unreachableJobs(graphRows(jobs))

  for (const job of unreachable) {
    await db
      .updateTable('workflow_jobs')
      .set({ state: 'skipped', finished_at: now.toISOString() })
      .where('id', '=', job.id)
      .where('state', '=', 'blocked')
      .execute()
  }

  if (unreachable.length > 0) {
    moved = true
    jobs = await jobsOfRun(runId)
  }

  // And anything whose dependencies have now all succeeded.
  const ready = eligibleJobs(graphRows(jobs))

  for (const job of ready) {
    /*
     * A job whose dependencies are satisfied, and what happens to it depends
     * on what kind of job it is.
     *
     * Only a `command` job joins the queue. The rest are the control plane's
     * own work: a barrier is *already* satisfied by having got here, a gate
     * waits for a person, and a trigger starts another run. None of them may
     * ever be handed to a machine - a runner deciding a deployment approval is
     * not a scheduling mistake, it is the gate not existing.
     */
    if (job.kind === 'wait') {
      /*
       * A barrier that represents a workflow call hands back what the called
       * workflow declared.
       *
       * This is the only place the `jobs` context exists: `value: ${{
       * jobs.build.outputs.version }}` is the called workflow's own view of
       * itself, and its jobs have only just finished. Stored on the barrier's
       * row, so the caller reads them the way it reads any other job's -
       * `needs.<call>.outputs.<name>`.
       */
      const marker = callMarkerOf(jobs.find(one => Number(one.id) === Number(job.id))?.settings)
      const outputs = marker
        ? await resolveCallOutputs({ runId, prefix: marker.prefix, versionId: marker.versionId })
        : null

      await db
        .updateTable('workflow_jobs')
        .set({
          state: 'succeeded',
          started_at: now.toISOString(),
          finished_at: now.toISOString(),
          ...(outputs && Object.keys(outputs).length > 0 ? { outputs: JSON.stringify(outputs) } : {}),
        })
        .where('id', '=', job.id)
        .where('state', '=', 'blocked')
        .execute()

      continue
    }

    if (job.kind === 'await') {
      /*
       * A run holding still for a clock or for the world.
       *
       * `paused` and not `blocked`, which is the same distinction a gate makes:
       * blocked means "something before this has not finished", and this job's
       * dependencies are all done. It is waiting for something that is not in
       * the graph at all, and a screen has to be able to say so.
       *
       * The deadline goes on the row rather than being recomputed by whatever
       * reads it: a wait that starts now and lasts thirty minutes has one end,
       * and two places deriving it from a duration eventually disagree about
       * when it began.
       */
      const row = jobs.find(one => Number(one.id) === Number(job.id))
      const plan = waitPlan(row?.settings, now)
      const wanted = waitSettingsOf(row?.settings).event

      /*
       * The event that arrived before anything was waiting for it.
       *
       * The classic lost wakeup, and the hardest kind of report to believe: the
       * sender saw a 200, the run sat until its timeout, and nothing anywhere
       * says the message was dropped. It was not dropped - it was recorded, and
       * nobody looked. This is the looking.
       */
      const early = wanted ? await alreadySent(runId, wanted) : null

      if (early) {
        await db
          .updateTable('workflow_jobs')
          .set({
            state: 'succeeded',
            started_at: now.toISOString(),
            finished_at: now.toISOString(),
            outputs: early.payload,
            condition_reason: `The \`${wanted}\` event had already arrived.`,
          })
          .where('id', '=', job.id)
          .where('state', '=', 'blocked')
          .execute()

        continue
      }

      const held = await db
        .updateTable('workflow_jobs')
        .set({
          state: 'paused',
          started_at: now.toISOString(),
          wake_at: plan.wakeAt,
          condition_reason: plan.reason,
        })
        .where('id', '=', job.id)
        .where('state', '=', 'blocked')
        .execute()

      /*
       * Only a wait for an *event* is anybody's to act on. A sleep ends by
       * itself, and telling a receiver about one would teach it to ignore this
       * event - which is the failure mode of every alert that fires too often.
       */
      if (wanted && rowsChanged(held))
        await announceActionRequiredFor(await repositoryOfRun(runId), runId, 'event', { job: String(job.job_id ?? ''), event: wanted })

      continue
    }

    if (job.kind === 'block') {
      const opened = await db
        .updateTable('workflow_jobs')
        .set({ state: 'paused', started_at: now.toISOString() })
        .where('id', '=', job.id)
        .where('state', '=', 'blocked')
        .execute()

      /*
       * A gate that has just started waiting is somebody's to open, and this is
       * the only moment anything knows it. Announced from the guarded write
       * rather than beside it, so a second settler that lost the race does not
       * send a second notification about one gate.
       */
      if (rowsChanged(opened))
        await announceActionRequiredFor(await repositoryOfRun(runId), runId, 'gate', { job: String(job.job_id ?? '') })

      continue
    }

    if (job.kind === 'trigger') {
      await startTrigger(runId, job.id, now)
      continue
    }

    /*
     * A command job naming an environment answers to that environment's rules
     * before it joins the queue.
     *
     * Checked here rather than at claim time because a job held for approval
     * must be *visible* as held: a job that sits in the queue and is quietly
     * refused every time a runner asks for it looks like a fleet problem, and
     * somebody goes and restarts runners.
     */
    /*
     * The graph row carries what the graph needs; the environment lives on the
     * database row, so the gate is asked with that one. Reading it off the
     * graph row silently found `undefined` and ran every protected deploy,
     * which is exactly the failure this feature exists to prevent.
     */
    const gate = await gateFor(runId, jobs.find(row => Number(row.id) === Number(job.id)) ?? job, now)

    if (gate.verdict === 'refuse') {
      await db
        .updateTable('workflow_jobs')
        .set({ state: 'failed', finished_at: now.toISOString(), condition_reason: gate.reason })
        .where('id', '=', job.id)
        .where('state', '=', 'blocked')
        .execute()

      continue
    }

    if (gate.verdict === 'hold') {
      await db
        .updateTable('workflow_jobs')
        .set({ state: 'paused', started_at: now.toISOString(), condition_reason: gate.reason })
        .where('id', '=', job.id)
        .where('state', '=', 'blocked')
        .execute()

      continue
    }

    await db
      .updateTable('workflow_jobs')
      /*
       * Stamped here, not at creation. This is the moment a runner may take
       * the job, and it is what the queue-wait number measures from - a job
       * that waited eight minutes on `needs:` and one second on the fleet must
       * not read as a nine-minute wait for a machine.
       */
      .set({ state: 'queued', queued_at: now.toISOString() })
      .where('id', '=', job.id)
      .where('state', '=', 'blocked')
      .execute()
  }

  return moved || ready.length > 0
}

/**
 * What this job's environment does to it, if it named one.
 *
 * The rules are read from the repository, never from the workflow: the file
 * says *where* a job deploys, and the repository says what that costs. A
 * workflow author who could set their own wait timer has a wait timer of zero.
 */
export async function gateFor(runId: number, job: any, now: Date): Promise<GateDecision> {
  const name = String(settingsOf(job).environment ?? '')

  if (!name)
    return { verdict: 'run' }

  const run = await db
    .selectFrom('workflow_runs')
    .select(['repository_id', 'event_ref', 'head_sha'])
    .where('id', '=', runId)
    .executeTakeFirst()
    .catch(() => null)

  if (!run)
    return { verdict: 'run' }

  const rules = await environmentRules(Number(run.repository_id), name)

  /*
   * The timer runs from when this job *first* became ready, which is the
   * moment it was held - `started_at`, written when it was paused.
   *
   * Measuring from now instead restarts the clock on every sweep, so a
   * ten-minute wait never elapses and the deploy is held forever. It is also
   * not the run's start: a long build must not eat the window that exists for
   * somebody to notice the deploy and stop it.
   */
  const readyAt = job.started_at ? new Date(String(job.started_at)) : now

  return decideGate({
    rules,
    ref: String(run.event_ref ?? ''),
    readyAt: Number.isFinite(readyAt.getTime()) ? readyAt : now,
    now,
    approved: Boolean(job.approved_at),
    /*
     * Asked only when the environment says to.
     *
     * Reading a commit's checks is two queries and a rollup, and almost no
     * deploy is gated on them - so the environment's own rule decides whether
     * the question is worth asking rather than the answer being computed and
     * thrown away.
     */
    checks: rules?.requireChecks
      ? await checksStateOf(Number(run.repository_id), String(run.head_sha ?? ''), String(run.event_ref ?? ''))
      : undefined,
  })
}

/**
 * What the run itself now is, written down.
 *
 * Separate from the passes above because it is the *answer* rather than a step:
 * running it inside the loop would mean a run flickering through states nobody
 * was ever going to see.
 */
async function recordRunState(runId: number, now: Date): Promise<string> {
  const settled = await jobsOfRun(runId)
  const state = runStateFromJobs(graphRows(settled).map(effectiveState))

  const run = await db.selectFrom('workflow_runs').select(['state', 'paused_at']).where('id', '=', runId).executeTakeFirst()
  const from = String(run?.state ?? 'queued')

  /*
   * And a held run stays `waiting`, whatever its rows say.
   *
   * Its jobs are blocked, so the computed state would be `queued` - which reads
   * as "a runner will get to this" and is the opposite of what is true.
   */
  if (await awaitingApproval(runId))
    return from

  /*
   * And a held run stays held, whatever its rows say.
   *
   * A job finishing inside a paused run would otherwise settle it back to
   * `running` or `queued` - and the claim reads that state to decide what a
   * machine may take, so the run would quietly start handing out work again
   * while the screen still said it was held. Read from the row this function
   * already fetched rather than through the pause module, which would make
   * these two files import each other for one boolean.
   */
  if (run?.paused_at)
    return from

  // A finished run must never move again, whatever the rows now say. A late
  // report or a sweep reopening a conclusion is the one outcome a branch
  // protection rule must not be told about.
  if (['succeeded', 'failed', 'cancelled'].includes(from))
    return from

  if (from !== state) {
    await db
      .updateTable('workflow_runs')
      .set({
        state,
        ...(state === 'succeeded' || state === 'failed' || state === 'cancelled'
          ? { finished_at: now.toISOString() }
          : {}),
      })
      .where('id', '=', runId)
      // Guarded on the state it was read at, so a concurrent report cannot have
      // this one overwrite a conclusion with a staler one.
      .where('state', '=', from)
      .execute()

    // And whoever was waiting on this run from another one. Nothing else would
    // ever look at that job again: it is in a different run entirely.
    await settleAwaitingTriggers(runId, state, now)

    /*
     * And the next run in this one's concurrency group, if this one has
     * finished holding it up.
     *
     * The release half of `cancel-in-progress: false`. It has to happen here
     * rather than at dispatch, because "the run ahead has finished" is a fact
     * only the settler ever learns - and a queue nothing releases is a deploy
     * that never happens rather than a deploy that waits.
     */
    if (['succeeded', 'failed', 'cancelled'].includes(state)) {
      /*
       * And the workflows that were waiting for *this workflow* to finish.
       *
       * `on: workflow_run` is the trigger for the second half of a pipeline
       * that must not be editable by whoever wrote the first half - a fork's
       * pull request can change the build and cannot change what publishes it.
       * It was stored on every version and read by nothing.
       *
       * Errors are swallowed: a run that has just concluded must record its
       * conclusion whatever a dependent workflow does, and a branch protection
       * rule waiting on this one is not the thing to hold up.
       */
      await dispatchWorkflowRun({ runId, activity: 'completed' }).catch(() => null)

      /*
       * And whoever asked to hear about this workflow on this branch.
       *
       * Here rather than in a listener, because the rules need the run's
       * conclusion *and* the one before it, and this is the moment both are
       * true. Errors are swallowed inside: a run must record its conclusion
       * whatever the inbox does.
       */
      await deliverRunNotifications(runId)

      /*
       * And the published site, when this run built one.
       *
       * Here rather than in a listener for the reason the notifications are:
       * publishing needs the run's conclusion *and* its artifacts, and this is
       * the moment both are settled. Silent and swallowing for every run that
       * was never going to publish, which is almost all of them - see
       * `publishRun`.
       *
       * Errors cannot reach the run. A site that failed to publish is recorded
       * on the site's own row and read on its settings page; a run whose
       * conclusion was lost because a tarball was malformed would be a much
       * worse trade.
       */
      if (state === 'succeeded') {
        const { publishRun } = await import('../Pages/publish')
        await publishRun(runId).catch(() => null)
      }

      const finished = await db
        .selectFrom('workflow_runs')
        .select(['repository_id', 'concurrency_group'])
        .where('id', '=', runId)
        .executeTakeFirst()
        .catch(() => null)

      if (finished?.concurrency_group) {
        const released = await releaseGroup(Number(finished.repository_id), String(finished.concurrency_group))

        // Settled immediately, because a released run may have work the control
        // plane does its own: a barrier at the top of its graph, or a gate that
        // has been waiting for a person since before it was held.
        if (released)
          await settleRun(released, now)
      }
    }
  }

  return state
}

/**
 * Start the run a trigger job asks for, and record what happened.
 *
 * The job itself never reaches a machine: starting a run is the control plane's
 * own work, and spending a runner to make one HTTP-shaped decision would be a
 * machine held open for the length of another pipeline.
 *
 * **A trigger that cannot resolve fails rather than passing quietly.** A
 * pipeline whose "deploy" stage silently did nothing is the failure mode this
 * whole phase exists to avoid, and a green run that triggered no deployment is
 * exactly that shape.
 */
async function startTrigger(runId: number, jobId: number, now: Date): Promise<void> {
  const job = await db
    .selectFrom('workflow_jobs')
    .select(['settings', 'job_id'])
    .where('id', '=', jobId)
    .executeTakeFirst()

  const settings = settingsOf(job)
  const wanted = String(settings.workflow ?? '').trim()

  const run = await db
    .selectFrom('workflow_runs')
    .select(['repository_id', 'event_ref', 'head_sha', 'actor_id', 'trigger_depth'])
    .where('id', '=', runId)
    .executeTakeFirst()

  const fail = async (reason: string): Promise<void> => {
    await db
      .updateTable('workflow_jobs')
      .set({
        state: 'failed',
        started_at: now.toISOString(),
        finished_at: now.toISOString(),
        condition_reason: reason,
      })
      .where('id', '=', jobId)
      .where('state', '=', 'blocked')
      .execute()
  }

  if (!run || !wanted) {
    await fail('This job triggers a workflow but does not say which one.')
    return
  }

  /*
   * The loop guard, and it is not optional.
   *
   * A workflow that triggers a workflow that triggers the first one is a run
   * factory: every trigger makes a *new* run, so no row is ever in a state
   * that could notice the cycle. One integer carried down bounds it, and the
   * refusal says what happened rather than the run simply stopping.
   */
  const depth = Number(run.trigger_depth ?? 0)

  if (depth >= MAX_TRIGGER_DEPTH) {
    await fail(`This is ${depth} triggers deep, which is where this instance stops following them.`)
    return
  }

  /*
   * Matched on the path or the name, because both are what somebody writes:
   * `release.yml` is the file and `Release` is what the workflow calls itself,
   * and refusing one of them would be a rule nobody can remember.
   */
  const candidates = await db
    .selectFrom('workflows')
    .select(['id', 'name', 'path', 'state'])
    .where('repository_id', '=', Number(run.repository_id))
    .execute()

  const target = candidates.find(row => String(row.path) === wanted)
    ?? candidates.find(row => String(row.path).endsWith(`/${wanted}`))
    ?? candidates.find(row => String(row.name) === wanted)

  if (!target) {
    await fail(`No workflow in this repository is called \`${wanted}\`.`)
    return
  }

  if (String(target.state) !== 'active') {
    await fail(`\`${wanted}\` is ${String(target.state)}, so triggering it would start nothing.`)
    return
  }

  const version = await db
    .selectFrom('workflow_versions')
    .select(['id'])
    .where('workflow_id', '=', Number(target.id))
    .orderBy('id', 'desc')
    .executeTakeFirst()

  if (!version) {
    await fail(`\`${wanted}\` has no parsed version to run.`)
    return
  }

  const previous = await db
    .selectFrom('workflow_runs')
    .select(['number'])
    .where('repository_id', '=', Number(run.repository_id))
    .orderBy('number', 'desc')
    .limit(1)
    .executeTakeFirst()

  const startedId = await startRun({
    values: withRedeliveryKey({
      workflow_version_id: Number(version.id),
      repository_id: Number(run.repository_id),
      number: Number(previous?.number ?? 0) + 1,
      state: 'queued',
      /*
       * Its own event name rather than `workflow_dispatch`.
       *
       * A triggered run was not started by a person pressing a button, and a
       * screen that says it was is a screen that sends somebody looking for
       * whoever pressed it. It also keeps the redelivery key out of the way:
       * two triggers from two runs of the same commit are two runs.
       */
      event: 'workflow_trigger',
      event_ref: `${String(run.event_ref ?? '')}#trigger/${runId}/${String(job?.job_id ?? '')}`,
      head_sha: String(run.head_sha ?? ''),
      definition_sha: String(run.head_sha ?? ''),
      /*
       * Trusted, because the run that triggered it was: an untrusted run is a
       * fork's code, and a fork's code that could trigger a trusted run would
       * be a way around every check this phase makes. A trigger cannot raise
       * its own trust level.
       */
      trusted: true,
      actor_id: run.actor_id ?? null,
      trigger_depth: depth + 1,
      dispatch_inputs: settings.inputs && Object.keys(settings.inputs as object).length > 0
        ? JSON.stringify(settings.inputs)
        : null,
    }),
    versionId: Number(version.id),
  })

  /*
   * Async by default, which is Buildkite's default and the right one: a
   * trigger that waits turns one stuck run into two. `await: true` keeps this
   * job running until the run it started finishes, and the child's own settle
   * closes it.
   */
  const awaiting = settings.await === true

  await db
    .updateTable('workflow_jobs')
    .set({
      state: awaiting ? 'running' : 'succeeded',
      started_at: now.toISOString(),
      finished_at: awaiting ? null : now.toISOString(),
      triggered_run_id: startedId,
      outputs: JSON.stringify({ run_id: String(startedId) }),
    })
    .where('id', '=', jobId)
    .where('state', '=', 'blocked')
    .execute()
}

/**
 * Close the trigger jobs that were waiting on this run.
 *
 * The other half of `await: true`. Called when a run reaches a terminal state,
 * because the job that started it is in another run entirely and nothing else
 * would ever look at it again.
 */
export async function settleAwaitingTriggers(runId: number, state: string, now: Date = new Date()): Promise<void> {
  if (!['succeeded', 'failed', 'cancelled'].includes(state))
    return

  const waiting = await db
    .selectFrom('workflow_jobs')
    .select(['id', 'workflow_run_id'])
    .where('triggered_run_id', '=', runId)
    .where('state', '=', 'running')
    .execute()

  for (const job of waiting) {
    await db
      .updateTable('workflow_jobs')
      .set({
        // The triggered run's verdict, carried back. A trigger that waited and
        // then reported success whatever happened would be a gate that is not
        // one.
        state: state === 'succeeded' ? 'succeeded' : state,
        finished_at: now.toISOString(),
        condition_reason: `The run this triggered ${state}.`,
      })
      .where('id', '=', Number(job.id))
      .where('state', '=', 'running')
      .execute()

    await settleRun(Number(job.workflow_run_id), now)
  }
}

/**
 * Where a commit's required checks have got to.
 *
 * Three values rather than a boolean, because the difference between them is
 * what a gate does next: still running is something to wait for, and already
 * failed is something to refuse. Computed with the same functions the pull
 * request's own panel uses, so a deploy held for a failing check and a merge
 * blocked by one are held by the same verdict rather than by two rules that
 * agree until they do not.
 */
async function checksStateOf(repositoryId: number, headSha: string, ref: string): Promise<ChecksState> {
  if (!headSha)
    return 'passing'

  /*
   * Which checks are required is a *branch* rule, read from the protection for
   * the branch this run is on. An environment asking for checks where the
   * branch requires none is asking about an empty set, and the answer is
   * passing - the same answer the merge rules give, because a deploy held by a
   * stricter reading than the merge would be a rule nobody could discover.
   */
  const branch = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref

  const protection = await db
    .selectFrom('protected_branches')
    .select(['required_checks'])
    .where('repository_id', '=', repositoryId)
    .where('pattern', '=', branch)
    .executeTakeFirst()
    .catch(() => null)

  let required: string[] = []

  try {
    const parsed = JSON.parse(String(protection?.required_checks ?? '[]'))

    required = Array.isArray(parsed) ? parsed.map(String) : []
  }
  catch {
    required = []
  }

  if (required.length === 0)
    return 'passing'

  const { checksPanel } = await import('../Checks/panel')

  const panel = await checksPanel({ repositoryId, headSha, required }).catch(() => null)

  if (!panel)
    return 'passing'

  if (panel.required.satisfied)
    return 'passing'

  /*
   * Failing beats pending. A commit with one check failed and another still
   * running is not something to wait for - the verdict that matters has
   * arrived, and holding would be a deploy nobody can unstick.
   */
  return panel.required.failing.length > 0 ? 'failing' : 'pending'
}

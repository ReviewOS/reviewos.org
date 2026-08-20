/**
 * Record what a runner says happened.
 *
 * Whether its word counts at all is [protocol.ts](./protocol.ts)'s decision.
 * This applies it, and then does the part the runner cannot: work out what the
 * *run* now is, unblock whatever was waiting on this job, and skip whatever can
 * no longer happen.
 *
 * That last part is [`Workflow/settle.ts`](../Workflow/settle.ts), shared with
 * the sweep. A report is not the only thing that moves a run's graph, and two
 * copies of "what does this failure unblock" is how the two paths end up
 * disagreeing about the same run.
 */

import { db } from '@stacksjs/database'
import { secretsOfJob } from './logs'
import { redactSecrets } from './redact'
import { announceJob, announceRunIfMoved } from '../Workflow/announce'
import { resolveJobCall } from '../Workflow/orchestratedJob'
import { rowsChanged } from '../Support/sql'
import type { JobState } from '../Workflow/states'
import { canJobMove } from '../Workflow/states'
import { revokeJobTokens } from '../Workflow/jobToken'
import { softFailOutcome } from '../Workflow/stepAttributes'
import { settleRun } from '../Workflow/settle'
import { considerRepair } from '../Workflow/repairHook'
import { DROPPED_MARK } from '../Workflow/reuse'
import type { RunnerFacts } from './protocol'
import { mayReport, splitLabels } from './protocol'

export interface ReportInput {
  jobId: number
  /** What the runner says the job came to. */
  state: 'succeeded' | 'failed' | 'cancelled'
  /** Optional, and untrusted: a runner can send anything. */
  error?: string | null
  /**
   * What the failing step exited with, when the runner knows.
   *
   * Sent so `retry: { exit-status: [137] }` can mean something. A test suite
   * that exits 1 on a failed assertion is not worth running again; a step
   * killed for memory at 137, or a fetch that exits 7, is exactly what a retry
   * is for, and the number is the only thing that tells them apart.
   */
  exitStatus?: number | null
  /**
   * What the job produced, resolved by the runner from its steps.
   *
   * Untrusted like everything else a runner says, and capped: a job's outputs
   * are read by the jobs after it, so an unbounded map is a way to make every
   * later claim expensive.
   */
  outputs?: Record<string, string> | null
  /**
   * What each step did, as values rather than as text in a log.
   *
   * Whatever the heartbeat has not already carried. A step's result used to
   * travel only here, on the grounds that nothing reads it until the job is
   * over - which was true until a restart could begin at step nine, and a
   * runner that dies at step nine has reported nothing at all. So the results
   * ride the heartbeat as they happen and this carries the remainder, which on
   * a job that finished normally is the last step and nothing else.
   *
   * Untrusted, like everything a runner says.
   */
  steps?: StepReport[] | null
}

/** One step's outcome, as the runner saw it. */
export interface StepReport {
  /**
   * Which step this was, counting from 0.
   *
   * Zero-based because the definition is: `job.steps.entries()` is what
   * numbered them when the workflow was stored, and the runner iterates the
   * same list in the same order. A second convention here would mean every
   * result landing one row away from the step that produced it.
   */
  position: number
  state?: 'succeeded' | 'failed' | 'skipped' | 'cancelled'
  exitCode?: number | null
  startedAt?: string | null
  finishedAt?: string | null
  /** How long it waited before anything ran it. */
  queuedMs?: number | null
  /** How long it was actually executing, which wall time cannot say. */
  activeMs?: number | null
  outputs?: Record<string, string> | null
  /**
   * How many times the runner ran this step, counting from one.
   *
   * Sent rather than counted here, and that is what makes recording a step
   * twice harmless: delivery is at-least-once, so the same result arrives
   * again whenever an answer is lost on the way back, and a column this end
   * incremented would climb every time the network hiccupped. A number the
   * runner states is the same number however often it is stated.
   */
  attempt?: number | null
  /** Why it failed, when it did. Untrusted text, like everything a runner sends. */
  error?: string | null
}

/**
 * The outputs a runner reported, as a map of strings or nothing.
 *
 * Here rather than in the endpoint because two endpoints now take a runner's
 * word for what happened - the conclusion and the heartbeat - and two copies of
 * "what a runner is allowed to have meant" is one more than there should be.
 */
export function readOutputs(value: unknown): Record<string, string> | null {
  const parsed = typeof value === 'string' ? tryParse(value) : value

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    return null

  const outputs: Record<string, string> = {}

  for (const [name, entry] of Object.entries(parsed as Record<string, unknown>))
    outputs[name] = entry === null || entry === undefined ? '' : String(entry)

  return outputs
}

/**
 * The per-step results, read out of what a runner sent.
 *
 * Accepts a JSON string as well as an array, because a runner posting a form
 * body has no other way to send a list - the same reason `readOutputs` does.
 * Every field is optional except the position: a step the runner has nothing to
 * say about should still be able to say it ran.
 */
export function readStepReports(value: unknown): StepReport[] | null {
  const parsed = typeof value === 'string' ? tryParse(value) : value

  if (!Array.isArray(parsed))
    return null

  return parsed
    .filter(one => one && typeof one === 'object')
    .map(one => ({
      position: Number((one as any).position),
      state: (one as any).state,
      exitCode: (one as any).exit_code ?? (one as any).exitCode ?? null,
      startedAt: (one as any).started_at ?? (one as any).startedAt ?? null,
      finishedAt: (one as any).finished_at ?? (one as any).finishedAt ?? null,
      queuedMs: (one as any).queued_ms ?? (one as any).queuedMs ?? null,
      activeMs: (one as any).active_ms ?? (one as any).activeMs ?? null,
      outputs: readOutputs((one as any).outputs),
      attempt: (one as any).attempt ?? null,
      error: (one as any).error ?? null,
    })) as StepReport[]
}

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text)
  }
  catch {
    return null
  }
}

/** A runner can send a hundred thousand steps; a job has at most a few dozen. */
const MAX_STEPS_REPORTED = 200

/**
 * A value too big for the store, said out loud rather than quietly shortened.
 *
 * Truncating looks like it works. The row holds a string, the screen shows a
 * string, and nothing anywhere says the last nine kilobytes are missing - so a
 * later job reading `needs.build.outputs.manifest` gets a JSON document with no
 * closing brace and fails somewhere else entirely, on a line that has nothing
 * to do with the cause.
 *
 * A marker fails in the right place instead: whatever reads it gets something
 * that is obviously not the value, and whoever wrote the workflow is told what
 * to do instead of guessing.
 */
export function boundedValue(value: string, limit: number): string {
  const bytes = Buffer.byteLength(value, 'utf8')

  if (bytes <= limit)
    return value

  return `${DROPPED_MARK} ${bytes} bytes, over the ${limit} this store keeps. Pass a value this size as an artifact and read it from there.]`
}

/**
 * Write down what each step did.
 *
 * Matched by position rather than by name: two steps in one job may share a
 * name - `- run: make` twice is two unnamed steps with the same generated
 * label - and position is what the definition already ordered them by.
 *
 * Every write is guarded to this job's own steps. The runner chooses the
 * positions, and a position is the one thing here it could get wrong or lie
 * about; without the guard, a job could write results onto another job's steps.
 */
export async function recordSteps(jobId: number, steps: StepReport[] | null | undefined, now: Date): Promise<number> {
  if (!Array.isArray(steps) || steps.length === 0)
    return 0

  const secrets = await secretsOfJob(jobId)
  let written = 0

  for (const step of steps.slice(0, MAX_STEPS_REPORTED)) {
    const position = Number(step?.position)

    if (!Number.isInteger(position) || position < 0)
      continue

    const values: Record<string, string> = {}

    for (const [name, value] of Object.entries(step.outputs ?? {}).slice(0, 32)) {
      if (!name)
        continue

      /*
       * Redacted here as well as in the runner, and for the reason a job's
       * outputs are: the runner masking its own values is the first line, and
       * the first line is somebody else's program.
       */
      values[name.slice(0, 200)] = boundedValue(redactSecrets(String(value ?? ''), secrets), 2000)
    }

    const attempt = Number.isFinite(Number(step.attempt)) && Number(step.attempt) > 0 ? Math.round(Number(step.attempt)) : 1

    const result = await db
      .updateTable('workflow_steps')
      .set({
        state: step.state ?? 'succeeded',
        exit_code: Number.isFinite(Number(step.exitCode)) ? Number(step.exitCode) : null,
        started_at: step.startedAt ? String(step.startedAt).slice(0, 40) : null,
        finished_at: step.finishedAt ? String(step.finishedAt).slice(0, 40) : now.toISOString(),
        queued_ms: Number.isFinite(Number(step.queuedMs)) ? Math.max(0, Math.round(Number(step.queuedMs))) : null,
        active_ms: Number.isFinite(Number(step.activeMs)) ? Math.max(0, Math.round(Number(step.activeMs))) : null,
        outputs: Object.keys(values).length > 0 ? JSON.stringify(values) : null,
        // Stated by the runner rather than incremented here, so the same
        // report arriving twice records the same number twice.
        attempts: attempt,
        error: step.error ? boundedValue(redactSecrets(String(step.error), secrets), 2000).slice(0, 2000) : null,
      })
      .where('workflow_job_id', '=', jobId)
      .where('position', '=', position)
      .execute()
      .catch(() => null)

    if (rowsChanged(result)) {
      written += 1
      await recordStepAttempt(jobId, position, attempt, step, now)
    }
  }

  return written
}

/**
 * A row per try at one step, beside the counter on the step itself.
 *
 * The counter answers "did this retry" on a screen without a query per step;
 * these answer "how did each try go", which is where flakiness is measured
 * from - and a step that overwrote its own history has nothing to measure.
 *
 * Written only when the step row moved, and only once per attempt number: the
 * same report arriving twice is the protocol working as promised, not a second
 * try.
 */
async function recordStepAttempt(
  jobId: number,
  position: number,
  attempt: number,
  step: StepReport,
  now: Date,
): Promise<void> {
  const row: any = await db
    .selectFrom('workflow_steps')
    .select(['id', 'repository_id'])
    .where('workflow_job_id', '=', jobId)
    .where('position', '=', position)
    .executeTakeFirst()
    .catch(() => null)

  if (!row?.id)
    return

  const already = await db
    .selectFrom('workflow_step_attempts')
    .select(['id'])
    .where('workflow_step_id', '=', Number(row.id))
    .where('attempt', '=', attempt)
    .executeTakeFirst()
    .catch(() => null)

  const state = ['succeeded', 'failed', 'cancelled'].includes(String(step.state ?? 'succeeded'))
    ? String(step.state ?? 'succeeded')
    : 'succeeded'

  const values = {
    state,
    exit_code: Number.isFinite(Number(step.exitCode)) ? Number(step.exitCode) : null,
    error: step.error ? String(step.error).slice(0, 2000) : null,
    started_at: step.startedAt ? String(step.startedAt).slice(0, 40) : null,
    finished_at: step.finishedAt ? String(step.finishedAt).slice(0, 40) : now.toISOString(),
  }

  if (already?.id) {
    await db
      .updateTable('workflow_step_attempts')
      .set(values)
      .where('id', '=', Number(already.id))
      .execute()
      .catch(() => null)

    return
  }

  await db
    .insertInto('workflow_step_attempts')
    .values({
      workflow_step_id: Number(row.id),
      repository_id: row.repository_id ?? null,
      attempt,
      ...values,
    })
    .execute()
    .catch(() => null)
}

/**
 * A job's outputs, bounded.
 *
 * Sixty-four values of four kilobytes each is more than any real job produces
 * and far less than a runner could send. The cap is here rather than only in the
 * endpoint because this is the function that writes the row, and a limit that
 * lives away from the write is a limit somebody bypasses by calling the other
 * path.
 */
async function cappedOutputs(
  outputs: Record<string, string> | null | undefined,
  jobId: number,
): Promise<string | null> {
  if (!outputs || typeof outputs !== 'object')
    return null

  /*
   * Redacted here for the same reason a log chunk is: the runner masking its
   * own outputs is the first line, and the first line is somebody else's
   * program. An output is the worse of the two to get wrong - a log is read by
   * a person, and an output is put into the environment of every job that
   * declares `needs` on this one, which is a secret leaving the job it was
   * scoped to.
   *
   * A workflow that wants a secret in a later job asks for the secret there.
   */
  const secrets = await secretsOfJob(jobId)
  const values: Record<string, string> = {}

  for (const [name, value] of Object.entries(outputs).slice(0, 64)) {
    if (!name)
      continue

    values[name.slice(0, 200)] = boundedValue(redactSecrets(String(value ?? ''), secrets), 4000)
  }

  return Object.keys(values).length > 0 ? JSON.stringify(values) : null
}

export interface ReportOutcome {
  ok: boolean
  reason: string
  duplicate: boolean
  /** The run's state after this report, when the report was accepted. */
  runState?: string
}

/** A runner can send as much as it likes; the column cannot take it. */
function trimmed(value: string | null | undefined, limit = 4000): string | null {
  const text = String(value ?? '').trim()
  if (!text)
    return null

  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text
}

export async function reportJob(
  runner: RunnerFacts,
  input: ReportInput,
  now: Date = new Date(),
): Promise<ReportOutcome> {
  const row = await db
    .selectFrom('workflow_jobs')
    .innerJoin('workflow_runs', 'workflow_runs.id', '=', 'workflow_jobs.workflow_run_id')
    .innerJoin('repositories', 'repositories.id', '=', 'workflow_runs.repository_id')
    .select([
      'workflow_jobs.id as id',
      'workflow_jobs.state as state',
      'workflow_jobs.runs_on as runs_on',
      'workflow_jobs.runner_id as runner_id',
      'workflow_jobs.lease_expires_at as lease_expires_at',
      'workflow_jobs.settings as settings',
      'workflow_jobs.workflow_run_id as run_id',
      'workflow_runs.repository_id as repository_id',
      'repositories.owner_id as owner_id',
    ])
    .where('workflow_jobs.id', '=', input.jobId)
    .executeTakeFirst()

  if (!row)
    return { ok: false, reason: 'no such job', duplicate: false }

  const facts = {
    id: Number(row.id),
    state: String(row.state),
    runsOn: splitLabels(row.runs_on === null || row.runs_on === undefined ? null : String(row.runs_on)),
    repositoryId: Number(row.repository_id),
    ownerId: Number(row.owner_id),
    runnerId: row.runner_id === null ? null : Number(row.runner_id),
    leaseExpiresAt: row.lease_expires_at ? String(row.lease_expires_at) : null,
    /** The `reviewos:` attributes the run copied forward, for `soft-fail:`. */
    settings: row.settings ?? null,
  }

  // The state the runner is claiming travels with the question, because one
  // answer depends on it: a cancellation may be acknowledged with a lease that
  // was revoked, and nothing else may.
  const allowed = mayReport(runner, facts, now, { reporting: input.state })
  if (!allowed.ok)
    return { ok: false, reason: allowed.reason, duplicate: false }

  if (allowed.duplicate) {
    // Already recorded by this runner. Answered as success, because from the
    // runner's side it was - refusing is how a correct runner retries forever.
    return { ok: true, reason: allowed.reason, duplicate: true, runState: await currentRunState(Number(row.run_id)) }
  }

  if (!canJobMove(facts.state as JobState, input.state))
    return { ok: false, reason: `a job that is ${facts.state} cannot become ${input.state}`, duplicate: false }

  /*
   * A failure the workflow asked to have retried goes back to the queue
   * instead of ending the job.
   *
   * Before the write below, because the two are alternatives: a job that is
   * about to run again has not failed, and recording a failure first would put
   * a red cross on a commit for something the workflow said to expect.
   */
  if (input.state === 'failed') {
    const retry = await retryDecision(facts.id, input.exitStatus ?? null)

    if (retry.retrying) {
      await db
        .updateTable('workflow_jobs')
        .set({
          state: 'queued',
          attempt: retry.attempt,
          runner_id: null,
          lease_expires_at: null,
          // The dead attempt's credential goes with it: the next attempt mints
          // its own, and a token from a finished attempt must not be able to
          // report over the one that replaced it.
          job_token_hash: null,
          started_at: null,
          // A retry waits for a machine again, so its wait starts again. The
          // alternative reports the first attempt's wait twice.
          queued_at: new Date().toISOString(),
          condition_reason: retry.reason,
        })
        .where('id', '=', facts.id)
        .where('runner_id', '=', String(runner.id))
        .execute()

      return { ok: true, reason: retry.reason, duplicate: false, runState: await currentRunState(Number(row.run_id)) }
    }
  }

  /*
   * `soft-fail:` - a failure the workflow said to tolerate.
   *
   * Decided here rather than at dispatch because it keys on the exit status,
   * which does not exist until the job has failed. The job's *own* state stays
   * `failed`, and `continue_on_error` is what the graph reads - so the run goes
   * on, the commit does not go red, and the job still says what happened.
   *
   * Recorded as a failure rather than rewritten as a success on purpose: a
   * screen that shows a tolerated failure as passing is one where nobody ever
   * finds out the linter has been failing for a month.
   */
  const soft = softFailOf(facts.settings)
  const tolerated = input.state === 'failed'
    ? softFailOutcome(soft, input.exitStatus ?? null)
    : { tolerated: false, reason: '' }

  if (tolerated.tolerated) {
    await db
      .updateTable('workflow_jobs')
      .set({ continue_on_error: true, condition_reason: tolerated.reason })
      .where('id', '=', facts.id)
      .execute()
      .catch(() => null)
  }

  await db
    .updateTable('workflow_jobs')
    .set({
      state: input.state,
      finished_at: now.toISOString(),
      /*
       * The outputs travel with the conclusion rather than in a call of their
       * own.
       *
       * A job that reported outputs and then failed to report its result would
       * leave values attached to a job nobody can tell finished, and the jobs
       * waiting on it would read them without knowing whether the job that
       * produced them succeeded.
       */
      outputs: await cappedOutputs(input.outputs, input.jobId),
      // The lease is released with the result. Leaving it would let a
      // heartbeat from this runner keep a finished job looking held.
      lease_expires_at: null,

      // The job token is **kept**, and that is deliberate.
      //
      // Clearing it here was the first instinct and it is wrong: delivery is
      // at-least-once, so a runner that did not hear this answer will report
      // again with the same credential, and a cleared token turns that into a
      // 401. The runner then cannot tell whether its work was recorded, which
      // is precisely the ambiguity the duplicate answer exists to remove.
      //
      // Nothing is bought by clearing it either. The job is terminal, and
      // `mayReport` will not move a terminal job - so the token's entire
      // remaining power is to be told "already recorded". It goes when the
      // lease is reclaimed by the sweep, which is the case where the work
      // really did move to somebody else.
    })
    .where('id', '=', facts.id)
    .where('runner_id', '=', String(runner.id))
    .execute()

  if (input.error) {
    await db
      .insertInto('workflow_step_attempts')
      .values({
        workflow_step_id: null,
        repository_id: facts.repositoryId,
        attempt: 1,
        state: input.state === 'succeeded' ? 'succeeded' : 'failed',
        runner_id: String(runner.id),
        error: trimmed(input.error),
        finished_at: now.toISOString(),
      })
      .execute()
      .catch(() => null)
  }

  /*
   * The job's API token dies with the job.
   *
   * Revoked here rather than left to expire, because an hour is a long time
   * for a credential nothing needs any more - and the expiry stays as the
   * backstop for the runner that dies without reporting, which is the case
   * this line cannot cover.
   */
  /*
   * A job a workflow program asked for closes the call it was standing in for,
   * and puts the program back in the queue.
   *
   * Here rather than in a sweep, because the result is in hand: the program is
   * waiting on exactly this job, and making it wait for the next tick of a
   * timer would add a minute to every step of every code-first workflow. Does
   * nothing for a job no program asked for.
   */
  /*
   * The steps, before the run is settled.
   *
   * A run reaching a terminal state is what makes a screen render its
   * conclusion, and step results that land after it are results the screen had
   * already drawn without.
   */
  await recordSteps(Number(row.id), input.steps, now)

  await resolveJobCall(Number(row.id), {
    state: input.state,
    outputs: input.outputs ?? null,
    error: input.error ?? null,
  }).catch(() => false)

  await revokeJobTokens(Number(row.run_id), Number(row.id), now)

  const before = await currentRunState(Number(row.run_id))
  const runState = await settleRun(Number(row.run_id), now)

  /*
   * The two events a program waits on, after the write and in that order: the
   * job it was told about, then the run if this report finished it. A receiver
   * that hears "run succeeded" before "job succeeded" has to hold the first
   * until the second arrives to make sense of it.
   */
  const named = await db
    .selectFrom('workflow_jobs')
    .innerJoin('workflow_runs', 'workflow_runs.id', '=', 'workflow_jobs.workflow_run_id')
    .select([
      'workflow_jobs.job_id as job_id',
      'workflow_jobs.name as name',
      'workflow_runs.number as run_number',
    ])
    .where('workflow_jobs.id', '=', facts.id)
    .executeTakeFirst()

  await announceJob(facts.repositoryId, {
    id: facts.id,
    jobId: String(named?.job_id ?? ''),
    name: named?.name ? String(named.name) : String(named?.job_id ?? ''),
    state: input.state,
    runId: Number(row.run_id),
    runNumber: Number(named?.run_number ?? 0),
    runnerId: String(runner.id),
  })

  await announceRunIfMoved(facts.repositoryId, Number(row.run_id), before, runState)

  /*
   * And last, the opt-in repair hook.
   *
   * After the conclusion is durable and the graph has settled, for two reasons.
   * The run has to be *failed* before anything is asked to repair it - a hook
   * that ran earlier would be repairing a job that the retry path above might
   * still put back in the queue - and the announcements are what a screen is
   * waiting on, so nothing a repair does should delay them.
   *
   * It never throws and it never touches this run. `considerRepair` swallows its
   * own errors on purpose: a runner's report is the only record that this job
   * happened, and losing it to a feature nobody turned on would be a poor trade.
   */
  if (input.state === 'failed') {
    await considerRepair({
      jobId: facts.id,
      runId: Number(row.run_id),
      repositoryId: facts.repositoryId,
      tolerated: tolerated.tolerated,
    })
  }

  return { ok: true, reason: 'recorded', duplicate: false, runState }
}

async function currentRunState(runId: number): Promise<string> {
  const run = await db.selectFrom('workflow_runs').select(['state']).where('id', '=', runId).executeTakeFirst()
  return String(run?.state ?? 'queued')
}

/**
 * Whether this failure is one the workflow asked to have run again.
 *
 * Three things have to line up, and all three are the workflow's own statement:
 * it asked for retries, it has attempts left, and - when it named exit
 * statuses - this is one of them. Anything else is an ordinary failure, which
 * is the direction that keeps a broken build visible.
 */
async function retryDecision(jobId: number, exitStatus: number | null): Promise<{ retrying: boolean, attempt: number, reason: string }> {
  const job = await db
    .selectFrom('workflow_jobs')
    .select(['attempt', 'settings'])
    .where('id', '=', jobId)
    .executeTakeFirst()

  const attempt = Number(job?.attempt ?? 1)

  let retry: any = null

  try {
    retry = JSON.parse(String(job?.settings ?? '{}'))?.retry ?? null
  }
  catch {
    retry = null
  }

  const allowed = Number(retry?.attempts ?? 0)

  if (!Number.isInteger(allowed) || allowed < 1)
    return { retrying: false, attempt, reason: '' }

  // `attempts: 2` means two *extra* tries, so three runs in total.
  if (attempt > allowed)
    return { retrying: false, attempt, reason: '' }

  const statuses = Array.isArray(retry?.exitStatus) ? retry.exitStatus.map(Number) : []

  if (statuses.length > 0 && (exitStatus === null || !statuses.includes(exitStatus))) {
    /*
     * A workflow that named statuses is saying which failures are worth
     * repeating. An unknown status is not one of them: retrying on "we do not
     * know why it failed" is how a narrow retry becomes a blanket one.
     */
    return { retrying: false, attempt, reason: '' }
  }

  return {
    retrying: true,
    attempt: attempt + 1,
    reason: `Attempt ${attempt} failed${exitStatus === null ? '' : ` (exit ${exitStatus})`}; retrying, ${allowed - attempt + 1} of ${allowed} left.`,
  }
}

/** A job's `soft-fail:`, out of the settings the run copied forward. */
function softFailOf(settings: unknown): { any: boolean, statuses: number[] } | null {
  try {
    const parsed = JSON.parse(String(settings ?? '{}'))
    const soft = parsed?.softFail

    if (!soft || typeof soft !== 'object')
      return null

    return {
      any: soft.any === true,
      statuses: Array.isArray(soft.statuses) ? soft.statuses.map(Number).filter(Number.isFinite) : [],
    }
  }
  catch {
    return null
  }
}

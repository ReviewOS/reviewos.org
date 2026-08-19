/**
 * A journaled call that becomes a job the same way any other job exists.
 *
 * This is the normalization box, and it is the difference between a code-first
 * workflow that *works* and one that is a second product. A program calling
 * `job('test', { run: 'bun test' })` does not run `bun test` in its own
 * process - the control plane writes a `workflow_jobs` row with a
 * `workflow_steps` row under it, a runner claims it through the ordinary claim,
 * and the result comes back through the ordinary report.
 *
 * So the run screen, the API, the logs, the artifacts, the annotations and
 * restart-from-step are the ones that already exist. **If a screen could tell
 * which authoring form produced a run, the normalization would be wrong**, and
 * the way to make that true is not to be careful on every screen - it is to
 * have one kind of row.
 *
 * ## The orchestrator is asleep while this runs
 *
 * A program that dispatched a job and then held its machine waiting for it
 * would use two runners to do one job's work, and a workflow of twenty
 * sequential steps would hold a machine for the whole run doing nothing. So the
 * call suspends exactly like a sleep does, and `reportJob` wakes it when the
 * job it was waiting for finishes.
 *
 * ## What a program may ask for, and what it may not
 *
 * A job spec here is the same vocabulary as a step in a document: `run`,
 * `uses`, `with`, `env`, `runs-on`. Deliberately not more. Every field a
 * program can set is one the static form can set too, because the moment the
 * two vocabularies diverge, the normalization is a promise nobody can keep.
 */

import { db } from '@stacksjs/database'

/** What a program may ask for when it asks for a job. */
export interface JobSpec {
  run?: string
  uses?: string
  with?: Record<string, unknown>
  env?: Record<string, string>
  runsOn?: string
}

/** A program can send anything; the columns cannot take it. */
function trimmed(value: unknown, limit: number): string | null {
  const text = String(value ?? '').trim()

  return text ? text.slice(0, limit) : null
}

/**
 * Read a spec out of what a program sent, keeping only what a step may hold.
 *
 * Tolerant on the way in and narrow on the way out. A program is untrusted code
 * on a machine this instance does not control, so what arrives here is a claim
 * rather than a definition - and a field nobody validated is a field that ends
 * up in a column somebody reads.
 */
export function specFrom(args: unknown): JobSpec {
  const raw = (args ?? {}) as Record<string, unknown>

  const env: Record<string, string> = {}

  if (raw.env && typeof raw.env === 'object') {
    for (const [name, value] of Object.entries(raw.env as Record<string, unknown>).slice(0, 64))
      env[name.slice(0, 200)] = String(value ?? '').slice(0, 4000)
  }

  const inputs: Record<string, unknown> = {}

  if (raw.with && typeof raw.with === 'object') {
    for (const [name, value] of Object.entries(raw.with as Record<string, unknown>).slice(0, 64))
      inputs[name.slice(0, 200)] = typeof value === 'object' ? null : value
  }

  return {
    run: trimmed(raw.run, 60_000) ?? undefined,
    uses: trimmed(raw.uses, 500) ?? undefined,
    with: Object.keys(inputs).length > 0 ? inputs : undefined,
    env: Object.keys(env).length > 0 ? env : undefined,
    runsOn: trimmed(raw['runs-on'] ?? raw.runsOn, 200) ?? undefined,
  }
}

/** Whether a call is asking for work rather than describing it. */
export function isRunnable(spec: JobSpec): boolean {
  return Boolean(spec.run || spec.uses)
}

export const NOTHING_TO_RUN
  = 'A job needs something to run: pass `run` with a command, or `uses` with an action. A call with '
    + 'neither would create a job no machine could execute and a run that never finishes.'

/**
 * Write the job and its step, and point the journal entry at it.
 *
 * The entry is linked in the same breath, because that link is how the result
 * finds its way back: when the job reports, `reportJob` looks for the entry
 * waiting on it, records what the job produced, and requeues the orchestrator.
 * Without the link the job would run, succeed, and the program would wait
 * forever for a call nobody could resolve.
 */
export async function createOrchestratedJob(input: {
  runId: number
  repositoryId: number | null
  entryId: number
  name: string
  spec: JobSpec
}): Promise<number> {
  /*
   * Positioned after everything already on the run.
   *
   * A program's jobs arrive one at a time and in order, so the position is what
   * the run screen reads to lay them out - and reusing a position would put two
   * jobs in one slot on a screen that has no other ordering to fall back on.
   */
  const last: any = await db
    .selectFrom('workflow_jobs')
    .select(['position'])
    .where('workflow_run_id', '=', input.runId)
    .orderBy('position', 'desc')
    .executeTakeFirst()
    .catch(() => null)

  const position = Number(last?.position ?? 0) + 1

  const job: any = await db
    .insertInto('workflow_jobs')
    .values({
      workflow_run_id: input.runId,
      repository_id: input.repositoryId,
      /*
       * Keyed by the journal position rather than by the name.
       *
       * A loop calling `job('publish', ...)` twelve times produces twelve jobs
       * with one name, and `job_id` is what `needs:` and the API address a job
       * by - so it has to be unique within the run. The sequence already is.
       */
      job_id: `call-${input.entryId}`,
      name: String(input.name || 'job').slice(0, 200),
      position,
      // Straight to `queued`: there is no graph above it. What it waits for is
      // the program, and the program has already decided by asking.
      state: 'queued',
      queued_at: new Date().toISOString(),
      runs_on: input.spec.runsOn ?? null,
      kind: 'command',
    })
    .returning(['id'])
    .executeTakeFirst()

  const jobId = Number(job?.id)

  await db
    .insertInto('workflow_steps')
    .values({
      workflow_job_id: jobId,
      repository_id: input.repositoryId,
      position: 1,
      name: String(input.name || 'job').slice(0, 200),
      command: input.spec.run ?? null,
      uses: input.spec.uses ?? null,
      inputs: input.spec.with ? JSON.stringify(input.spec.with) : null,
      env: input.spec.env ? JSON.stringify(input.spec.env) : null,
      state: 'pending',
    })
    .execute()

  await db
    .updateTable('workflow_journal_entries')
    .set({ workflow_job_id: jobId })
    .where('id', '=', input.entryId)
    .execute()

  return jobId
}

/**
 * Close the journal call a finished job was standing in for, and wake its
 * program.
 *
 * Called from the ordinary report path, so a job dispatched by a program
 * finishes exactly as any other job does and this is the only extra thing that
 * happens. Nothing here runs for a job no program asked for - the lookup finds
 * no entry and it returns.
 *
 * A failed job resolves the call as a **failure** rather than leaving it
 * pending. The program sees a `StepFailed` it can catch, which is what lets a
 * workflow written as a program handle a failing job at all; leaving it pending
 * would hang the run on work that is already over.
 */
export async function resolveJobCall(jobId: number, outcome: {
  state: string
  outputs?: Record<string, string> | null
  error?: string | null
}): Promise<boolean> {
  const entry: any = await db
    .selectFrom('workflow_journal_entries')
    .select(['id', 'workflow_run_id', 'state'])
    .where('workflow_job_id', '=', jobId)
    .where('state', '=', 'pending')
    .executeTakeFirst()
    .catch(() => null)

  if (!entry)
    return false

  const failed = outcome.state !== 'succeeded'

  const { resolve } = await import('./journal')

  await resolve(Number(entry.id), {
    result: failed ? undefined : (outcome.outputs ?? {}),
    error: failed
      ? (outcome.error || `the job ${outcome.state}`)
      : undefined,
    jobId,
  })

  /*
   * And the program goes back in the queue.
   *
   * `wakeOne` is guarded on `sleeping`, so a program that is somehow already
   * running - two jobs it dispatched finishing at the same instant - is not
   * taken off its machine. The second finish simply finds nothing to wake, and
   * the program reads both results on its next pass.
   */
  const { wakeOne } = await import('./wake')

  const orchestrator: any = await db
    .selectFrom('workflow_jobs')
    .select(['id'])
    .where('workflow_run_id', '=', Number(entry.workflow_run_id))
    .where('orchestrator', '=', true)
    .executeTakeFirst()
    .catch(() => null)

  if (orchestrator)
    await wakeOne(Number(orchestrator.id))

  return true
}

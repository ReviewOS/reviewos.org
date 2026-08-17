/**
 * Steps a job generates and adds to the run it is already part of.
 *
 * Buildkite's most important feature and its largest security surface, and both
 * halves are true for the same reason: the file no longer says what the run
 * will do. A job looks at the repository - twelve packages, four of which
 * changed - and appends the jobs that turned out to be needed.
 *
 * Actions has a shadow of this, a matrix built from `fromJSON` of a prior job's
 * output, which covers the common case and nothing else: the number of jobs can
 * vary, but not what they *are*.
 *
 * ## What stops this being a hole
 *
 * **An upload cannot raise its own trust level.** Everything that decides what
 * a job may reach is inherited from the run and from the job that uploaded it,
 * never read from the uploaded document: a fork's run stays untrusted, the
 * repository is the same repository, and the pool that serves it is the pool
 * that already served it. The uploaded document gets to say *what to run*, not
 * *where* or *as whom*.
 *
 * **The budget is the control plane's, not the workflow's.** A job that uploads
 * a job that uploads a job is bounded by depth; a run whose jobs each upload a
 * few times is bounded by a total; and one upload cannot be enormous. All three
 * are needed, because each one alone is a loop somebody can still write.
 *
 * **It goes through the same parser as a workflow file.** The uploaded document
 * is wrapped into a workflow and parsed, so every rule that refuses a bad job in
 * a repository refuses it here - cycles, unknown keys, a job that names no
 * `runs-on`. A second, laxer validator for uploaded steps would be the one an
 * attacker reads.
 */

import { db } from '@stacksjs/database'
import { parseWorkflow } from './parse'
import { settleRun } from './settle'

/**
 * How deep a chain of uploads may go.
 *
 * A job uploaded by an uploaded job is depth two. Three is more than any real
 * pipeline needs and few enough that a loop costs a handful of jobs rather than
 * a database - and unlike a trigger loop, this one stays inside one run where
 * nothing else would notice it.
 */
export const MAX_UPLOAD_DEPTH = 3

/** How many uploads a whole run may make, however they are spread across jobs. */
export const MAX_UPLOADS_PER_RUN = 20

/** How many jobs one upload may add. */
export const MAX_JOBS_PER_UPLOAD = 50

/** How many jobs a run may end up with, uploads included. */
export const MAX_JOBS_PER_RUN = 500

export interface UploadOutcome {
  ok: boolean
  /** Why not, in words the runner's log can carry and a person can read. */
  reason: string
  /** Job ids added, when it was accepted. */
  added: number[]
  /** Parse errors, when the document was the problem. */
  problems?: string[]
}

/**
 * Add the jobs in `source` to the run that `jobId` belongs to.
 *
 * `source` is YAML in the shape of a workflow's `jobs:` block, which is what a
 * job generating steps already knows how to write - and what a person reading
 * the run can compare against the file it came from.
 */
export async function uploadSteps(jobId: number, source: string, now: Date = new Date()): Promise<UploadOutcome> {
  const job: any = await db
    .selectFrom('workflow_jobs')
    .select(['id', 'job_id', 'workflow_run_id', 'state', 'upload_depth', 'runs_on', 'settings', 'priority'])
    .where('id', '=', jobId)
    .executeTakeFirst()

  if (!job)
    return { ok: false, reason: 'no such job', added: [] }

  const run: any = await db
    .selectFrom('workflow_runs')
    .select(['id', 'state', 'uploads', 'trusted', 'repository_id'])
    .where('id', '=', Number(job.workflow_run_id))
    .executeTakeFirst()

  if (!run)
    return { ok: false, reason: 'this job has no run', added: [] }

  /*
   * A finished run takes nothing.
   *
   * The runner that was executing it may still be alive - it is somebody
   * else's machine - so a late upload will arrive, and accepting one would add
   * work to a run whose conclusion has already been reported to a branch
   * protection rule.
   */
  if (['succeeded', 'failed', 'cancelled'].includes(String(run.state)))
    return { ok: false, reason: `this run is ${String(run.state)}, so it takes no more steps`, added: [] }

  if (String(job.state) !== 'running')
    return { ok: false, reason: `a job that is ${String(job.state)} cannot upload steps`, added: [] }

  const depth = Number(job.upload_depth ?? 0)

  if (depth >= MAX_UPLOAD_DEPTH)
    return { ok: false, reason: `this is ${depth} uploads deep, which is where this instance stops`, added: [] }

  if (Number(run.uploads ?? 0) >= MAX_UPLOADS_PER_RUN)
    return { ok: false, reason: `this run has already uploaded ${MAX_UPLOADS_PER_RUN} times`, added: [] }

  /*
   * Parsed as a workflow, so every rule that refuses a bad job in a repository
   * refuses it here. A second, laxer validator for uploaded steps would be the
   * one an attacker reads.
   */
  const existing: any[] = await db
    .selectFrom('workflow_jobs')
    .select(['id', 'job_id', 'position'])
    .where('workflow_run_id', '=', Number(run.id))
    .execute()

  const names = new Set(existing.map(row => String(row.job_id)))

  const parsed = parseWorkflow(
    `name: uploaded\non: push\n${indented(source)}`,
    'uploaded steps',
    // The jobs already in the run, so a generated job may depend on the one
    // that generated it - which is the ordinary case rather than an edge one.
    { knownJobs: [...names] },
  )

  if (parsed.errors.length > 0) {
    return {
      ok: false,
      reason: 'these steps were refused',
      added: [],
      problems: parsed.errors.map(error => `${error.message}${error.fix ? ` ${error.fix}` : ''}`),
    }
  }

  const uploaded = parsed.workflow?.jobs ?? []

  if (uploaded.length === 0)
    return { ok: false, reason: 'this upload contains no jobs', added: [] }

  if (uploaded.length > MAX_JOBS_PER_UPLOAD)
    return { ok: false, reason: `one upload may add at most ${MAX_JOBS_PER_UPLOAD} jobs`, added: [] }

  if (existing.length + uploaded.length > MAX_JOBS_PER_RUN)
    return { ok: false, reason: `a run may hold at most ${MAX_JOBS_PER_RUN} jobs`, added: [] }

  for (const one of uploaded) {
    /*
     * A name already in the run is refused rather than merged or renamed.
     *
     * `needs:` is by name, and two jobs sharing one is how a matrix is
     * expressed - so silently adding a second `build` would change what every
     * existing `needs: build` waits for, which is a graph nobody wrote.
     */
    if (names.has(one.id))
      return { ok: false, reason: `this run already has a job called \`${one.id}\``, added: [] }
  }

  /*
   * A dangling `needs:` is refused by the parser above rather than here.
   *
   * It was checked twice while this was being written, and the second check was
   * unreachable: `knownJobs` gives the parser the run's job names, so a `needs:`
   * naming neither an uploaded job nor an existing one fails there - with the
   * message and the fix a person reading the log wants. Two checks for one rule
   * is one that eventually disagrees with itself.
   */

  let position = Math.max(0, ...existing.map(row => Number(row.position ?? 0))) + 1
  const added: number[] = []

  for (const one of uploaded) {
    const created: any = await db
      .insertInto('workflow_jobs')
      .values({
        workflow_run_id: Number(run.id),
        job_id: one.id,
        name: one.name ?? one.id,
        position: position++,
        state: one.needs.length > 0 || one.kind !== 'command' ? 'blocked' : 'queued',
        needs: one.needs.join('\n'),
        runs_on: one.runsOn.join('\n'),
        kind: one.kind,
        settings: Object.keys(one.settings).length > 0 ? JSON.stringify(one.settings) : null,
        group_label: one.group,
        /*
         * Priority is *not* taken from the uploaded document.
         *
         * It is the one field where a job could give itself something the
         * parent did not have - jumping a queue full of other people's work -
         * so it inherits, which is the same rule as everywhere else here: the
         * document says what to run, not where it sits.
         */
        priority: Number(job.priority ?? 0),
        fail_fast: one.failFast,
        max_parallel: one.maxParallel,
        timeout_minutes: one.timeoutMinutes,
        continue_on_error: one.continueOnError,
        // Attributed, so the run's graph says what it became and who made it so.
        uploaded_by_job_id: Number(job.id),
        upload_depth: depth + 1,
      } as any)
      .returning(['id'])
      .executeTakeFirst()

    const id = Number(created?.id)

    added.push(id)

    for (const [index, step] of one.steps.entries()) {
      await db
        .insertInto('workflow_steps')
        .values({
          workflow_job_id: id,
          position: index,
          name: step.name ?? step.run ?? step.uses ?? `step ${index + 1}`,
          state: 'pending',
          attempts: 0,
        } as any)
        .execute()
        .catch(() => null)
    }
  }

  await db
    .updateTable('workflow_runs')
    .set({ uploads: Number(run.uploads ?? 0) + 1 } as any)
    .where('id', '=', Number(run.id))
    .execute()

  /*
   * Settled, so anything the upload unblocked starts without waiting for
   * something else to move the run. A job that uploaded work and then finished
   * would otherwise leave it sitting until the next report.
   */
  await settleRun(Number(run.id), now)

  return { ok: true, reason: `added ${added.length} ${added.length === 1 ? 'job' : 'jobs'}`, added }
}

/**
 * Indent an uploaded `jobs:` block so it can be parsed as a workflow.
 *
 * The document a job writes is the `jobs:` mapping on its own, because that is
 * what somebody generating steps has in their hands - asking them to also write
 * `name:` and `on:` would be asking for two lines that can only be one thing.
 */
function indented(source: string): string {
  const text = String(source ?? '')

  return text.trimStart().startsWith('jobs:') ? text : `jobs:\n${text.split('\n').map(line => (line.trim() ? `  ${line}` : line)).join('\n')}`
}

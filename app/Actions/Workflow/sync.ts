/**
 * Put a workflow file into the tables, or refuse it.
 *
 * The seam between [the parser](./parse.ts), which reads text and evaluates
 * nothing, and the control plane's rows. Everything it writes is a description
 * of work; nothing it writes is scheduled by writing it.
 *
 * **An invalid file produces no version.** That is the roadmap's rule - invalid
 * workflow code must never reach a runner - and doing it here rather than at
 * dispatch means the one place that creates versions is the one place that
 * validates, instead of every caller remembering to.
 */

import { db } from '@stacksjs/database'
import type { NormalizedWorkflow, WorkflowError } from './parse'
import { parseWorkflow } from './parse'

export interface SyncInput {
  /** Null for a workflow an owner carries rather than a repository. */
  repositoryId: number | null
  ownerType: 'user' | 'organization'
  ownerId: number
  /** `.github/workflows/ci.yml`. */
  path: string
  /** The file's bytes, as text. */
  source: string
  /** The commit it was read from. */
  sha: string | null
}

export interface SyncResult {
  ok: boolean
  workflowId: number | null
  versionId: number | null
  /** False when this exact content was already stored. */
  createdVersion: boolean
  errors: WorkflowError[]
}

/**
 * SHA-256 of the file's bytes.
 *
 * Of the *bytes*, not of the parsed graph. Two files that normalize to the same
 * jobs are still two files - a comment change is a change somebody made, and a
 * version history that silently merges them cannot answer "what was in the file
 * when this ran".
 */
export function digestOf(source: string): string {
  return new Bun.CryptoHasher('sha256').update(source).digest('hex')
}

/** The lines a filter is stored as, or null when there is no filter. */
function lines(values: readonly string[]): string | null {
  return values.length > 0 ? values.join('\n') : null
}

/**
 * Store one workflow file.
 *
 * Idempotent by digest: the same content on a second push finds the existing
 * version and writes nothing. That is what stops a repository accumulating a
 * version per commit, and it is why the digest column is unique per workflow.
 */
export async function syncWorkflowFile(input: SyncInput): Promise<SyncResult> {
  const parsed = parseWorkflow(input.source, input.path)

  if (!parsed.ok) {
    return { ok: false, workflowId: null, versionId: null, createdVersion: false, errors: parsed.errors }
  }

  const workflowId = await upsertWorkflow(input, parsed.workflow)
  const digest = digestOf(input.source)

  const existing: any = await db
    .selectFrom('workflow_versions')
    .select(['id'])
    .where('workflow_id', '=', workflowId)
    .where('content_digest', '=', digest)
    .executeTakeFirst()

  if (existing) {
    return {
      ok: true,
      workflowId,
      versionId: Number(existing.id),
      createdVersion: false,
      errors: [],
    }
  }

  const versionId = await insertVersion(workflowId, digest, input, parsed.workflow)

  return { ok: true, workflowId, versionId, createdVersion: true, errors: [] }
}

/**
 * The workflow row, found by where it lives rather than by its name.
 *
 * Keyed on the path, because that is what is stable: renaming the `name:` in
 * the file is an edit to a workflow, and keying on the name would make it a
 * different workflow with none of its history.
 */
async function upsertWorkflow(input: SyncInput, workflow: NormalizedWorkflow): Promise<number> {
  const name = workflow.name ?? input.path.split('/').pop() ?? input.path

  let query = db
    .selectFrom('workflows')
    .select(['id', 'state'])
    .where('owner_type', '=', input.ownerType)
    .where('owner_id', '=', input.ownerId)
    .where('path', '=', input.path)

  // `whereNull`, not `where('repository_id', 'is', null)`: this builder binds
  // the null as a parameter and Postgres answers with a syntax error. The same
  // trap is written up in `Auth/twoFactor.ts` and `Pull/suggest.ts`, which is
  // where it should have been read before being repeated here.
  query = input.repositoryId === null
    ? query.whereNull('repository_id')
    : query.where('repository_id', '=', input.repositoryId)

  const found: any = await query.executeTakeFirst()

  if (found) {
    /*
     * The name follows the file, so a renamed workflow is renamed here too.
     *
     * And a file that has come back revives its workflow - but only from
     * `removed`. A workflow somebody switched off stays off: a revert must not
     * quietly resurrect a workflow that was turned off on purpose, which is the
     * whole reason `removed` is a state of its own.
     */
    const revived = String(found.state) === 'removed' ? { state: 'active' } : {}

    await db.updateTable('workflows').set({ name, ...revived }).where('id', '=', Number(found.id)).execute()
    return Number(found.id)
  }

  const created: any = await db
    .insertInto('workflows')
    .values({
      owner_type: input.ownerType,
      owner_id: input.ownerId,
      repository_id: input.repositoryId,
      path: input.path,
      name,
      state: 'active',
    } as any)
    .returning(['id'])
    .executeTakeFirst()

  return Number(created?.id)
}

/** The frozen version, and the graph under it. */
async function insertVersion(
  workflowId: number,
  digest: string,
  input: SyncInput,
  workflow: NormalizedWorkflow,
): Promise<number> {
  const triggers = workflow.triggers

  const version: any = await db
    .insertInto('workflow_versions')
    .values({
      workflow_id: workflowId,
      source_sha: input.sha,
      source_path: input.path,
      content_digest: digest,
      on_push: triggers.push !== null,
      on_pull_request: triggers.pullRequest !== null,
      on_pull_request_target: triggers.pullRequestTarget !== null,
      on_dispatch: triggers.dispatch,
      reusable: triggers.reusable,
      push_branches: lines(triggers.push?.branches ?? []),
      push_tags: lines(triggers.push?.tags ?? []),
      push_paths: lines(triggers.push?.paths ?? []),
      push_branches_ignore: lines(triggers.push?.branchesIgnore ?? []),
      push_tags_ignore: lines(triggers.push?.tagsIgnore ?? []),
      push_paths_ignore: lines(triggers.push?.pathsIgnore ?? []),
      pull_request_branches: lines(triggers.pullRequest?.branches ?? []),
      pull_request_paths: lines(triggers.pullRequest?.paths ?? []),
      pull_request_branches_ignore: lines(triggers.pullRequest?.branchesIgnore ?? []),
      pull_request_paths_ignore: lines(triggers.pullRequest?.pathsIgnore ?? []),
      pull_request_types: lines(triggers.pullRequest?.types ?? []),
      dispatch_inputs: triggers.dispatchInputs.length > 0 ? JSON.stringify(triggers.dispatchInputs) : null,
      env: Object.keys(workflow.env).length > 0 ? JSON.stringify(workflow.env) : null,
      permissions: workflow.permissions === null || workflow.permissions === undefined
        ? null
        : JSON.stringify(workflow.permissions),
      concurrency_group: workflow.concurrency?.group ?? null,
      cancel_in_progress: workflow.concurrency?.cancelInProgress ?? false,
      schedules: lines(triggers.schedule),
      unsupported_events: lines(triggers.unsupported),
    } as any)
    .returning(['id'])
    .executeTakeFirst()

  const versionId = Number(version?.id)

  for (const [position, job] of workflow.jobs.entries()) {
    const row: any = await db
      .insertInto('workflow_version_jobs')
      .values({
        workflow_version_id: versionId,
        job_id: job.id,
        position,
        name: job.name,
        runs_on: lines(job.runsOn),
        needs: lines(job.needs),
        condition: job.if,
        timeout_minutes: job.timeoutMinutes,
        // JSON rather than rows: a combination is read whole, with the job,
        // and never queried across workflows.
        env: Object.keys(job.env).length > 0 ? JSON.stringify(job.env) : null,
        permissions: job.permissions === null || job.permissions === undefined
          ? null
          : JSON.stringify(job.permissions),
        concurrency_group: job.concurrency?.group ?? null,
        job_cancel_in_progress: job.concurrency?.cancelInProgress ?? false,
        matrix: job.matrix.length > 0 ? JSON.stringify(job.matrix) : null,
        fail_fast: job.failFast,
        max_parallel: job.maxParallel,
      } as any)
      .returning(['id'])
      .executeTakeFirst()

    const jobId = Number(row?.id)

    for (const [stepPosition, step] of job.steps.entries()) {
      await db
        .insertInto('workflow_version_steps')
        .values({
          workflow_version_job_id: jobId,
          position: stepPosition,
          step_id: step.id,
          name: step.name,
          command: step.run,
          uses: step.uses,
          // Stored as JSON because `with:` is an action's own vocabulary and
          // this side has no business having an opinion about its shape.
          inputs: Object.keys(step.with).length > 0 ? JSON.stringify(step.with) : null,
          env: Object.keys(step.env).length > 0 ? JSON.stringify(step.env) : null,
          working_directory: step.workingDirectory,
          condition: step.if,
        } as any)
        .execute()
    }
  }

  return versionId
}

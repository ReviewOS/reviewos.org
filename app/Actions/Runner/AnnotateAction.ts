import { Action } from '@stacksjs/actions'
import { db } from '@stacksjs/database'
import { schema } from '@stacksjs/validation'
import { authenticateJob } from './authenticate'
import { protocolOf, refuseProtocol, runnerJson } from './gate'

/**
 * What a job's steps said about the code, on the lines they said it about.
 *
 * `::error file=src/a.ts,line=12::Undefined name` printed by a compiler becomes
 * a check annotation here, and a check annotation is what the diff renders in
 * the gutter. That path - a tool that knows nothing about this instance, to a
 * message on line 12 of a review - is the reason the workflow command protocol
 * is worth implementing exactly rather than approximately.
 *
 * Authenticated with the job's token, like every other thing a runner says
 * about a job. A runner may only annotate the job it holds, which means an
 * annotation cannot be attributed to a run somebody else is watching.
 *
 * **Everything here is untrusted input.** A runner is somebody else's machine
 * executing hostile code: the path in an annotation is a string a step printed,
 * not a file this instance verified, and the count is capped rather than
 * trusted. What that buys is that the worst a malicious runner can do is put a
 * wrong message on its own run.
 */
export default new Action({
  name: 'AnnotateJob',
  description: 'Report annotations and a summary for the job this runner holds',
  method: 'POST',

  validations: {
    summary: { rule: schema.string() },
  },

  responses: {
    200: {
      description: 'How many annotations were recorded, and the check they belong to.',
      schema: {
        type: 'object',
        properties: {
          recorded: { type: 'integer' },
          check_run: { type: 'integer' },
        },
      },
    },
    401: { description: 'The job token is not one this instance issued, or the job is not running.' },
    409: { description: 'The runner speaks a protocol version this server does not.' },
  },

  async handle(request: any) {
    const protocol = protocolOf(request)

    if (!protocol.ok)
      return refuseProtocol(protocol)

    const held = await authenticateJob(request)

    if (!held)
      return runnerJson({ error: 'Unknown or expired job token' }, 401)

    /*
     * The job's own row, read from the id the token names rather than from
     * anything in the request: a runner that could say which job it is
     * annotating could annotate somebody else's.
     */
    const job: any = await db
      .selectFrom('workflow_jobs')
      .select(['id', 'workflow_run_id', 'job_id', 'name'])
      .where('id', '=', held.jobId)
      .executeTakeFirst()

    if (!job)
      return runnerJson({ error: 'Unknown job' }, 401)

    const run: any = await db
      .selectFrom('workflow_runs')
      .select(['id', 'repository_id', 'head_sha', 'number'])
      .where('id', '=', Number(job.workflow_run_id))
      .executeTakeFirst()

    if (!run)
      return runnerJson({ error: 'This job has no run' }, 401)

    const summary = String(request.get('summary') ?? '').slice(0, 60_000)
    const annotations = readAnnotations(request.get('annotations'))

    /*
     * One check per job, found or made.
     *
     * Named for the job rather than the workflow, because that is the grain a
     * reader wants on a pull request: "typecheck failed" is useful, "CI failed"
     * is the thing they already knew.
     */
    const name = String(job.name ?? job.job_id ?? 'job')

    const existing: any = await db
      .selectFrom('check_runs')
      .select(['id'])
      .where('repository_id', '=', Number(run.repository_id))
      .where('head_sha', '=', String(run.head_sha))
      .where('name', '=', name)
      .executeTakeFirst()

    const checkRunId = existing
      ? Number(existing.id)
      : await createCheck(Number(run.repository_id), String(run.head_sha), name, summary)

    if (existing && summary) {
      await db
        .updateTable('check_runs')
        .set({ summary } as any)
        .where('id', '=', checkRunId)
        .execute()
    }

    /*
     * Replaced rather than appended.
     *
     * A job that is retried reports again, and two copies of every annotation
     * on one line is a diff nobody can read. The run is the unit of truth, so
     * the newest report for a check is the whole of it.
     */
    await db.deleteFrom('check_annotations').where('check_run_id', '=', checkRunId).execute()

    for (const annotation of annotations) {
      await db
        .insertInto('check_annotations')
        .values({
          check_run_id: checkRunId,
          path: annotation.path,
          start_line: annotation.startLine,
          end_line: annotation.endLine,
          side: 'right',
          level: annotation.level,
          title: annotation.title,
          message: annotation.message,
        } as any)
        .execute()
    }

    return runnerJson({ recorded: annotations.length, check_run: checkRunId })
  },
})

/** A check for this job, when it is the first thing to report one. */
async function createCheck(repositoryId: number, headSha: string, name: string, summary: string): Promise<number> {
  const created: any = await db
    .insertInto('check_runs')
    .values({
      repository_id: repositoryId,
      head_sha: headSha,
      name,
      status: 'in_progress',
      summary: summary || null,
      // The workflow that produced it, so a reader can tell a check reported by
      // this instance's own runner from one an external system pushed.
      provider: 'workflow',
    } as any)
    .returning(['id'])
    .executeTakeFirst()

  return Number(created?.id)
}

interface ReadAnnotation {
  level: 'notice' | 'warning' | 'error'
  message: string
  path: string
  startLine: number
  endLine: number
  title: string | null
}

/**
 * What the runner sent, read defensively.
 *
 * Capped at two hundred: a step in a loop can print an annotation per line of a
 * large file, and a check with fifty thousand of them is a diff that never
 * renders. The cap is here as well as in the runner because the runner is the
 * part this instance does not control.
 */
function readAnnotations(value: unknown): ReadAnnotation[] {
  const list = Array.isArray(value) ? value : []
  const annotations: ReadAnnotation[] = []

  for (const entry of list.slice(0, 200)) {
    const record = entry && typeof entry === 'object' ? entry as Record<string, unknown> : null

    if (!record)
      continue

    const message = String(record.message ?? '').slice(0, 4000)

    if (!message)
      continue

    const level = String(record.level ?? 'notice').toLowerCase()
    const start = Number(record.start_line ?? 0)
    const end = Number(record.end_line ?? start)

    annotations.push({
      level: level === 'error' || level === 'warning' ? level : 'notice',
      message,
      // A path is a string a step printed. Trimmed of a leading `./` so it
      // matches the diff's paths, and otherwise taken as it came: verifying it
      // against the tree would refuse a generated file that is not committed,
      // which is a real thing tools report on.
      path: String(record.path ?? '').replace(/^\.\//, '').slice(0, 500),
      startLine: Number.isFinite(start) && start > 0 ? start : 1,
      endLine: Number.isFinite(end) && end >= start ? end : (Number.isFinite(start) && start > 0 ? start : 1),
      title: record.title ? String(record.title).slice(0, 200) : null,
    })
  }

  return annotations
}

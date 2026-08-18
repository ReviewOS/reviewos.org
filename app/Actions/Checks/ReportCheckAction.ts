import type { CheckDetail } from '../../Webhooks/payloads'
import { Action } from '@stacksjs/actions'
import { schema } from '@stacksjs/validation'
import { RATE_LIMIT_HEADERS, REPOSITORY_ERRORS } from '../../Api/documented'
import { notifyProgramsOnly } from '../../Notifications/emit'
import { authorizeRepository } from '../Repo/authorize'

/**
 * What a CI system posts when it has something to say about a commit.
 *
 * One endpoint for both shapes - a commit status and a check run - because a
 * reporter has one question ("here is my verdict") and splitting it across two
 * endpoints means two places the permission check, the idempotency and the
 * out-of-order rules have to be right.
 *
 * ## Behind `checks`, which is not `contents`
 *
 * The fine-grained rule phase 9 asks for: reporting a verdict is not permission
 * to push code or to administer anything. A CI token that could push is a CI
 * token whose compromise is a supply chain incident, and CI tokens live in more
 * places than any other credential an organization has.
 *
 * ## Idempotency, and why it is a database constraint
 *
 * A reporter retries a create when the connection drops after the row was
 * written and before the response arrived. Without a key it gets a second run,
 * which sits `queued` forever and blocks a merge on a check that no longer
 * exists anywhere. Checked-then-inserted, two retries at once both find nothing
 * and both insert - so the uniqueness is on the column and the duplicate is
 * caught by the failure rather than prevented by a look.
 *
 * ## A late report cannot undo a finished one
 *
 * CI systems deliver out of order, and a `queued` that arrives after a
 * `completed` would otherwise reopen a check that has already reported. The
 * transition is compared before it is applied: forward and equal states are
 * written, backward ones are answered with the row as it stands.
 */
export default new Action({
  name: 'ReportCheck',
  description: 'Report a commit status or a check run',
  method: 'POST',

  validations: {
    owner: { rule: schema.string().required() },
    repository: { rule: schema.string() },
    sha: { rule: schema.string().required() },
    kind: { rule: schema.enum(['status', 'check_run']) },
  },

  responses: {
    200: {
      description: 'The run as it now stands. `ignored` is present when a late report was refused because a later one had already been recorded - which is not an error from the reporter\'s side, so it is not answered as one.',
      schema: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          name: { type: 'string' },
          status: { type: 'string', enum: ['queued', 'in_progress', 'completed'] },
          conclusion: { type: 'string', nullable: true },
          ignored: { type: 'string' },
        },
      },
    },
    201: {
      description: 'A check run or commit status was created.',
      schema: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          name: { type: 'string' },
          context: { type: 'string', description: 'On a commit status, where a check run has a name.' },
          status: { type: 'string' },
          state: { type: 'string', description: 'On a commit status: pending, success, failure or error.' },
          conclusion: { type: 'string', nullable: true },
        },
      },
    },
    ...REPOSITORY_ERRORS,
    422: { description: 'A malformed sha, an unknown state, or a completed run with no conclusion.' },
  },

  responseHeaders: RATE_LIMIT_HEADERS,

  async handle(request: RequestInstance) {
    /*
     * `checks:write` rather than `contents:write`.
     *
     * `check:report` is the ability, and `app/TokenScopes.ts` maps it to the
     * `checks` scope - so a token granted only that can report a verdict and
     * cannot push a commit, which is the whole point of the separation. The
     * coverage endpoint already uses the same ability.
     */
    const auth = await authorizeRepository(request, 'check:report')

    if (!auth.ok)
      return response.json({ error: auth.error }, auth.status)

    const { repository, user } = auth.context
    const sha = String(request.get('sha') ?? '').trim()

    if (!/^[0-9a-f]{40}$/i.test(sha))
      return response.json({ error: 'A full 40-character commit sha is required.' }, 422)

    const kind = String(request.get('kind') ?? 'check_run')

    /*
     * Enough to name the repository in a webhook body, carried rather than
     * looked up again: the payload says `owner/name`, and re-reading the row
     * per report would be a query per check transition on a busy morning.
     */
    const about = {
      repositoryId: Number(repository.id),
      // The handle the caller addressed, which is what resolved this
      // repository a moment ago. Re-deriving it from `owner_type` and
      // `owner_id` would be a second query per check transition, and on a busy
      // morning that is a query per transition per check.
      owner: String(request.get('owner') ?? '').trim().toLowerCase(),
      repository: String(repository.name),
      actorId: user?.id ?? 0,
      actorHandle: String(user?.handle ?? ''),
    }

    if (kind === 'status')
      return await reportStatus(request, about, sha, user?.id ?? null)

    return await reportCheckRun(request, about, sha, user?.id ?? null)
  },
})

/**
 * A commit status: a name, a state, and a link.
 *
 * Appended rather than updated. A CI system posts `pending` and then `success`
 * under one context and both rows are kept - the rollup reads the newest, and
 * "did this always pass, or did somebody re-run it until it did" stays a
 * question the history can answer.
 */
async function reportStatus(request: any, about: About, sha: string, creatorId: number | null): Promise<Response> {
  const repositoryId = about.repositoryId
  const context = String(request.get('context') ?? '').trim()
  const state = String(request.get('state') ?? '').trim()

  if (!context)
    return response.json({ error: 'A status needs a context, for example ci/build.' }, 422)

  if (!['pending', 'success', 'failure', 'error'].includes(state))
    return response.json({ error: 'state must be pending, success, failure or error.' }, 422)

  const created = await db
    .insertInto('commit_statuses')
    .values({
      repository_id: repositoryId,
      sha,
      context,
      state,
      target_url: String(request.get('target_url') ?? '') || null,
      description: String(request.get('description') ?? '') || null,
      creator_id: creatorId,
    })
    .returning(['id'])
    .executeTakeFirst()

  await announce(about, 'status:reported', {
    name: context,
    sha,
    // A status has no lifecycle of its own: it *is* the report. `pending` is
    // the one state that has not concluded, and calling it completed would tell
    // a gate to act on a check that is still running.
    status: state === 'pending' ? 'in_progress' : 'completed',
    conclusion: state === 'pending' ? null : state === 'success' ? 'success' : 'failure',
    attempt: 1,
    details_url: String(request.get('target_url') ?? ''),
    summary: String(request.get('description') ?? ''),
  })

  return response.json({ id: Number(created?.id), context, state }, 201)
}

/** The order a check run's status may move in. Backwards is refused. */
const STATUS_ORDER: Record<string, number> = { queued: 0, in_progress: 1, completed: 2 }

/**
 * A check run: created, then updated as it progresses.
 *
 * One endpoint for both, keyed on the idempotency key or on the run's id. A
 * reporter that has our id sends it; one that has only its own key sends that;
 * one that has neither is creating.
 */
async function reportCheckRun(request: any, about: About, sha: string, reporterId: number | null): Promise<Response> {
  const repositoryId = about.repositoryId
  const name = String(request.get('name') ?? '').trim()
  const status = String(request.get('status') ?? 'queued').trim()

  if (!name)
    return response.json({ error: 'A check run needs a name.' }, 422)

  if (!(status in STATUS_ORDER))
    return response.json({ error: 'status must be queued, in_progress or completed.' }, 422)

  const conclusion = String(request.get('conclusion') ?? '').trim() || null

  if (status === 'completed' && !conclusion)
    return response.json({ error: 'A completed check run needs a conclusion.' }, 422)

  const idempotencyKey = String(request.get('idempotency_key') ?? '').trim() || null
  const id = Number(request.get('id') ?? 0)

  const existing: any = id
    ? await db.selectFrom('check_runs').selectAll().where('id', '=', id).where('repository_id', '=', repositoryId).executeTakeFirst()
    : idempotencyKey
      ? await db.selectFrom('check_runs').selectAll().where('idempotency_key', '=', idempotencyKey).executeTakeFirst()
      : null

  const fields = {
    repository_id: repositoryId,
    head_sha: sha,
    name,
    status,
    conclusion,
    details_url: String(request.get('details_url') ?? '') || null,
    summary: String(request.get('summary') ?? '') || null,
    output_title: String(request.get('output_title') ?? '') || null,
    output_text: String(request.get('output_text') ?? '') || null,
    provider: String(request.get('provider') ?? '') || null,
    external_id: String(request.get('external_id') ?? '') || null,
    reporter_id: reporterId,
    attempt: Number(request.get('attempt')) || 1,
    completed_at: status === 'completed' ? new Date().toISOString() : null,
  }

  if (!existing) {
    const created = await db
      .insertInto('check_runs')
      .values({ ...fields, idempotency_key: idempotencyKey, started_at: new Date().toISOString() })
      .returning(['id'])
      .executeTakeFirst()

    await writeAnnotations(request, Number(created?.id))

    await announce(about, 'check:reported', {
      name,
      sha,
      status,
      conclusion,
      attempt: Number(fields.attempt) || 1,
      details_url: String(fields.details_url ?? ''),
      summary: String(fields.summary ?? ''),
    })

    return response.json({ id: Number(created?.id), name, status, conclusion }, 201)
  }

  /*
   * The transition, compared before it is applied.
   *
   * A `queued` arriving after a `completed` is a delivery that overtook itself,
   * and applying it would reopen a check that has already reported - unblocking
   * a merge, or blocking one that had passed, depending on which way round. The
   * row as it stands is returned rather than an error, because from the
   * reporter's side nothing is wrong: it sent what it had.
   */
  if (STATUS_ORDER[status]! < STATUS_ORDER[String(existing.status)]!) {
    return response.json({
      id: Number(existing.id),
      name: String(existing.name),
      status: String(existing.status),
      conclusion: existing.conclusion ? String(existing.conclusion) : null,
      ignored: 'a later report has already been recorded for this run',
    })
  }

  await db.updateTable('check_runs').set(fields as any).where('id', '=', Number(existing.id)).execute()
  await writeAnnotations(request, Number(existing.id))

  await announce(about, 'check:reported', {
    name,
    sha,
    status,
    conclusion,
    attempt: Number(fields.attempt) || 1,
    details_url: String(fields.details_url ?? ''),
    summary: String(fields.summary ?? ''),
  })

  return response.json({ id: Number(existing.id), name, status, conclusion })
}

/**
 * The annotations that came with this report.
 *
 * Replaced wholesale, because a reporter sends the annotations it currently
 * has: a re-run that fixed two of five lint errors sends three, and merging
 * them into the five already stored would leave the two it fixed on the diff
 * forever.
 */
async function writeAnnotations(request: any, checkRunId: number): Promise<void> {
  const raw = request.get('annotations')

  if (!raw || !checkRunId)
    return

  let annotations: any[]

  try {
    annotations = typeof raw === 'string' ? JSON.parse(raw) : raw
  }
  catch {
    return
  }

  if (!Array.isArray(annotations))
    return

  await db.deleteFrom('check_annotations').where('check_run_id', '=', checkRunId).execute()

  for (const annotation of annotations.slice(0, 500)) {
    const path = String(annotation?.path ?? '').trim()
    const startLine = Number(annotation?.start_line ?? annotation?.line ?? 0)

    if (!path || !Number.isInteger(startLine) || startLine < 1)
      continue

    await db.insertInto('check_annotations').values({
      check_run_id: checkRunId,
      path,
      start_line: startLine,
      // A single-line annotation has no end, and storing the start rather than
      // null means every reader does the same arithmetic.
      end_line: Number(annotation?.end_line ?? startLine) || startLine,
      side: String(annotation?.side ?? 'right') === 'left' ? 'left' : 'right',
      level: ['notice', 'warning', 'failure'].includes(String(annotation?.level)) ? String(annotation.level) : 'warning',
      title: String(annotation?.title ?? '') || null,
      message: String(annotation?.message ?? '') || 'Reported by a check',
      raw_details: String(annotation?.raw_details ?? '') || null,
    } as any).execute()
  }
}

/** Who and what a report is about, carried from the authorized request. */
interface About {
  repositoryId: number
  owner: string
  repository: string
  actorId: number
  actorHandle: string
}

/**
 * Tell the programs waiting on this commit.
 *
 * **After the write, never before**, like every other event in this codebase: a
 * receiver that reads the check back the moment it hears about it must see what
 * it was told, and the other order is a race that only appears under load and
 * reads as the API lying.
 *
 * A backward transition is deliberately silent. It changed nothing, and an
 * event saying a completed check is queued again would have a merge queue
 * reopen a gate that had already closed.
 *
 * Never throws, and not awaited for its effect: a webhook is a consequence of
 * somebody's report and must not be able to fail it. A CI system whose POST
 * returns 500 because a receiver is down retries the report, and the second
 * report is the duplicate the idempotency rules exist to absorb.
 */
async function announce(about: About, event: 'check:reported' | 'status:reported', check: CheckDetail): Promise<void> {
  await notifyProgramsOnly(event, {
    actorId: about.actorId,
    actorHandle: about.actorHandle,
    repositoryId: about.repositoryId,
    owner: about.owner,
    repository: about.repository,
    // A check is about a commit, and `subject` stays the repository rather than
    // being stretched to mean a sha: a receiver routing on `subject.type`
    // should not have to learn a fourth value to keep working. The commit is in
    // `check.sha`, where a receiver that cares about it is already looking.
    subjectType: 'repository',
    subjectId: about.repositoryId,
    title: `${check.name} on ${check.sha.slice(0, 10)}`,
    check,
  })
}

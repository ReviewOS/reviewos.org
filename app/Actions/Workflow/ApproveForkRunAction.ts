import { Action } from '@stacksjs/actions'
import { db } from '@stacksjs/database'
import { schema } from '@stacksjs/validation'
import { RATE_LIMIT_HEADERS, REPOSITORY_ERRORS } from '../../Api/documented'
import { auditEvent } from '../../Audit/events'
import { wantsHtml } from '../Auth/session'
import { authorizeRepository } from '../Repo/authorize'
import { settleRun } from './settle'

/**
 * Let a fork's pull request run, or say it should not.
 *
 * The fork policy's last clause needs a person, and this is the person. A pull
 * request from a first-time contributor is held: it gets no secrets and no
 * identity token whatever happens next, but running it at all spends the fleet
 * and reaches whatever those machines reach, so somebody with write access looks
 * at the diff first.
 *
 * **`workflow:approve`, the same ability a deployment gate needs.** Not
 * `workflow:cancel`: stopping a run is safe and starting a stranger's code is
 * not, and folding them together would mean anybody who can stop a build can
 * also run somebody else's.
 *
 * **Approving does not make the run trusted.** It runs; it still gets nothing.
 * Conflating "you may run" with "you are ours" is the mistake behind the
 * published secret-theft write-ups, and the two flags stay separate here for
 * exactly that reason.
 */
export default new Action({
  name: 'ApproveForkRun',
  description: 'Approve or refuse a held fork run',
  method: 'POST',

  validations: {
    owner: { rule: schema.string() },
    repo: { rule: schema.string() },
    number: { rule: schema.number() },
    decision: { rule: schema.string() },
  },

  responses: {
    200: {
      description: 'The run as it now stands.',
      schema: {
        type: 'object',
        properties: {
          run: {
            type: 'object',
            properties: {
              number: { type: 'integer' },
              state: { type: 'string' },
              approval_state: { type: 'string' },
              trusted: { type: 'boolean' },
            },
          },
          note: { type: 'string' },
        },
      },
    },
    303: { description: 'A browser gets its run page back; the same action serves the interface.' },
    409: { description: 'That run is not waiting for a decision: it never was held, or somebody has already decided.' },
    422: { description: 'The decision is `approve` or `refuse`.' },
    ...REPOSITORY_ERRORS,
  },

  responseHeaders: RATE_LIMIT_HEADERS,

  async handle(request: RequestInstance) {
    const auth = await authorizeRepository(request, 'workflow:approve')
    if (!auth.ok)
      return response.json({ error: auth.error }, auth.status)

    const { repository, user } = auth.context

    const number = Number(request.get('number'))
    const decision = String(request.get('decision') ?? 'approve').trim()

    if (!Number.isInteger(number) || number <= 0)
      return response.json({ error: 'A run number is required' }, 422)

    if (!['approve', 'refuse'].includes(decision))
      return response.json({ error: 'The decision is `approve` or `refuse`' }, 422)

    const run = await db
      .selectFrom('workflow_runs')
      .select(['id', 'state', 'approval_state', 'trusted', 'head_sha'])
      .where('repository_id', '=', repository.id)
      .where('number', '=', number)
      .executeTakeFirst()

    if (!run)
      return response.json({ error: 'No such workflow run' }, 404)

    /*
     * A conflict rather than an error, with the state. Two maintainers looking
     * at the same pull request and both pressing the button is ordinary, and the
     * second one has not made a mistake.
     */
    if (String(run.approval_state) !== 'required') {
      return response.json({
        run: { number, state: String(run.state), approval_state: String(run.approval_state) },
        note: String(run.approval_state) === 'approved'
          ? 'Somebody has already let this run.'
          : String(run.approval_state) === 'rejected'
            ? 'Somebody has already refused this run.'
            : 'This run was never held: it is the repository\'s own code.',
      }, 409)
    }

    const now = new Date().toISOString()

    if (decision === 'refuse') {
      /*
       * Cancelled rather than deleted, with the reason. A run somebody decided
       * should not have happened is a record worth keeping - the next person to
       * look at the pull request needs to see that a decision was made rather
       * than that nothing ever ran.
       */
      await db
        .updateTable('workflow_runs')
        .set({
          approval_state: 'rejected',
          approved_by: Number(user?.id ?? 0) || null,
          approved_at: now,
          state: 'cancelled',
          finished_at: now,
          conclusion_reason: `${user?.handle ?? 'somebody'} decided this fork's pull request should not run`,
        })
        .where('id', '=', Number(run.id))
        .where('approval_state', '=', 'required')
        .execute()

      await db
        .updateTable('workflow_jobs')
        .set({ state: 'cancelled', finished_at: now })
        .where('workflow_run_id', '=', Number(run.id))
        .where('state', 'in', ['blocked', 'queued'])
        .execute()

      await auditEvent('workflow:fork-run-refused', {
        actorId: user?.id ? Number(user.id) : null,
        subject: { type: 'workflow_run', id: Number(run.id) },
        repositoryId: Number(repository.id),
        detail: { run: number, head_sha: String(run.head_sha ?? '') },
      }).catch(() => null)

      return response.json({
        run: { number, state: 'cancelled', approval_state: 'rejected', trusted: false },
        note: 'Nothing ran. The run is kept, cancelled, with who decided on it.',
      })
    }

    await db
      .updateTable('workflow_runs')
      .set({
        approval_state: 'approved',
        approved_by: Number(user?.id ?? 0) || null,
        approved_at: now,
        state: 'queued',
        /*
         * `trusted` is deliberately untouched. Approving says "run this", not
         * "this is ours": the run gets no secrets and no identity token however
         * many people approved it, which is the whole of the fork policy.
         */
        conclusion_reason: null,
      })
      .where('id', '=', Number(run.id))
      .where('approval_state', '=', 'required')
      .execute()

    await db
      .updateTable('workflow_jobs')
      .set({ condition_reason: null })
      .where('workflow_run_id', '=', Number(run.id))
      .where('state', '=', 'blocked')
      .execute()

    // The settler releases what has nothing to wait for, exactly as it would
    // have at dispatch if the run had never been held.
    await settleRun(Number(run.id))

    await auditEvent('workflow:fork-run-approved', {
      actorId: user?.id ? Number(user.id) : null,
      subject: { type: 'workflow_run', id: Number(run.id) },
      repositoryId: Number(repository.id),
      detail: { run: number, head_sha: String(run.head_sha ?? '') },
    }).catch(() => null)

    const after = await db
      .selectFrom('workflow_runs')
      .select(['state'])
      .where('id', '=', Number(run.id))
      .executeTakeFirst()

    if (wantsHtml(request))
      return response.redirect(`/${String(request.get('owner'))}/${String(request.get('repo'))}/run/${number}`, 303)

    return response.json({
      run: { number, state: String(after?.state ?? 'queued'), approval_state: 'approved', trusted: false },
      // Said out loud, because it is the part people assume the other way round.
      note: 'This run may now be claimed. It is still untrusted: no secrets, no identity token.',
    })
  },
})

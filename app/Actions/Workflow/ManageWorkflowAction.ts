import { Action } from '@stacksjs/actions'
import { db } from '@stacksjs/database'
import { schema } from '@stacksjs/validation'
import { RATE_LIMIT_HEADERS, REPOSITORY_ERRORS } from '../../Api/documented'
import { authorizeRepository } from '../Repo/authorize'

/**
 * Turning a workflow off without deleting it.
 *
 * `disabled` has been a state on the workflow row since the beginning, and
 * every dispatch path already refuses to run one - the push dispatcher, the
 * schedule sweep and the manual dispatch all check it. Nothing could ever *set*
 * it, which made the check dead code and the state a lie: a reader of the model
 * would conclude a workflow could be turned off, and no path existed.
 *
 * **Off, not deleted**, and the difference is the point. Deleting means editing
 * the repository - a commit, a review, a revert when the reason passes - for
 * something that is usually temporary: a nightly job failing while an upstream
 * service is down, a deploy paused during a freeze. `removed` stays the third
 * state and keeps meaning what it means: the file is gone from the branch.
 *
 * A disabled workflow keeps its runs, its history and its schedule. Turning it
 * back on resumes exactly what it was, which is the property that makes turning
 * it off a decision somebody is willing to make quickly.
 */
export default new Action({
  name: 'ManageWorkflow',
  description: 'Enable or disable a workflow without deleting it',
  method: 'POST',

  validations: {
    owner: { rule: schema.string() },
    repo: { rule: schema.string() },
    workflow: { rule: schema.string() },
    operation: { rule: schema.enum(['enable', 'disable']) },
    reason: { rule: schema.string() },
  },

  responses: {
    200: { description: 'The workflow, and what it will and will not do now.' },
    ...REPOSITORY_ERRORS,
    404: { description: 'No workflow by that name or path in this repository.' },
    409: { description: 'That workflow is `removed`: its file is gone from the branch, so there is nothing to enable.' },
  },

  responseHeaders: RATE_LIMIT_HEADERS,

  async handle(request: any) {
    /*
     * `workflow:dispatch` rather than a settings ability. Somebody who may
     * start a workflow by hand is the same person who needs to stop one that
     * is failing at three in the morning, and requiring repository
     * administration for that means the person on call cannot.
     */
    const auth = await authorizeRepository(request, 'workflow:dispatch')

    if (!auth.ok)
      return response.json({ error: auth.error }, auth.status)

    const key = String(request.get('workflow') ?? '').trim()

    if (!key)
      return response.json({ error: 'Which workflow?' }, 422)

    /*
     * By path or by name, because both are what people have. The runs page
     * says the name, the repository says the path, and asking somebody to
     * translate between them is asking them to look it up first.
     */
    const workflow: any = await db
      .selectFrom('workflows')
      .select(['id', 'name', 'path', 'state'])
      .where('repository_id', '=', Number(auth.context.repository.id))
      .where((query: any) => query.where('path', '=', key).orWhere('name', '=', key))
      .executeTakeFirst()
      .catch(() => null)

    if (!workflow)
      return response.json({ error: 'No such workflow in this repository' }, 404)

    const operation = String(request.get('operation') ?? '').trim()

    if (String(workflow.state) === 'removed') {
      /*
       * A removed workflow is one whose file is gone from the branch. Enabling
       * it would be a row saying `active` for a file nothing can read, and the
       * next sync would put it straight back - so the answer is what actually
       * has to happen.
       */
      return response.json({
        error: 'That workflow\'s file is no longer on the default branch',
        reason: 'Restore the file and it registers itself again; there is nothing here to turn back on.',
      }, 409)
    }

    const state = operation === 'enable' ? 'active' : 'disabled'

    await db
      .updateTable('workflows')
      .set({ state } as any)
      .where('id', '=', Number(workflow.id))
      .execute()

    return response.json({
      workflow: { name: String(workflow.name), path: String(workflow.path), state },
      /*
       * Said back rather than left to be inferred. "Disabled" is ambiguous
       * about the runs already going and about what happens on the next push,
       * and both are questions somebody has at the moment they press it.
       */
      note: state === 'disabled'
        ? 'Pushes, schedules and manual dispatches will not start it. Runs already going are unaffected, and its history is kept.'
        : 'It will run again on the next push, schedule or dispatch.',
    })
  },
})

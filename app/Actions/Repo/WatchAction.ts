import { Action } from '@stacksjs/actions'
import { schema } from '@stacksjs/validation'
import { safeRedirect, wantsHtml } from '../Auth/session'
import { currentUser } from '../Identity/lookup'
import { authorizeRepository } from './authorize'

/** What a person can ask to hear about. */
export const SUBSCRIPTIONS = ['all', 'participating', 'ignore'] as const

/**
 * Set how much somebody wants to hear about a repository.
 *
 * Not a toggle, unlike starring, because there are three answers and the middle
 * one is the one people want: tell me about threads I am in. A two-state watch
 * button makes everybody choose between silence and every issue anyone opens,
 * and what they choose is silence.
 *
 * `ignore` is stored as a row rather than as the absence of one. "I have never
 * decided" and "I have decided not to hear about this" are different states,
 * and only the second one should survive somebody being mentioned in a thread.
 */
export default new Action({
  name: 'Watch',
  description: 'Set or clear a watch on a repository',
  method: 'PUT',

  /*
   * Declared here so the generated reference lists them and the validator
   * enforces them from the same object. `owner` plus one of `repo` or
   * `repository` is how every repository-scoped endpoint is addressed - see
   * `authorizeRepository` - and a caller that forgets one should be told that
   * rather than shown a 404 that reads as "no such repository".
   */
  validations: {
    owner: { rule: schema.string().required() },
    repo: { rule: schema.string() },
    repository: { rule: schema.string() },
    /*
     * `none` is in the list, and it had to be.
     *
     * The handler has always treated an empty or `none` subscription as "stop
     * watching" - documented three paragraphs up as a state distinct from
     * `ignore` - while this rule listed only the three stored values. So the
     * one way to *clear* a watch was refused by the validator before the
     * handler ran, and the caller got a 422 naming a value the endpoint's own
     * documentation tells them to send. Nothing had ever sent it, because
     * nothing had ever drawn the control.
     */
    subscription: { rule: schema.enum(['all', 'participating', 'ignore', 'none']) },
  },

  responses: {
    200: { description: 'The subscription as it now stands.' },
    302: { description: 'A browser form was answered with a redirect back to the page it came from. Scripts get the JSON above.' },
    401: { description: 'Unauthenticated.' },
    422: { description: 'The subscription is not one of `all`, `participating` or `ignore`.' },
    404: { description: 'No such repository, or none this caller may see. A private repository answers this rather than 403, because a 403 confirms it exists.' },
  },

  async handle(request: RequestInstance) {
    const auth = await authorizeRepository(request, 'repository:read')
    if (!auth.ok)
      return response.json({ error: auth.error }, auth.status)

    const user = await currentUser(request)
    if (!user)
      return response.json({ error: 'Unauthenticated' }, 401)

    const repositoryId = Number(auth.context.repository.id)
    const raw = String(request.get('subscription') ?? '').trim().toLowerCase()

    // No subscription at all means stop watching: back to whatever the defaults
    // would have said, which is not the same as `ignore`.
    if (!raw || raw === 'none') {
      await db
        .deleteFrom('watches')
        .where('repository_id', '=', repositoryId)
        .where('user_id', '=', user.id)
        .execute()

      if (wantsHtml(request))
        return backToThePage(request, auth)

      return response.json({ watching: false, subscription: null })
    }

    if (!(SUBSCRIPTIONS as readonly string[]).includes(raw))
      return response.json({ error: 'No such subscription' }, 422)

    const existing = await db
      .selectFrom('watches')
      .select(['id'])
      .where('repository_id', '=', repositoryId)
      .where('user_id', '=', user.id)
      .executeTakeFirst()

    if (existing) {
      await db
        .updateTable('watches')
        .set({ subscription: raw })
        .where('repository_id', '=', repositoryId)
        .where('user_id', '=', user.id)
        .execute()
    }
    else {
      await db
        .insertInto('watches')
        .values({ repository_id: repositoryId, user_id: user.id, subscription: raw })
        .execute()
    }

    if (wantsHtml(request))
      return backToThePage(request, auth)

    return response.json({ watching: raw !== 'ignore', subscription: raw })
  },
})

/**
 * A browser gets the page back; a script gets the JSON.
 *
 * The watch control is a form, because this product's pages run no client-side
 * JavaScript - the same shape as the star button beside it - and a form left to
 * follow this response would land the reader on a page of JSON.
 *
 * `next` is checked rather than trusted: `safeRedirect` refuses anything that
 * is not a path on this host, because an open redirect on an authenticated
 * write is a real one.
 */
function backToThePage(request: RequestInstance, auth: { context: { repository: { name?: unknown } } }): Response {
  const home = `/${String(request.get('owner') ?? '')}/${String(auth.context.repository.name ?? '')}`

  return response.redirect(safeRedirect(request.get('next'), home))
}

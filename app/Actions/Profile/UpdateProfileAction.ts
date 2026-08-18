import { Action } from '@stacksjs/actions'
import { currentUser } from '../Identity/lookup'
import { checkHandle, normalizeHandle } from '../Identity/handles'

/** What a reader may put in each field. Long enough to be useful, short enough to render. */
const LIMITS = { name: 100, bio: 300, location: 100, website: 200 }

/**
 * Edit your own profile.
 *
 * Only your own, and there is no parameter that could say otherwise. An
 * endpoint that takes a user id and checks it against the caller is one where
 * the check can be forgotten; one that has no id cannot be.
 *
 * **Changing a handle moves a page.** `/{handle}` is the profile URL and the
 * first segment of every repository URL under it, so a rename breaks every link
 * anybody has written down - in an issue, in a chat, in a bookmark. It is
 * allowed because people do need it, and the old handle is deliberately *not*
 * released back into the pool by this endpoint: whoever registers it next would
 * inherit every one of those links, which is impersonation handed over by the
 * product.
 */
export default new Action({
  name: 'UpdateProfile',
  description: 'Update the signed-in user\'s profile',
  method: 'POST',

  async handle(request: any) {
    const user = await currentUser(request)
    if (!user)
      return response.json({ error: 'Unauthenticated' }, 401)

    const changes: Record<string, unknown> = {}

    for (const field of ['name', 'bio', 'location'] as const) {
      if (request.get(field) !== undefined)
        changes[field] = String(request.get(field) ?? '').trim().slice(0, LIMITS[field])
    }

    if (request.get('website') !== undefined) {
      const website = String(request.get('website') ?? '').trim().slice(0, LIMITS.website)

      // `http` or `https` or nothing. A profile link is rendered as an anchor,
      // and `javascript:` in an anchor on a page every reader visits is stored
      // XSS with a form in front of it.
      if (website && !/^https?:\/\//i.test(website))
        return respond(request, { error: 'A website must start with http:// or https://' }, 422)

      changes.website = website
    }

    const requested = request.get('handle')

    if (requested !== undefined) {
      const handle = normalizeHandle(String(requested))

      if (handle !== user.handle) {
        const shape = checkHandle(handle)

        if (!shape.ok)
          return respond(request, { error: shape.message ?? 'That handle cannot be used.' }, 422)

        const taken = await db
          .selectFrom('users')
          .select(['id'])
          .where('handle', '=', handle)
          .executeTakeFirst()

        if (taken)
          return respond(request, { error: 'That handle is taken.' }, 422)

        changes.handle = handle
      }
    }

    if (Object.keys(changes).length === 0)
      return respond(request, { ok: true, unchanged: true }, 200)

    await db
      .updateTable('users')
      .set(changes)
      .where('id', '=', user.id)
      .execute()

    const handle = String(changes.handle ?? user.handle)

    return respond(request, { ok: true, handle }, 200, `/${handle}`)
  },
})

/** A redirect for a form, JSON for everything else. */
function respond(request: any, body: Record<string, unknown>, status: number, location?: string) {
  const accept = String(request?.header?.('accept') ?? request?.headers?.get?.('accept') ?? '')

  if (accept.includes('text/html')) {
    // Errors go back to the form with the reason rather than to a bare status
    // page, so somebody who typed a taken handle can pick another without
    // losing the four fields they filled in first.
    const to = status >= 400
      ? `/settings/profile?error=${encodeURIComponent(String(body.error ?? 'That did not work.'))}`
      : location ?? '/settings/profile'

    return new Response(null, { status: 303, headers: { Location: to } })
  }

  return response.json(body, status)
}

import { Action } from '@stacksjs/actions'
import { canOnRepository } from '../../Permissions'
import { permissionOn } from '../Git/access'
import { currentUser } from '../Identity/lookup'
import { attachmentPath, isAttachmentKey, kindFor } from './storage'

/**
 * Serve an uploaded file.
 *
 * Through an action rather than as a static file, because an attachment on a
 * private repository's issue is exactly as private as the issue, and a
 * directory served by the web server cannot know that. An unguessable key is
 * not access control; it is a name.
 *
 * Two rules hold everything up, and both are about the browser rather than
 * about the file:
 *
 * - **`nosniff`, always.** Without it a browser is free to decide a response is
 *   HTML because it looks like HTML, whatever the content type says, and a
 *   same-origin HTML document uploaded by a stranger is stored cross-site
 *   scripting with extra steps.
 * - **Inline for a short list, a download for everything else.** The list is
 *   raster images, which a browser cannot be talked into executing. An SVG is
 *   not on it: it is a document with scripting in it that happens to look like
 *   an image.
 */
export default new Action({
  name: 'ServeAttachment',
  description: 'Serve an uploaded attachment, if the reader may see its repository',
  method: 'GET',

  async handle(request: any) {
    // Read off the path rather than through the router's parameter bag, the
    // same way the git routes do: these URLs are mounted at the root and the
    // last segment is the whole request.
    const key = new URL(request.url).pathname.split('/').pop() ?? ''

    // A key is 32 hex characters or it is not a key, so there is nothing to
    // sanitize and no path to escape from.
    if (!isAttachmentKey(key))
      return response.json({ error: 'Not found' }, 404)

    const attachment: any = await db
      .selectFrom('attachments')
      .select(['key', 'repository_id', 'filename', 'content_type', 'byte_size'])
      .where('key', '=', key)
      .executeTakeFirst()

    if (!attachment)
      return response.json({ error: 'Not found' }, 404)

    const repository: any = await db
      .selectFrom('repositories')
      .select(['id', 'visibility', 'owner_type', 'owner_id'])
      .where('id', '=', Number(attachment.repository_id))
      .executeTakeFirst()

    if (!repository)
      return response.json({ error: 'Not found' }, 404)

    const user = await currentUser(request)
    const grants = await permissionOn(repository, user?.id ?? null)

    const mayRead = canOnRepository({
      userId: user?.id ?? null,
      visibility: repository.visibility,
      ownerUserId: repository.owner_type === 'user' ? Number(repository.owner_id) : null,
      ...grants,
    }, 'repository:read')

    // Missing rather than forbidden, the same answer the repository itself
    // gives: "you are not allowed to see this" confirms it exists.
    if (!mayRead)
      return response.json({ error: 'Not found' }, 404)

    const path = attachmentPath(key)!
    const file = Bun.file(path)

    if (!(await file.exists()))
      return response.json({ error: 'Not found' }, 404)

    const kind = kindFor(String(attachment.content_type))
    const disposition = kind?.inline ? 'inline' : 'attachment'

    return new Response(file, {
      headers: {
        // The stored type, not the requested one. The stored type was decided
        // by reading the bytes when the file arrived.
        'Content-Type': String(attachment.content_type),
        'Content-Length': String(attachment.byte_size),
        'X-Content-Type-Options': 'nosniff',
        // The filename is quoted and was reduced to ordinary filename
        // characters before it was stored, so there is nothing in it that can
        // end the header early.
        'Content-Disposition': `${disposition}; filename="${attachment.filename}"`,
        // Private, because the answer depends on who asked. A shared cache that
        // kept this would hand a private repository's screenshot to the next
        // person who asked for the same URL.
        'Cache-Control': 'private, max-age=31536000, immutable',
      },
    })
  },
})

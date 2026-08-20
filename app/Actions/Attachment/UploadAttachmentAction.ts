import { Action } from '@stacksjs/actions'
import { schema } from '@stacksjs/validation'
import { authorizeRepository } from '../Repo/authorize'
import { storeAttachment } from './upload'

/**
 * Upload one file and get back the markdown that references it.
 *
 * The browser does not need this: a file picked next to a comment box is stored
 * when the comment is submitted, because the page runs no client-side
 * JavaScript and there is no editor to insert a link into. This endpoint is for
 * everything else - the API, the CLI, an agent writing an issue - where the
 * caller wants the reference before it writes the body that uses it.
 *
 * Uploading needs no more than commenting does. Anybody who can attach a
 * screenshot to a bug report should be able to, and a screenshot is usually the
 * most useful thing in the report.
 */
export default new Action({
  name: 'UploadAttachment',
  description: 'Upload a file and get the markdown that references it',
  method: 'POST',

  // Declared so the document can publish them: every key is one the handler
  // reads. **Enforced, not descriptive**: the framework checks these before the
  // handler runs and answers 422 itself, so a named type here is a promise that
  // the endpoint refuses every other spelling of the value. A field the handler
  // coerces takes `coerced` from `app/Actions/inputs.ts` instead.
  validations: {
    owner: { rule: schema.string() },
    repo: { rule: schema.string() },
  },

  async handle(request: RequestInstance) {
    const auth = await authorizeRepository(request, 'attachment:upload')
    if (!auth.ok)
      return response.json({ error: auth.error }, auth.status)

    const { repository, user } = auth.context
    if (!user)
      return response.json({ error: 'Unauthenticated' }, 401)

    const file = request.file?.('file') ?? request.file?.('attachment')
    if (!file)
      return response.json({ error: 'No file was uploaded' }, 422)

    const stored = await storeAttachment(file, Number(repository.id), user.id)
    if (!stored.ok)
      return response.json({ error: stored.error }, stored.status)

    return response.json({
      key: stored.key,
      url: stored.url,
      markdown: stored.markdown,
      filename: stored.filename,
      content_type: stored.kind.contentType,
      byte_size: stored.bytes,
    }, 201)
  },
})

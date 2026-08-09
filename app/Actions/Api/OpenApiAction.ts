import { Action } from '@stacksjs/actions'
import { path } from '@stacksjs/path'
import { conditional, etagFrom } from '../../Api/etag'

/**
 * The OpenAPI document, published.
 *
 * Generating it is not the same as publishing it. A document that exists in
 * `storage/framework/api/openapi.json` is discoverable by somebody who has the
 * source, which is precisely the group that did not need it - the bar this
 * phase set is that the API is discoverable *without* reading the source.
 *
 * Served from the file rather than regenerated per request. Generation loads
 * every route and imports every action, which is a second of work and a
 * surprising amount of memory for a document that changes when somebody
 * deploys. The framework's `/__openapi.json` regenerates on every hit and is
 * the right thing in development, for the opposite reason: there, the file on
 * disk is the stale one.
 *
 * Public, and deliberately. The document describes which endpoints exist, not
 * what is in them, and every one of them still answers a stranger exactly as it
 * did before. An API that hides its own shape from unauthenticated callers is
 * an API whose clients are written by guessing.
 */
export default new Action({
  name: 'OpenApi',
  description: 'The OpenAPI document describing this instance',
  method: 'GET',

  async handle(request: any) {
    const file = Bun.file(path.frameworkPath('api/openapi.json'))

    if (!await file.exists()) {
      /*
       * 503 rather than 404. The document is a build artifact, and a
       * deployment missing it is misconfigured rather than a server that does
       * not offer one - a 404 sends the reader looking for the right URL, and
       * there is no right URL to find.
       */
      return response.json(
        { error: 'The OpenAPI document has not been generated for this instance. Run `buddy generate:openapi`.' },
        503,
      )
    }

    // From the file's size and mtime rather than its contents: this document is
    // three quarters of a megabyte, and hashing it on every poll to answer "has
    // it changed since you deployed" would cost more than sending it.
    const stat = await file.stat()
    const tag = etagFrom(['openapi', stat.size, stat.mtimeMs])

    return await conditional(request, tag, async () => {
      return new Response(file, {
        headers: {
          'Content-Type': 'application/json',
          /*
           * Cacheable for a minute, and public. The document changes on deploy,
           * a client that reads it does so once at startup, and a minute of
           * staleness is invisible to both while a proxy in front of a busy
           * instance stops serving the same 750KB repeatedly.
           */
          'Cache-Control': 'public, max-age=60',
        },
      })
    })
  },
})

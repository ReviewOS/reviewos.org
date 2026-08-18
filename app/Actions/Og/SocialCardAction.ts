import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Action } from '@stacksjs/actions'
import { path as frameworkPath } from '@stacksjs/path'
import { schema } from '@stacksjs/validation'
import { cardFor } from './card'
import { cardCopyFor } from './resolve'

/**
 * The link-preview image for a page the build could not enumerate.
 *
 * A repository, a pull request, an issue, an account: an instance has one page
 * per each and no list to generate cards from, so this draws one when a
 * scraper asks. `resources/functions/meta.ts` points the `og:image` of those
 * pages here; see `runtimeCard`.
 *
 * **Under `/api` because of how this application is routed.** Only that prefix
 * reaches the route registry - everything else is resolved by the file-based
 * view router, which would send `/og/owner/repository` to the profile page.
 * The URL is read by machines and never typed by a person, so the prefix is
 * free.
 *
 * **It never fails.** Every path that resolves to nothing, and every path that
 * names something a stranger may not see, gets the same generic site card that
 * `buddy generate:images` already produced. A 404 on an `og:image` is a broken
 * image in somebody's chat window, which is worse than a generic one, and an
 * error that only happens for private repositories is a way of confirming they
 * exist.
 */
export default new Action({
  name: 'SocialCard',
  description: 'Draw the link-preview card for a repository, pull request, issue, or account',
  method: 'GET',

  validations: {
    // The page the card is for. Declared so the endpoint documents itself,
    // and read off the URL below rather than through the request bag: a
    // scraper sends whatever the markup told it to, and the resolver treats
    // every segment of it as untrusted regardless.
    path: { rule: schema.string() },
  },

  async handle(request: RequestInstance) {
    const asked = new URL(request.url).searchParams.get('path') ?? '/'

    // Whatever this resolves to, it is resolved as a stranger - see
    // `cardCopyFor`. Never allowed to throw: a database hiccup should cost a
    // specific card, not every preview on the instance.
    const copy = await cardCopyFor(asked).catch(() => null)

    if (!copy)
      return fallback()

    try {
      const { bytes, key } = await cardFor(copy)

      return new Response(body(bytes), { headers: headers(`"${key}"`) })
    }
    catch {
      return fallback()
    }
  },
})

/**
 * The generated site card, served rather than redirected to.
 *
 * A redirect would be tidier and some unfurlers do not follow one on an
 * `og:image`, which turns a working generic preview into no preview at all.
 */
async function fallback(): Promise<Response> {
  try {
    const file = join(frameworkPath.publicPath(), 'social', 'og.png')

    return new Response(body(await readFile(file)), { headers: headers('"site-card"') })
  }
  catch {
    return new Response('Not found', { status: 404 })
  }
}

/**
 * Bytes, as something `Response` accepts.
 *
 * A `Uint8Array` is a perfectly good body at runtime, but `BodyInit` is
 * declared over `Uint8Array<ArrayBuffer>` and both `renderSocialCard` and
 * `readFile` are declared as plain `Uint8Array`, which is
 * `Uint8Array<ArrayBufferLike>` - the buffer behind it could in principle be
 * shared. Copying through this constructor is what proves to the compiler that
 * it is not, and at 110 KB a card, once per cache miss, the copy does not
 * register. The alternative is a cast, which asserts the same thing without
 * making it true.
 */
function body(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(bytes)
}

function headers(etag: string): Record<string, string> {
  return {
    'Content-Type': 'image/png',
    'X-Content-Type-Options': 'nosniff',
    /*
     * Cacheable by anyone, because everything drawn here is public by
     * construction - a private repository never gets past `cardCopyFor`, so a
     * shared cache holding one of these cannot hand somebody another person's
     * work.
     *
     * An hour, then revalidate. A card goes stale when a title changes, and an
     * hour of a slightly old preview is a fair price for not redrawing on
     * every scrape by every service that saw the link.
     */
    'Cache-Control': 'public, max-age=3600, stale-while-revalidate=86400',
    'ETag': etag,
  }
}

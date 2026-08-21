import { route } from '@stacksjs/router'
import pages from '../config/pages'
import { normalizeHost, pagesEnabled } from '../app/Actions/Pages/host'
import { mayReadSite, pagesResponse, resolvePagesTarget } from '../app/Actions/Pages/serve'

/**
 * Serving published sites.
 *
 * Two doors, because a ReviewOS instance is two processes and the Pages host is
 * neither of them:
 *
 * - **`/_pages/{owner}/{repository}/…`** is the canonical one. It is a path, so
 *   `config/server.ts` can proxy it from the page process to this one, the same
 *   way `/git/` is proxied — and an operator's gateway maps
 *   `*.pages.example.com` onto it with one rewrite.
 * - **the host door** answers any path when the request's `Host` is under
 *   `PAGES_DOMAIN`. It is what a single-process instance and the test suite
 *   drive, and what anybody fronting the API process directly gets.
 *
 * The host door is registered **only when Pages is configured**, and that is
 * deliberate rather than tidy: its pattern is `/*`, which matches everything.
 * An instance that never set `PAGES_DOMAIN` must not have a catch-all in its
 * route table at all — the failure mode of one that does is every 404 in the
 * product going through code that was written for something else.
 *
 * This file is registered last in `app/Routes.ts`, after `git`, for the same
 * reason `git` is registered after everything else: first match wins, and a
 * catch-all that runs before a real route is a route that never runs.
 */

/** Where the owner and repository live when the path carries them. */
const MOUNT = '/_pages/'

async function serve(request: any): Promise<Response> {
  const url = new URL(request.url)
  const host = normalizeHost(request.headers?.get?.('host'))

  /*
   * A mounted request carries the owner and repository in the path; a host
   * request carries them in the subdomain and the first segment. Both are
   * normalised into the pair the resolver takes, so the resolver never has to
   * know which door a request came through.
   */
  const mounted = url.pathname.startsWith(MOUNT)

  if (mounted) {
    const rest = url.pathname.slice(MOUNT.length)
    const slash = rest.indexOf('/')
    const owner = slash === -1 ? rest : rest.slice(0, slash)
    const remainder = slash === -1 ? '' : rest.slice(slash + 1)
    const nextSlash = remainder.indexOf('/')
    const repository = nextSlash === -1 ? remainder : remainder.slice(0, nextSlash)

    if (!owner || !repository)
      return new Response('Not found', { status: 404 })

    // Rebuilt as the host form so one resolver answers both doors. The
    // alternative is two paths through the same permission check, which is one
    // more than a permission check may have.
    const inner = nextSlash === -1 ? '/' : remainder.slice(nextSlash)
    const target = await resolvePagesTarget(`${owner}.${pages.domain}`, `/${repository}${inner}`)

    return await answer(target, request)
  }

  return await answer(await resolvePagesTarget(host, url.pathname), request)
}

async function answer(target: Awaited<ReturnType<typeof resolvePagesTarget>>, request: any): Promise<Response> {
  // `null` means "not a Pages request". Through this route that can only be a
  // request for the forge that reached the catch-all, which is a 404 either
  // way — but the two are still distinguished, because the resolver's callers
  // outside this file need the difference.
  if (target === null || target === 'not-found')
    return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } })

  const userId = Number(request?.user?.id ?? request?.userId ?? 0) || null

  if (!await mayReadSite(target.site, userId)) {
    /*
     * 404, never 403.
     *
     * A private repository's site must not confirm that it exists. "You may not
     * read this" is the same disclosure as the repository listing itself, and
     * the whole point of a `repository`-visibility site is that it is invisible
     * to anybody who cannot already see the repository.
     */
    return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } })
  }

  return await pagesResponse(target)
}

route.get(`${MOUNT}*`, serve)

if (pagesEnabled())
  route.get('/*', serve)

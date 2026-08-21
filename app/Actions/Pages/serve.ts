/**
 * Answering a request for a published site.
 *
 * The read half of Pages: host to site, URL to file, file to response. Nothing
 * here writes, and nothing here builds.
 *
 * ## Access is the repository's access, not a second system
 *
 * A `repository` site is readable by whoever may read the repository, which for
 * a public one is everybody and for a private one is a member with a session.
 * Deciding that here, from the same rows the forge decides it from, is the only
 * way the two can stay in agreement: a Pages ACL of its own would be a second
 * answer to "may this person see this code", and the two would disagree on the
 * day somebody's access is revoked.
 */

import { db } from '@stacksjs/database'
import { join } from 'node:path'
import pages from '../../../config/pages'
import { parsePagesRequest, pagesEnabled } from './host'
import { contentTypeFor, resolveSitePath, siteDirectory, siteForDomain, siteFor } from './site'
import type { PagesSiteRow } from './site'

/** What a Pages request resolved to, before any file is read. */
export interface ResolvedPagesTarget {
  site: PagesSiteRow
  repositoryId: number
  /** The path inside the site, e.g. `guide/index.html`. */
  file: string
}

/**
 * The repository a suffix request names, or null.
 *
 * The owner is a handle, which can be a user or an organization - the same
 * ambiguity every other route in this product resolves, and it is resolved the
 * same way rather than by guessing from the shape of the name.
 */
async function repositoryFor(owner: string, name: string): Promise<number | null> {
  const { findRepositoryByPath } = await import('../Git/access')
  const repository: any = await findRepositoryByPath(owner, name).catch(() => null)

  return repository ? Number(repository.id) : null
}

/**
 * Turn a request into a site and a file path, or null when it is not a Pages
 * request at all.
 *
 * Null and "404" are deliberately different answers. Null means the router
 * should carry on and let the forge answer, which is what has to happen for
 * every request to the instance's own host. A 404 means this *was* a Pages
 * request and there is nothing there.
 */
export async function resolvePagesTarget(host: string, pathname: string): Promise<ResolvedPagesTarget | null | 'not-found'> {
  if (!pagesEnabled())
    return null

  const parsed = parsePagesRequest(host, pathname)
  if (!parsed)
    return null

  const site = parsed.kind === 'domain'
    ? await siteForDomain(parsed.host)
    : await siteOfRepository(parsed.owner!, parsed.repository!)

  if (!site || !site.enabled || !site.live_sha)
    return 'not-found'

  const file = resolveSitePath(parsed.path)
  if (!file)
    return 'not-found'

  return { site, repositoryId: site.repository_id, file }
}

async function siteOfRepository(owner: string, name: string): Promise<PagesSiteRow | null> {
  const repositoryId = await repositoryFor(owner, name)

  return repositoryId ? await siteFor(repositoryId) : null
}

/**
 * Whether this request may read this site.
 *
 * A `public` site is readable by anybody, whatever the repository is - that is
 * what the setting means, and it is the one an owner picks deliberately to
 * publish a private repository's documentation.
 *
 * Otherwise the repository decides. A public repository is readable by
 * everybody; a private one needs a session that may read it.
 */
export async function mayReadSite(site: PagesSiteRow, userId: number | null): Promise<boolean> {
  if (site.visibility === 'public')
    return true

  const repository = await db
    .selectFrom('repositories')
    .select(['id', 'visibility', 'owner_type', 'owner_id', 'is_archived'])
    .where('id', '=', site.repository_id)
    .executeTakeFirst()
    .catch(() => null)

  if (!repository)
    return false

  // The same question `git clone` asks, answered by the same function. A second
  // implementation of "may this person read this repository" is a second answer,
  // and the two would disagree on the day somebody's access is revoked.
  const { mayUseService } = await import('../Git/access')

  return await mayUseService(repository as any, userId, 'upload-pack').catch(() => false)
}

/**
 * The response for a resolved target.
 *
 * A missing file falls back to the site's own `404.html` when it has one, which
 * is what every static site generator writes and what a reader expects to see
 * instead of the forge's own not-found page. The status stays 404 either way -
 * a custom page served with a 200 is how a broken link becomes a page search
 * engines index.
 */
export async function pagesResponse(target: ResolvedPagesTarget): Promise<Response> {
  const root = siteDirectory(target.repositoryId, target.site.live_sha)
  const file = Bun.file(join(root, target.file))

  if (await file.exists()) {
    return new Response(file, {
      headers: {
        'content-type': contentTypeFor(target.file),
        'cache-control': `public, max-age=${pages.maxAge}`,
        // The site is somebody else's markup on its own origin. Nothing about
        // it should be reachable in a frame on the forge, and no browser should
        // second-guess the content type it was given.
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'strict-origin-when-cross-origin',
      },
    })
  }

  const notFound = Bun.file(join(root, '404.html'))

  if (await notFound.exists()) {
    return new Response(notFound, {
      status: 404,
      headers: { 'content-type': 'text/html; charset=utf-8', 'x-content-type-options': 'nosniff' },
    })
  }

  return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } })
}

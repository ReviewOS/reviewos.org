/**
 * Where a published site lives, what it is called, and how a request finds it.
 *
 * The address scheme is the first thing anybody meets and the last thing that
 * can be changed, so it is decided here rather than in whichever route
 * happened to need it first.
 */

import { db } from '@stacksjs/database'
import { join } from 'node:path'

/** The artifact name a run has to publish under. */
export const PAGES_ARTIFACT = 'pages'

/**
 * Everything served, under one directory.
 *
 * Per repository and then per commit, so a publish never overwrites the tree
 * that is currently answering requests: the new commit's directory is written
 * in full, the row is pointed at it, and only then is the old one removed. A
 * visitor mid-request keeps reading files that still exist.
 */
export const PAGES_ROOT = 'storage/pages'

/** The directory one commit's site is extracted into. */
export function siteDirectory(repositoryId: number, sha: string): string {
  return join(PAGES_ROOT, String(repositoryId), sha)
}

export interface PagesSiteRow {
  id: number
  repository_id: number
  enabled: boolean
  source_branch: string
  domain: string | null
  visibility: 'public' | 'repository'
  live_artifact_id: number | null
  live_run_id: number | null
  live_sha: string
  live_at: string | null
  last_error: string
}

const COLUMNS = [
  'id',
  'repository_id',
  'enabled',
  'source_branch',
  'domain',
  'visibility',
  'live_artifact_id',
  'live_run_id',
  'live_sha',
  'live_at',
  'last_error',
] as const

/** The site for a repository, or null when nobody has configured one. */
export async function siteFor(repositoryId: number): Promise<PagesSiteRow | null> {
  const row = await db
    .selectFrom('pages_sites')
    .select(COLUMNS as any)
    .where('repository_id', '=', repositoryId)
    .executeTakeFirst()
    .catch(() => null)

  return (row as PagesSiteRow | undefined) ?? null
}

/**
 * The site a custom domain belongs to.
 *
 * Only an enabled one. A row that was switched off keeps its domain - somebody
 * turning the site off for a week should not have to retype it - and a disabled
 * site answering its domain would make "off" mean nothing.
 */
export async function siteForDomain(domain: string): Promise<PagesSiteRow | null> {
  const normalized = domain.trim().toLowerCase()
  if (!normalized)
    return null

  const row = await db
    .selectFrom('pages_sites')
    .select(COLUMNS as any)
    .where('domain', '=', normalized)
    .where('enabled', '=', true)
    .executeTakeFirst()
    .catch(() => null)

  return (row as PagesSiteRow | undefined) ?? null
}

/**
 * The site's row, created switched off if it did not exist.
 *
 * Creating it off is the same rule the model states: a row appears because
 * somebody named a branch, and naming a branch must not put a repository on the
 * internet.
 */
export async function ensureSite(repositoryId: number): Promise<PagesSiteRow> {
  const existing = await siteFor(repositoryId)
  if (existing)
    return existing

  await db
    .insertInto('pages_sites')
    .values({
      repository_id: repositoryId,
      enabled: false,
      source_branch: '',
      visibility: 'repository',
      live_sha: '',
      last_error: '',
      uuid: crypto.randomUUID(),
      created_at: new Date().toISOString(),
    } as any)
    .execute()
    .catch(() => null)

  const created = await siteFor(repositoryId)
  if (created)
    return created

  // A concurrent insert lost the unique index race and the read that followed
  // still found nothing, which means the table is not there. Return the shape
  // rather than throwing: every caller treats a disabled site as "no site", and
  // a settings page that 500s is worse than one that says Pages is off.
  return {
    id: 0,
    repository_id: repositoryId,
    enabled: false,
    source_branch: '',
    domain: null,
    visibility: 'repository',
    live_artifact_id: null,
    live_run_id: null,
    live_sha: '',
    live_at: null,
    last_error: '',
  }
}

/**
 * The path a request's URL maps to inside a site, or null when it escapes.
 *
 * Two rules, and both are load-bearing:
 *
 * - **A directory gets `index.html`.** `/guide/` and `/guide` both mean
 *   `guide/index.html`, which is what every static site generator writes and
 *   every reader's link assumes.
 * - **Nothing may leave the site.** The URL is somebody else's, so `..`, an
 *   encoded `..`, and a NUL are all refused here rather than by the filesystem,
 *   which would happily read `/etc/passwd` if asked in the right way.
 */
export function resolveSitePath(pathname: string): string | null {
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  }
  catch {
    // A malformed escape is not a path anybody meant to ask for.
    return null
  }

  if (decoded.includes('\0'))
    return null

  const trimmed = decoded.replace(/^\/+/, '')
  const segments = trimmed.split('/').filter(segment => segment !== '' && segment !== '.')

  if (segments.some(segment => segment === '..'))
    return null

  if (segments.length === 0)
    return 'index.html'

  // A trailing slash, or a last segment with no extension, is a directory.
  // Serving `guide` as a file when `guide/index.html` is what exists is the
  // difference between a working docs site and one that 404s on every link.
  const last = segments[segments.length - 1]!
  const looksLikeDirectory = decoded.endsWith('/') || !last.includes('.')

  return looksLikeDirectory ? [...segments, 'index.html'].join('/') : segments.join('/')
}

/**
 * Content type from an extension.
 *
 * A short table rather than a dependency, and an unknown extension is served as
 * `application/octet-stream` rather than sniffed - a guessed type is how a
 * `.php` or a `.txt` full of markup ends up rendered.
 *
 * ## Scripting is expected here, which is why the host matters
 *
 * A published site is somebody's HTML and JavaScript, and SVG is scriptable
 * too. None of that can be stripped without making Pages useless, so the
 * isolation is not the content type - it is the **origin**. Sites are served
 * from a hostname that is not the instance's, so a script on a published site
 * shares no cookie, no session, and no same-origin access with the forge.
 * Serving them from a path under the instance's own host would hand every
 * repository owner a script tag on the page that holds everybody's session.
 */
const CONTENT_TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  map: 'application/json; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  md: 'text/plain; charset=utf-8',
  xml: 'application/xml; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  pdf: 'application/pdf',
  wasm: 'application/wasm',
  webmanifest: 'application/manifest+json',
}

export function contentTypeFor(path: string): string {
  const extension = path.split('.').pop()?.toLowerCase() ?? ''

  return CONTENT_TYPES[extension] ?? 'application/octet-stream'
}

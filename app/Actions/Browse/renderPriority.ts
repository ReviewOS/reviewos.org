/**
 * Which page requests render behind everybody else's.
 *
 * A crawler that ignores robots.txt walked file histories across the large
 * mirrors from many addresses at once, one or two connections each, and every
 * page on the site answered "rendering is busy" because its renders held every
 * slot and every waiting place (#19). It cannot be refused by address, and the
 * pages it wants are ones people use too. So it is ranked instead: a signed-out
 * request for one of the spaces robots.txt already tells crawlers not to walk
 * renders in the background class, which has one slot of its own, waits behind
 * every person, and is told to come back in half a minute rather than at once.
 *
 * The rule is the robots list itself, not a second one. A path is crawlable
 * space here exactly when `config/app.ts` disallows it with a wildcard, which
 * is every per-repository and per-owner space. The plain entries are forms and
 * personal pages (`/login`, `/search`) that a person arriving signed out is
 * there to use, so they keep their place.
 *
 * "Signed out" means no session that validates. A cookie whose name looks
 * like a session is what a crawler sends next once it notices, so a token is
 * looked up like any page gate looks it up, and the answer is kept for a
 * minute so a crawler repeating one forged cookie costs one query a minute.
 */

import app from '../../../config/app'

/** The robots.txt rules that name crawlable space: the ones with a wildcard. */
export const CRAWLER_SPACE_RULES: readonly string[] = ((app as any).seo?.robots?.disallow as string[] ?? [])
  .filter(rule => rule.includes('*'))

/**
 * A robots.txt rule as a regular expression over a path: `*` is any run of
 * characters, slashes included, a trailing `$` anchors the end, and anything
 * else is a prefix. The same reading crawlers give it.
 */
export function robotsRule(rule: string): RegExp {
  const anchored = rule.endsWith('$')
  const body = (anchored ? rule.slice(0, -1) : rule)
    .split('*')
    .map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*')
  return new RegExp(`^${body}${anchored ? '$' : ''}`)
}

const compiled = CRAWLER_SPACE_RULES.map(robotsRule)

/**
 * True for a path in crawlable space, read as it arrives and as it decodes.
 * Both, because `/o/r/%74ree/main` routes to the tree page and a rule read only
 * against the raw path would let anybody step around it with one escape.
 */
export function isCrawlerSpace(pathname: string): boolean {
  let decoded = pathname
  try {
    decoded = decodeURIComponent(pathname)
  }
  catch {}
  return compiled.some(rule => rule.test(pathname) || rule.test(decoded))
}

/** A session token the request carries: a bearer, else the sign-in cookie. */
export function sessionToken(request: Request, cookieName: string): string | null {
  const authorization = request.headers.get('authorization') ?? ''
  const bearer = /^Bearer\s+(\S+)$/i.exec(authorization)?.[1]
  if (bearer)
    return bearer

  for (const part of (request.headers.get('cookie') ?? '').split(';')) {
    const at = part.indexOf('=')
    if (at > 0 && part.slice(0, at).trim() === cookieName) {
      const value = part.slice(at + 1).trim()
      try {
        return decodeURIComponent(value) || null
      }
      catch {
        return value || null
      }
    }
  }
  return null
}

const SESSION_CACHE_MS = 60_000
const SESSION_CACHE_LIMIT = 10_000
const sessions = new Map<string, { valid: boolean, until: number }>()

/** Forget every remembered answer. For tests. */
export function forgetSessions(): void {
  sessions.clear()
}

export interface RenderPriorityOptions {
  /** Whether a token is a live session. Defaults to the page gate's own lookup. */
  validate?: (token: string) => Promise<unknown>
  cookieName?: string
  now?: () => number
}

async function defaultValidate(token: string): Promise<unknown> {
  const { Auth } = await import('@stacksjs/auth')
  return await Auth.getUserFromToken(token)
}

async function defaultCookieName(): Promise<string> {
  const { authCookieName } = await import('@stacksjs/auth')
  return authCookieName()
}

async function isSignedIn(token: string, options: RenderPriorityOptions): Promise<boolean> {
  const now = options.now?.() ?? Date.now()
  // Keyed by a digest rather than the token, so this map is not a list of
  // working credentials sitting in the page process.
  const key = new Bun.CryptoHasher('sha256').update(token).digest('hex')
  const known = sessions.get(key)
  if (known && known.until > now)
    return known.valid

  let valid = false
  try {
    valid = Boolean(await (options.validate ?? defaultValidate)(token))
  }
  catch {
    // A token that makes the lookup throw is not a session. The page itself
    // decides what to show; this only decides where the request waits.
    valid = false
  }

  sessions.delete(key)
  sessions.set(key, { valid, until: now + SESSION_CACHE_MS })
  if (sessions.size > SESSION_CACHE_LIMIT)
    sessions.delete(sessions.keys().next().value!)
  return valid
}

/**
 * Whether this page request renders in the background class.
 *
 * Everything outside crawlable space answers false before anything else is
 * read, so the cost for every other page is one walk over a dozen patterns.
 */
export async function rendersInBackground(request: Request, options: RenderPriorityOptions = {}): Promise<boolean> {
  if (!isCrawlerSpace(new URL(request.url).pathname))
    return false

  const token = sessionToken(request, options.cookieName ?? await defaultCookieName())
  if (!token)
    return true

  return !(await isSignedIn(token, options))
}

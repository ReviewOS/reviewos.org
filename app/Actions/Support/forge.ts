import { response } from '@stacksjs/router'
import { safeRedirect, wantsHtml } from '../Auth/session'

export class ForgeError extends Error {
  constructor(message: string, public status: 400 | 401 | 403 | 404 | 409 | 413 | 422 | 500 | 502 | 503 = 422) {
    super(message)
  }
}

export function positiveId(value: unknown): number {
  const id = Number(value)
  if (!Number.isSafeInteger(id) || id < 1)
    throw new ForgeError('Expected a positive whole number')
  return id
}

export function pageOffset(value: unknown): number {
  const offset = Number(value ?? 0)
  return Number.isSafeInteger(offset) && offset >= 0 ? offset : 0
}

export function titleField(value: unknown, label = 'Title'): string {
  const title = String(value ?? '').trim()
  if (!title || title.length > 160)
    throw new ForgeError(`${label} must be between 1 and 160 characters`)
  return title
}

export function forgeResult(request: RequestInstance, data: unknown, location: string, status: 200 | 201 = 200): Response {
  return wantsHtml(request)
    ? response.redirect(safeRedirect(location), 303)
    : response.json(data, status)
}

/**
 * The page a form was submitted from, as a path on this host.
 *
 * Read from `Referer` rather than named per endpoint, because a refusal wants
 * to land the person back where they were typing and only the browser knows
 * where that was - several of these endpoints are posted to from more than one
 * page. Through `safeRedirect`, so a header somebody else set cannot turn a
 * refusal into an open redirect: `//evil.example` is a path to a naive check
 * and an absolute URL to a browser.
 */
function formPage(request: RequestInstance, fallback: string): string {
  const referer = String((request as any)?.header?.('referer') ?? (request as any)?.headers?.get?.('referer') ?? '')
  if (!referer)
    return fallback

  try {
    // Resolved against a sentinel so a relative `Referer` parses. A header
    // naming any other host is discarded rather than having its path reused:
    // `https://evil.example/steal` is not an open redirect once only the path
    // survives, but sending somebody to `/steal` because a foreign page said
    // so is still somebody else choosing where this application goes.
    const base = 'http://referer.invalid'
    const url = new URL(referer, base)
    const here = (() => {
      try {
        return new URL(String((request as any)?.url ?? '')).host
      }
      catch {
        return ''
      }
    })()

    if (url.origin !== base && here && url.host !== here)
      return fallback

    return safeRedirect(`${url.pathname}${url.search}`, fallback)
  }
  catch {
    return fallback
  }
}

/**
 * A success, in the shape the caller asked for.
 *
 * The other half of {@link refuse}, and the half missed first time round.
 * Revoking a token from the settings page worked perfectly and left the
 * browser looking at
 * `{"id":107,"revoked_at":"2026-11-16T11:33:52.401Z","already_revoked":false}`
 * - a working feature that reads as a broken one, and worse than a refusal
 * doing it, because nothing tells the person it went through at all.
 *
 * A program gets the body it always got; a browser goes back to the page it
 * posted from with a sentence saying what happened, which the layout renders.
 * `location` is for the cases where "back" is the wrong place - a repository
 * that was just deleted, a page that was just renamed - and defaults to the
 * referring page.
 *
 * The message is written per call site on purpose. "Done" tells somebody
 * nothing; "Token revoked" tells them which of the three controls on that page
 * just fired, which is the whole reason for sending them back rather than
 * leaving them on JSON.
 */
export function succeed(
  request: RequestInstance,
  body: unknown,
  message: string,
  options: { location?: string, status?: 200 | 201 } = {},
): Response {
  if (!wantsHtml(request))
    return response.json(body, options.status ?? 200)

  const target = options.location ?? formPage(request, '/')
  const [path = '/', query = ''] = target.split('?')
  const params = new URLSearchParams(query)

  // An empty message means "nothing to announce": a read reached through a
  // POST - listing a repository's secrets, say - still belongs back on its
  // page rather than on JSON, but "Secrets listed" is noise.
  if (message)
    params.set('form_notice', message)

  const query2 = params.toString()

  return response.redirect(query2 ? `${path}?${query2}` : path, 303)
}

/**
 * A refusal, in the shape the caller asked for.
 *
 * **A browser form submit must never land on a page of JSON.** These endpoints
 * are posted to by ordinary HTML forms - the pages run no client-side
 * JavaScript, so nothing catches the response - and a refusal therefore
 * replaced the page the person was working on with
 * `{"error":"..."}`, leaving the back button as the way out and their input
 * gone. On a form with eight fields that is the difference between a
 * validation message and starting again.
 *
 * So: a program gets the JSON body it has always got, byte for byte, and a
 * browser gets sent back to the page it posted from with the reason in
 * `form_error`, which the application layout renders. One helper rather than a
 * copy per action, because there are around fifty of these call sites and a
 * split implemented fifty times is a split that is wrong in a few of them.
 *
 * `form_error` rather than `error` because login, register, forgotten password
 * and profile already read `error` from the query and render it themselves, in
 * a deliberate spot inside their own form, which is the better place on a page
 * whose only content is that form. Sharing the key would show them the same
 * message twice. Those stay as they are; everything else is covered by the
 * layout.
 */
export function refuse(
  request: RequestInstance,
  message: unknown,
  status = 422,
  options: { fallback?: string, body?: Record<string, unknown> } = {},
): Response {
  const reason = String(message ?? '').trim() || 'That did not work'

  // `body` carries the fields a handful of these refusals return beside the
  // message - `retry_in_seconds`, the repositories still owned, which inline
  // comments were rejected. A program gets them exactly as before; a browser
  // gets the sentence, because the page has nowhere to put the rest.
  if (!wantsHtml(request))
    // The status arrives as a number - callers pass `auth.status` and the like -
    // while `response.json` is typed to the literal union it accepts.
    return response.json({ error: reason, ...options.body }, status as Parameters<typeof response.json>[1])

  const target = formPage(request, options.fallback ?? '/')

  // A session that lapsed while the form was open is the ordinary way to get a
  // 401 here, and the useful answer is the login page carrying where to return
  // to - not the form again, which would only show its signed-out half.
  if (status === 401)
    return response.redirect(`/login?next=${encodeURIComponent(target)}`, 303)

  const [path = '/', query = ''] = target.split('?')
  const params = new URLSearchParams(query)
  params.set('form_error', reason)

  return response.redirect(`${path}?${params.toString()}`, 303)
}

/**
 * Only domain refusals are translated here. Operational failures reach the
 * router.
 *
 * Takes the request so a `ForgeError` can answer a browser with the form it
 * came from rather than with JSON - see `refuse`. Every wiki, project and
 * registry form goes through here, so without the request they were the one
 * group of forms that could not be fixed one at a time.
 */
export async function forgeResponse(request: RequestInstance, work: () => Promise<Response>): Promise<Response> {
  try {
    return await work()
  }
  catch (error) {
    if (error instanceof ForgeError)
      return refuse(request, error.message, error.status)
    throw error
  }
}

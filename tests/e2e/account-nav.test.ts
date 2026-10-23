// The way out of the product, which there was not one of.
//
// `POST /api/auth/logout` has worked from the beginning and is well covered in
// `auth.test.ts`: it clears the cookie, revokes the token rather than merely
// forgetting it, and answers 200 when nobody was signed in. `review logout`
// calls it from the CLI. What never existed was a control: no page in the web
// product offered a signed-in reader any way to press it, so signing out meant
// clearing cookies by hand, and `forgot-password.stx` told them to "sign out
// first" with nothing anywhere to do it with.
//
// That is the same failure `AccountNav.stx` was written to fix one step out -
// its own comment describes a page that exists and nothing links to - so the
// control belongs there and so does a test that it stays.
//
// Two claims, and the page only proves the first:
//
//  1. The control renders for a reader who is signed in, and not for one who
//     is not. Asked of the page through the real routes rather than of the
//     component, because the nav renders inside the shared layout and an stx
//     server script that throws renders its page with every variable undefined
//     and says nothing. A component test would pass on a page that is blank.
//  2. Submitting it signs you out *in a browser*. The existing tests cover the
//     JSON branch; the control is a plain `<form method="post">` with no
//     script, so what it depends on is the HTML branch - a 303 back to `/`
//     carrying the cleared cookie - and nothing covered that at all.
//
// Like the rest of tests/e2e it needs a database and skips itself loudly when
// there is none. It needs no git: the nav reads rows.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

const created = { userId: 0, handle: '', token: '' }

let available = false
let port = 0
let server: any = null

function unique(prefix: string): string {
  return `${prefix}${Buffer.from(crypto.getRandomValues(new Uint8Array(5))).toString('hex')}`
}

async function fetchPage(path: string, cookieToken?: string): Promise<{ html: string, csrf: string }> {
  const answer = await fetch(`http://127.0.0.1:${port}${path}`, {
    headers: {
      Accept: 'text/html',
      ...(cookieToken ? { Cookie: `auth-token=${cookieToken}` } : {}),
    },
  })

  /*
   * The CSRF cookie the router seeds on every safe-method response, which is
   * how a browser comes to hold one before it submits anything.
   */
  const seeded = String(answer.headers.get('set-cookie') ?? '').match(/X-CSRF-Token=([^;,\s]+)/i)

  return { html: await answer.text(), csrf: seeded ? decodeURIComponent(seeded[1]!) : '' }
}

/** The `_token` a form carries in its body, as rendered into the page. */
function tokenField(html: string): string | null {
  const field = html.match(/<input[^>]*name\s*=\s*["']_token["'][^>]*>/i)
  if (!field)
    return null

  const value = field[0].match(/value\s*=\s*["']([^"']*)["']/i)

  return value ? value[1]! : ''
}

/**
 * The sign-out form, found by its action rather than by its label.
 *
 * A label can be reworded and the control still works; an action that stops
 * naming the endpoint is the failure this is guarding against. The method is
 * part of the match because the endpoint is POST only, deliberately: a
 * `<img src="/logout">` in a comment would sign out every reader of the page
 * it appears on if a GET did the job.
 */
function signOutForm(html: string): string | null {
  for (const form of html.match(/<form\b[^>]*>/gi) ?? []) {
    if (/action\s*=\s*["']\/api\/auth\/logout["']/i.test(form) && /method\s*=\s*["']post["']/i.test(form))
      return form
  }

  return null
}

beforeAll(async () => {
  try {
    const { injectGlobalAutoImports } = await import('@stacksjs/server')
    const { route } = await import('@stacksjs/router')

    await injectGlobalAutoImports()
    await (globalThis as any).db.selectFrom('users').select(['id']).limit(1).execute()

    await route.importRoutes()
    server = await route.serve({ port: 0, hostname: '127.0.0.1' })
    port = Number((server as any)?.port ?? (server as any)?.server?.port ?? 0)

    if (!port)
      throw new Error('the router did not report a port')

    const db = (globalThis as any).db
    const { createToken } = await import('@stacksjs/auth')

    created.handle = unique('nav')
    const row: any = await db
      .insertInto('users')
      .values({ name: 'Nav Tester', email: `${created.handle}@example.com`, handle: created.handle, password: 'x' })
      .returning(['id'])
      .executeTakeFirst()

    created.userId = Number(row?.id)

    const issued: any = await createToken(created.userId, 'account nav sign out test')
    created.token = String(issued?.plainTextToken ?? issued?.token ?? issued)

    available = Boolean(created.userId && created.token)
  }
  catch (error) {
    console.warn(`[e2e] skipping: ${error instanceof Error ? error.message : String(error)}`)
    available = false
  }
}, 120_000)

afterAll(async () => {
  const db = (globalThis as any).db

  try {
    if (created.userId)
      await db.deleteFrom('users').where('id', '=', created.userId).execute()
  }
  catch { /* nothing else to release */ }

  try {
    server?.stop?.(true)
  }
  catch { /* already down */ }
})

describe('the way out of the product', () => {
  test('a signed-in reader is offered one', async () => {
    if (!available)
      return

    const { html } = await fetchPage('/explore', created.token)

    // The reader is actually signed in on this page. Without this the test
    // would pass against a page that rendered the signed-out bar, where no
    // sign-out control is expected either.
    expect(html).toContain(created.handle)

    expect(signOutForm(html)).not.toBeNull()

    // Named for somebody who cannot see the icon. The control is an icon
    // button, so without this the accessible name is the empty string.
    expect(html).toMatch(/aria-label\s*=\s*["']Sign out["']/i)

    /*
     * And it carries a CSRF token that is not the empty string.
     *
     * Present-but-blank is the failure `CsrfField.stx` documents: the field
     * renders, the post is refused, and the button appears to do nothing. An
     * assertion that the field exists would pass through exactly that.
     */
    expect(tokenField(html)).toBeTruthy()
  })

  test('and a signed-out visitor is offered a way in instead', async () => {
    if (!available)
      return

    const { html } = await fetchPage('/explore')

    // Nothing to sign out of, so no control: it would post an empty logout
    // and bounce them to the home page for no reason.
    expect(signOutForm(html)).toBeNull()
    expect(html).toContain('/login?next=')
  })
})

describe('what the control depends on', () => {
  test('a form post lands back on the site, signed out, with no script involved', async () => {
    if (!available)
      return

    /*
     * The branch the existing tests never touched.
     *
     * `auth.test.ts` posts as an API client and asserts 200 with a cleared
     * cookie, which is right for a program. A browser submitting a form sends
     * `Accept: text/html`, and for it a 200 carrying `{"ok":true}` would paint
     * the JSON over the product. The action answers 303 to `/` instead, which
     * is the only reason the control needs no JavaScript.
     */
    /*
     * Submitted the way the browser will submit it: the token in the body as
     * `_token`, the matching cookie alongside, and a form content type. No
     * `x-csrf-token` header, because a plain form cannot set one - that header
     * is the single-page-app path the middleware was written for and is not
     * available here.
     */
    const page = await fetchPage('/explore', created.token)
    const body = new URLSearchParams({ _token: tokenField(page.html) ?? '' })

    const answer = await fetch(`http://127.0.0.1:${port}/api/auth/logout`, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'Accept': 'text/html,application/xhtml+xml',
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cookie': `auth-token=${created.token}; X-CSRF-Token=${page.csrf}`,
      },
      body,
    })

    expect(answer.status).toBe(303)
    expect(answer.headers.get('location')).toBe('/')

    // The cookie goes in the same response as the redirect. Clearing it on a
    // later request would leave the reader signed in on the page they land on.
    expect(answer.headers.get('set-cookie')).toContain('Max-Age=0')

    // And the token itself is dead, not just the browser's copy of it.
    const { viewerFromCookies } = await import('../../app/Actions/Identity/lookup')
    expect(await viewerFromCookies({ 'auth-token': created.token })).toBeNull()
  })
})

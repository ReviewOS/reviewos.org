// A browser form submit must never land on a page of JSON.
//
// Every form in the product posts straight to its API endpoint - the pages run
// no client-side JavaScript, so nothing catches the response - which meant a
// refusal replaced the page the person was working on with `{"error":"..."}`,
// their input gone and the back button the only way out. On a form with eight
// fields that is the difference between a validation message and starting
// again. It is what glenn saw on "Issue a token", and the reason this helper
// exists rather than a `wantsHtml` branch copied into fifty actions.
//
// `refuse` is the one place that decides the split, so these are the tests that
// say what the split is. The property that matters most is the second one: an
// API client's answer has to be byte-for-byte what it always was, because the
// whole change is supposed to be invisible to everything that is not a browser.

import { describe, expect, test } from 'bun:test'
import { refuse, succeed } from '../../app/Actions/Support/forge'

/** A request as the router hands one to an action, with the headers that decide this. */
function asRequest(headers: Record<string, string>, url = 'http://reviewos.test/api/user/keys'): any {
  const bag = new Headers(headers)

  return { url, headers: bag, header: (name: string) => bag.get(name) }
}

const browser = (referer?: string) => asRequest({
  'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  ...(referer ? { referer } : {}),
})

const client = () => asRequest({ accept: 'application/json' })

describe('a refusal takes the shape the caller asked for', () => {
  test('a browser is sent back to the form it posted from, carrying the reason', () => {
    const answer = refuse(browser('http://reviewos.test/settings/keys'), 'That key is not usable', 422)

    expect(answer.status).toBe(303)
    expect(answer.headers.get('location')).toBe('/settings/keys?form_error=That+key+is+not+usable')
  })

  test('a program gets the JSON body, unchanged', async () => {
    const answer = refuse(client(), 'That key is not usable', 422)

    expect(answer.status).toBe(422)
    expect(await answer.json()).toEqual({ error: 'That key is not usable' })
  })

  test('the fields a refusal carries beside the message survive for a program', async () => {
    const answer = refuse(client(), 'Already a member', 409, { body: { role: 'admin' } })

    expect(answer.status).toBe(409)
    expect(await answer.json()).toEqual({ error: 'Already a member', role: 'admin' })
  })

  test('and are dropped for a browser, which has nowhere to put them', () => {
    const answer = refuse(browser('http://reviewos.test/people'), 'Already a member', 409, { body: { role: 'admin' } })

    expect(answer.headers.get('location')).toBe('/people?form_error=Already+a+member')
  })

  test('a query the page was already carrying is kept', () => {
    const answer = refuse(browser('http://reviewos.test/issues?state=open&label=bug'), 'A label needs a name')

    const location = new URL(String(answer.headers.get('location')), 'http://reviewos.test')
    expect(location.pathname).toBe('/issues')
    expect(location.searchParams.get('state')).toBe('open')
    expect(location.searchParams.get('label')).toBe('bug')
    expect(location.searchParams.get('form_error')).toBe('A label needs a name')
  })
})

describe('where a refusal is allowed to send somebody', () => {
  // `Referer` is a header anybody can set. It decides a redirect here, so the
  // rule is "a path on this host, or nowhere".
  test('a Referer naming another host is ignored rather than having its path reused', () => {
    const answer = refuse(browser('https://evil.example/steal'), 'No')

    expect(answer.headers.get('location')).toBe('/?form_error=No')
  })

  test('a protocol-relative Referer cannot smuggle a host past the path check', () => {
    const answer = refuse(browser('//evil.example/steal'), 'No')

    expect(answer.headers.get('location')).toBe('/?form_error=No')
  })

  test('no Referer at all falls back, and the caller may say to where', () => {
    expect(refuse(browser(), 'No').headers.get('location')).toBe('/?form_error=No')
    expect(refuse(browser(), 'No', 422, { fallback: '/settings' }).headers.get('location'))
      .toBe('/settings?form_error=No')
  })
})

describe('a lapsed session', () => {
  // The ordinary way to get a 401 on a form is a session that expired while the
  // page was open. Showing the form again would only show its signed-out half.
  test('sends a browser to the login form, carrying where to come back to', () => {
    const answer = refuse(browser('http://reviewos.test/settings/keys'), 'Unauthenticated', 401)

    expect(answer.status).toBe(303)
    expect(answer.headers.get('location')).toBe(`/login?next=${encodeURIComponent('/settings/keys')}`)
  })

  test('and still answers a program with 401', async () => {
    const answer = refuse(client(), 'Unauthenticated', 401)

    expect(answer.status).toBe(401)
    expect(await answer.json()).toEqual({ error: 'Unauthenticated' })
  })
})

describe('the message itself', () => {
  test('an empty reason still says something', () => {
    expect(refuse(browser(), '').headers.get('location')).toBe('/?form_error=That+did+not+work')
  })

  test('a reason is escaped into the query rather than concatenated into it', () => {
    const answer = refuse(browser('http://reviewos.test/settings'), 'A & B = C?')

    const location = new URL(String(answer.headers.get('location')), 'http://reviewos.test')
    expect(location.searchParams.get('form_error')).toBe('A & B = C?')
  })
})

describe('a success takes the shape the caller asked for too', () => {
  // The half that was missed first time round. Revoking a token worked and
  // left the browser on `{"id":107,"revoked_at":"...","already_revoked":false}`
  // - a working feature that reads as a broken one, and worse than a refusal
  // doing it, because nothing says it went through.
  test('a browser goes back to its page with a sentence saying what happened', () => {
    const answer = succeed(browser('http://reviewos.test/settings/tokens'), { id: 107 }, 'Token revoked')

    expect(answer.status).toBe(303)
    expect(answer.headers.get('location')).toBe('/settings/tokens?form_notice=Token+revoked')
  })

  test('a program gets the body, unchanged', async () => {
    const answer = succeed(client(), { id: 107, revoked_at: 'now', already_revoked: false }, 'Token revoked')

    expect(answer.status).toBe(200)
    expect(await answer.json()).toEqual({ id: 107, revoked_at: 'now', already_revoked: false })
  })

  test('a created thing keeps its 201 for a program', async () => {
    const answer = succeed(client(), { id: 9 }, 'Label created', { status: 201 })

    expect(answer.status).toBe(201)
  })

  test('an empty message sends the browser back with nothing to announce', () => {
    // A read reached through a POST - listing a repository's secrets - belongs
    // back on its page rather than on JSON, but "Secrets listed" is noise.
    const answer = succeed(browser('http://reviewos.test/acme/api/settings/secrets'), { secrets: [] }, '')

    expect(answer.headers.get('location')).toBe('/acme/api/settings/secrets')
  })

  test('somewhere else, when back is the wrong place', () => {
    // A repository that was just deleted has no page to return to.
    const answer = succeed(browser('http://reviewos.test/acme/api/settings'), { deleted: 'acme/api' }, 'Repository deleted', { location: '/acme' })

    expect(answer.headers.get('location')).toBe('/acme?form_notice=Repository+deleted')
  })
})

/**
 * The store that keeps a reviewer's progress in two places at once.
 *
 * The interesting cases are all about disagreement. Local storage and the
 * server will not always say the same thing - somebody unticked a file on
 * another machine, a session expired between the page rendering and the request
 * going out, the network dropped halfway through a review - and every one of
 * those has a wrong answer that looks like the feature working.
 *
 * The wrong answers this file exists to prevent:
 *
 *   - a union of the two sets, so an untick on one machine is undone by the
 *     other machine's stale cache and a file the reader deliberately reopened
 *     is folded away again;
 *   - taking a signed-out answer as authoritative, so a lapsed session wipes
 *     progress that is sitting right there in local storage;
 *   - a failed request costing the reader the tick they just made, when the
 *     local copy is exactly as good as it was before the server was involved.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { readDraft, readViewed, writeDraft, writeViewed } from '../../resources/functions/filelist'
import { createReviewStore, draftFromServer, viewedFromServer } from '../../resources/functions/reviewstate'

const SCOPE = '/api/repos/pulls/diff/manifest?owner=a&repo=b&number=1'

const ENDPOINTS = {
  state: '/api/repos/pulls/review-state?owner=a&repo=b&number=1',
  viewed: '/api/repos/pulls/review-state/viewed?owner=a&repo=b&number=1',
  draft: '/api/repos/pulls/review-state/draft?owner=a&repo=b&number=1',
}

const storage = new Map<string, string>()

/** Every request the store made, so the tests can assert on what it sent. */
interface Sent {
  url: string
  method: string
  body: Record<string, string>
  headers: Record<string, string>
}

let sent: Sent[] = []

/**
 * A stand-in for the network.
 *
 * `answer` is what the state endpoint replies with; `fail` makes every request
 * reject, which is the offline case and has to cost the reader nothing.
 */
function sender(options: { answer?: unknown, fail?: boolean, status?: number } = {}): any {
  return async (url: string, init?: any) => {
    const body: Record<string, string> = {}
    if (init?.body instanceof URLSearchParams) {
      for (const [key, value] of init.body as URLSearchParams)
        body[key] = value
    }

    sent.push({ url, method: init?.method ?? 'GET', body, headers: init?.headers ?? {} })

    if (options.fail)
      throw new Error('offline')

    return {
      ok: (options.status ?? 200) < 400,
      status: options.status ?? 200,
      json: async () => options.answer ?? {},
    }
  }
}

beforeEach(() => {
  sent = []
  storage.clear()
  ;(globalThis as { document?: unknown }).document = { cookie: '' }
  ;(globalThis as { window?: unknown }).window = {
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => { storage.set(key, value) },
      removeItem: (key: string) => { storage.delete(key) },
      clear: () => storage.clear(),
      key: () => null,
      length: 0,
    },
  }
})

afterEach(() => {
  delete (globalThis as { window?: unknown }).window
  delete (globalThis as { document?: unknown }).document
})

/**
 * The failure that only happens to the people the feature is for.
 *
 * The router checks a double-submit CSRF token on every non-safe method. A form
 * carries it in a `_token` field, which `CsrfField.stx` puts there; a `fetch`
 * carries nothing unless it is told to. So a write from a script is answered
 * `403 CSRF token mismatch` before it reaches the action - but only for a
 * reader with a session, because a browser with no cookie has nothing to
 * mismatch. Signed out it passes. Signed in, which is everybody whose progress
 * this stores, it fails.
 */
describe('the CSRF token', () => {
  test('rides along on every write, read from the cookie the router seeded', async () => {
    ;(globalThis as any).document.cookie = 'other=1; X-CSRF-Token=abc123; more=2'

    const store = createReviewStore({ scope: SCOPE, endpoints: ENDPOINTS, send: sender() })
    store.setViewed('a.ts', true)
    await Promise.resolve()

    expect(sent[0]?.headers['x-csrf-token']).toBe('abc123')
    expect(sent[0]?.headers['Content-Type']).toBe('application/x-www-form-urlencoded')
  })

  test('a page with no token still sends the request, and is told no by the server', async () => {
    const store = createReviewStore({ scope: SCOPE, endpoints: ENDPOINTS, send: sender() })
    store.setViewed('a.ts', true)
    await Promise.resolve()

    expect(sent[0]?.headers['x-csrf-token']).toBeUndefined()
    expect(sent).toHaveLength(1)
  })

  test('the read is a safe method and carries none', async () => {
    ;(globalThis as any).document.cookie = 'X-CSRF-Token=abc123'

    const store = createReviewStore({ scope: SCOPE, endpoints: ENDPOINTS, send: sender({ answer: {} }) })
    await store.load()

    expect(sent[0]?.headers['x-csrf-token']).toBeUndefined()
  })
})

describe('reading a server answer', () => {
  test('takes the paths out of the records', () => {
    expect(viewedFromServer([{ path: 'a.ts', head_sha: 'abc' }, { path: 'b.ts' }])).toEqual(['a.ts', 'b.ts'])
  })

  test('ignores anything that is not a path, rather than storing it', () => {
    expect(viewedFromServer([{ path: 'a.ts' }, { head_sha: 'abc' }, 42, null, ''])).toEqual(['a.ts'])
  })

  test('an answer that is not a list is no files, not a crash', () => {
    expect(viewedFromServer(null)).toEqual([])
    expect(viewedFromServer({ path: 'a.ts' })).toEqual([])
  })

  /**
   * Checked field by field for the same reason the local storage reader checks
   * them: a draft restored onto the wrong line is a comment about code it is
   * not about, and this one crossed a network and a database on the way.
   */
  test('a draft missing any part of its anchor is not a draft', () => {
    const whole = { path: 'a.ts', side: 'right', from: 3, to: 3, text: 'hello' }

    expect(draftFromServer(whole)).toEqual({ path: 'a.ts', side: 'right', from: 3, to: 3, text: 'hello' })
    expect(draftFromServer({ ...whole, path: undefined })).toBeNull()
    expect(draftFromServer({ ...whole, side: 'middle' })).toBeNull()
    expect(draftFromServer({ ...whole, from: 'three' })).toBeNull()
    expect(draftFromServer({ ...whole, to: null })).toBeNull()
    expect(draftFromServer({ ...whole, text: '   ' })).toBeNull()
    expect(draftFromServer(null)).toBeNull()
  })
})

describe('the store, with no endpoints', () => {
  test('is local storage and nothing else', async () => {
    const store = createReviewStore({ scope: SCOPE, send: sender() })

    store.setViewed('a.ts', true)
    store.setDraft({ path: 'a.ts', side: 'right', from: 1, to: 1, text: 'words' })
    await store.load()

    expect([...store.viewed]).toEqual(['a.ts'])
    expect([...readViewed(SCOPE)]).toEqual(['a.ts'])
    expect(readDraft(SCOPE)?.text).toBe('words')
    // Nothing was sent, because there was nowhere to send it.
    expect(sent).toEqual([])
  })
})

describe('the store, writing', () => {
  test('writes locally before it tells the server, so a reload beats the request', () => {
    const store = createReviewStore({ scope: SCOPE, endpoints: ENDPOINTS, send: sender() })

    store.setViewed('a.ts', true)

    // Already durable on this machine, with the request still in flight.
    expect([...readViewed(SCOPE)]).toEqual(['a.ts'])
  })

  test('sends the tick and the untick as the same endpoint with a different answer', async () => {
    const store = createReviewStore({ scope: SCOPE, endpoints: ENDPOINTS, send: sender() })

    store.setViewed('a.ts', true)
    store.setViewed('a.ts', false)
    await Promise.resolve()

    expect(sent.map(one => [one.method, one.body.path, one.body.viewed]))
      .toEqual([['PUT', 'a.ts', 'true'], ['PUT', 'a.ts', 'false']])
    expect([...store.viewed]).toEqual([])
  })

  test('sends the anchor with the draft, not just the words', async () => {
    const store = createReviewStore({ scope: SCOPE, endpoints: ENDPOINTS, send: sender() })

    store.setDraft({ path: 'src/a.ts', side: 'left', from: 4, to: 7, text: 'hello' })
    await Promise.resolve()

    expect(sent[0]?.body).toEqual({
      path: 'src/a.ts',
      side: 'left',
      from_line: '4',
      to_line: '7',
      body: 'hello',
    })
  })

  test('an empty draft is a discard, locally and on the server', async () => {
    const store = createReviewStore({ scope: SCOPE, endpoints: ENDPOINTS, send: sender() })

    store.setDraft({ path: 'a.ts', side: 'right', from: 1, to: 1, text: 'words' })
    store.setDraft({ path: 'a.ts', side: 'right', from: 1, to: 1, text: '   ' })
    await Promise.resolve()

    expect(store.draft()).toBeNull()
    expect(readDraft(SCOPE)).toBeNull()
    // An empty body, not whitespace. Whether a draft of three spaces counts as
    // a draft is decided here, once, rather than again on the server.
    expect(sent[1]?.body.body).toBe('')
  })

  /**
   * The whole point of writing locally first. A reviewer on a train keeps every
   * tick they make; they lose nothing they had before this endpoint existed.
   */
  test('a request that never arrives costs the reader nothing', async () => {
    const store = createReviewStore({ scope: SCOPE, endpoints: ENDPOINTS, send: sender({ fail: true }) })

    store.setViewed('a.ts', true)
    await Promise.resolve()

    expect([...store.viewed]).toEqual(['a.ts'])
    expect([...readViewed(SCOPE)]).toEqual(['a.ts'])
  })
})

describe('the store, loading', () => {
  test('the server replaces what this machine had, rather than joining it', async () => {
    writeViewed(SCOPE, new Set(['stale.ts', 'both.ts']))

    const store = createReviewStore({
      scope: SCOPE,
      endpoints: ENDPOINTS,
      send: sender({ answer: { signed_in: true, viewed: [{ path: 'both.ts' }, { path: 'fresh.ts' }], draft: null } }),
    })

    await store.load()

    // `stale.ts` was unticked on another machine. A union would put it back,
    // and the reader would find a file they deliberately reopened folded away.
    expect([...store.viewed].sort()).toEqual(['both.ts', 'fresh.ts'])
    expect([...readViewed(SCOPE)].sort()).toEqual(['both.ts', 'fresh.ts'])
  })

  test('the set the file list is painting from is the one that changed', async () => {
    const store = createReviewStore({
      scope: SCOPE,
      endpoints: ENDPOINTS,
      send: sender({ answer: { signed_in: true, viewed: [{ path: 'a.ts' }], draft: null } }),
    })

    // What `createFileList` holds: one reference, taken before the load.
    const held = store.viewed
    await store.load()

    expect([...held]).toEqual(['a.ts'])
  })

  test('announces only what actually changed', async () => {
    writeViewed(SCOPE, new Set(['a.ts']))

    const store = createReviewStore({
      scope: SCOPE,
      endpoints: ENDPOINTS,
      send: sender({ answer: { signed_in: true, viewed: [{ path: 'a.ts' }], draft: null } }),
    })

    const announced: string[] = []
    store.subscribe(what => announced.push(what))
    await store.load()

    // The server agreed. Repainting the list and folding files for an answer
    // identical to the one already on screen is work nobody asked for.
    expect(announced).toEqual([])
  })

  test('announces the draft that arrived from elsewhere', async () => {
    const store = createReviewStore({
      scope: SCOPE,
      endpoints: ENDPOINTS,
      send: sender({
        answer: {
          signed_in: true,
          viewed: [],
          draft: { path: 'a.ts', side: 'right', from: 2, to: 2, text: 'from the laptop' },
        },
      }),
    })

    const announced: string[] = []
    store.subscribe(what => announced.push(what))
    await store.load()

    expect(announced).toEqual(['draft'])
    expect(store.draft()?.text).toBe('from the laptop')
    expect(readDraft(SCOPE)?.text).toBe('from the laptop')
  })

  /**
   * The case that would be silently destructive. A session that lapsed between
   * the page rendering and this request going out answers `signed_in: false`,
   * and treating that empty answer as the truth would wipe a review in
   * progress that is sitting in local storage.
   */
  test('a signed-out answer leaves the local copy alone', async () => {
    writeViewed(SCOPE, new Set(['a.ts', 'b.ts']))
    writeDraft(SCOPE, { path: 'a.ts', side: 'right', from: 1, to: 1, text: 'mine' })

    const store = createReviewStore({
      scope: SCOPE,
      endpoints: ENDPOINTS,
      send: sender({ answer: { signed_in: false, viewed: [], draft: null } }),
    })

    await store.load()

    expect([...store.viewed].sort()).toEqual(['a.ts', 'b.ts'])
    expect(store.draft()?.text).toBe('mine')
  })

  test('a failed or refused read leaves the local copy alone', async () => {
    writeViewed(SCOPE, new Set(['a.ts']))

    const offline = createReviewStore({ scope: SCOPE, endpoints: ENDPOINTS, send: sender({ fail: true }) })
    await offline.load()
    expect([...offline.viewed]).toEqual(['a.ts'])

    const refused = createReviewStore({ scope: SCOPE, endpoints: ENDPOINTS, send: sender({ status: 404 }) })
    await refused.load()
    expect([...refused.viewed]).toEqual(['a.ts'])
  })

  test('a draft the server no longer has is dropped here too', async () => {
    writeDraft(SCOPE, { path: 'a.ts', side: 'right', from: 1, to: 1, text: 'sent already' })

    const store = createReviewStore({
      scope: SCOPE,
      endpoints: ENDPOINTS,
      send: sender({ answer: { signed_in: true, viewed: [], draft: null } }),
    })

    const announced: string[] = []
    store.subscribe(what => announced.push(what))
    await store.load()

    expect(store.draft()).toBeNull()
    expect(readDraft(SCOPE)).toBeNull()
    expect(announced).toEqual(['draft'])
  })
})

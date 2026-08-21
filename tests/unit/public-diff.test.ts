/**
 * The public diff viewer: reading somebody else's URL, and fetching carefully.
 *
 * Two halves, and they fail differently.
 *
 * **The parser** decides what a URL means, and its job is that five spellings
 * of one diff are one diff. A viewer where `/pull/123`, `/pull/123/files` and
 * `/pull/123.diff` are three URLs is a viewer where none of them is the one to
 * share. It is also the first boundary: everything downstream builds an
 * upstream URL out of what this returns, so a name it accepts is a name this
 * server will fetch.
 *
 * **The fetcher** is a fetcher pointed at the internet running on the server
 * that holds every repository on the instance, which is a thing to test rather
 * than a thing to be careful about. The allowlist, the redirect handling and
 * the byte ceiling are all here, driven by an injected `fetch` so the
 * assertions are about what this code does rather than about what GitHub did
 * today.
 *
 * And the failure classification, which is the part with the most value per
 * line: four different problems all arrive as a 404 or a 403, and telling them
 * apart is the difference between a sentence somebody can act on and an
 * afternoon of guessing.
 */

import type { DiffTarget } from '../../app/Actions/PublicDiff/parse'
import { describe, expect, test } from 'bun:test'
import { ALLOWED_HOSTS, apiPatchUrl, classify, fetchPatch, hostAllowed, looksLikePatch, resetOutboundWindow, takeOutboundSlot, webPatchUrl } from '../../app/Actions/PublicDiff/fetch'
import { MOUNT, parseDiffPath, parseDiffUrl } from '../../app/Actions/PublicDiff/parse'
import { renderTargetDiff } from '../../app/Actions/PublicDiff/render'

const PATCH = `diff --git a/x.ts b/x.ts
index 1111111..2222222 100644
--- a/x.ts
+++ b/x.ts
@@ -1,3 +1,3 @@
 const a = 1
-const b = 2
+const b = 3
 const c = 4
`

function target(path: string): DiffTarget {
  const found = parseDiffPath(path)

  if (!found)
    throw new Error(`${path} did not parse`)

  return found
}

/** A `fetch` that answers from a table, and records what it was asked. */
function fakeFetch(answers: Array<{ url?: RegExp, status: number, body?: string, headers?: Record<string, string> }>) {
  const seen: Array<{ url: string, headers: Record<string, string> }> = []
  let at = 0

  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const href = String(url)
    const headers: Record<string, string> = {}

    for (const [key, value] of Object.entries((init?.headers ?? {}) as Record<string, string>))
      headers[key.toLowerCase()] = value

    seen.push({ url: href, headers })

    const answer = answers.find(entry => entry.url && entry.url.test(href)) ?? answers[at++]

    if (!answer)
      throw new Error(`nothing left to answer ${href}`)

    return new Response(answer.body ?? '', { status: answer.status, headers: answer.headers })
  }) as unknown as typeof fetch

  return { impl, seen }
}

describe('five spellings of one diff', () => {
  const cases: Array<[string, string]> = [
    ['/o/r/pull/123', `${MOUNT}/o/r/pull/123`],
    ['/o/r/pull/123/files', `${MOUNT}/o/r/pull/123`],
    ['/o/r/pull/123/commits', `${MOUNT}/o/r/pull/123`],
    ['/o/r/pull/123.diff', `${MOUNT}/o/r/pull/123`],
    ['/o/r/pull/123.patch', `${MOUNT}/o/r/pull/123`],
  ]

  test.each(cases)('%s canonicalizes to %s', (path, canonical) => {
    expect(parseDiffPath(path)?.canonical).toBe(canonical)
  })

  test('and the raw ones say they are raw, so a script still gets text', () => {
    expect(parseDiffPath('/o/r/pull/123.diff')?.raw).toBe('diff')
    expect(parseDiffPath('/o/r/pull/123.patch')?.raw).toBe('patch')
    expect(parseDiffPath('/o/r/pull/123')?.raw).toBeNull()
  })
})

describe('the three kinds of thing a diff URL points at', () => {
  test('a pull request', () => {
    expect(parseDiffPath('/torvalds/linux/pull/1')).toMatchObject({ kind: 'pull', owner: 'torvalds', repository: 'linux', ref: '1' })
  })

  test('a commit, lower-cased so two spellings are one URL', () => {
    expect(parseDiffPath('/o/r/commit/ABC1234')).toMatchObject({ kind: 'commit', ref: 'abc1234' })
  })

  test('a compare range, including one with slashes in a branch name', () => {
    expect(parseDiffPath('/o/r/compare/v6.0...v7.0')).toMatchObject({ kind: 'compare', ref: 'v6.0...v7.0' })
    expect(parseDiffPath('/o/r/compare/main...user:feature/x')).toMatchObject({ kind: 'compare', ref: 'main...user:feature/x' })
  })
})

describe('what the parser refuses', () => {
  const refused = [
    '/o/r/tree/main',
    '/o/r/issues/1',
    '/o/r/blob/main/x.ts',
    '/o/r/pull/notanumber',
    '/o/r/commit/nothex',
    '/o',
    '/o/r',
    '',
    '/../../etc/passwd',
    '/o/../../r/pull/1',
    '/o/r/compare/../../etc',
  ]

  test.each(refused)('%s', (path) => {
    expect(parseDiffPath(path)).toBeNull()
  })

  test('a URL on any host but GitHub', () => {
    // The parser is the first place a hostile URL arrives, and everything
    // downstream builds an upstream URL out of what it returns.
    expect(parseDiffUrl('https://evil.example/o/r/pull/1')).toBeNull()
    expect(parseDiffUrl('https://github.com.evil.example/o/r/pull/1')).toBeNull()
    expect(parseDiffUrl('https://github.com@evil.example/o/r/pull/1')).toBeNull()
  })

  test('but reads the three shapes a person actually pastes', () => {
    for (const input of ['https://github.com/o/r/pull/1', 'github.com/o/r/pull/1', '/o/r/pull/1'])
      expect(parseDiffUrl(input)).toMatchObject({ kind: 'pull', ref: '1' })
  })
})

describe('where a request may go', () => {
  test('the upstream URLs are built from the target, never from input', () => {
    expect(webPatchUrl(target('/o/r/pull/1'))).toBe('https://github.com/o/r/pull/1.diff')
    expect(apiPatchUrl(target('/o/r/pull/1'))).toBe('https://api.github.com/repos/o/r/pulls/1')
    expect(webPatchUrl(target('/o/r/compare/a...b'))).toBe('https://github.com/o/r/compare/a...b.diff')
  })

  test('every host that may be reached is one of five', () => {
    expect([...ALLOWED_HOSTS].sort()).toEqual([
      'api.github.com',
      'codeload.github.com',
      'github.com',
      'patch-diff.githubusercontent.com',
      'www.github.com',
    ])
  })

  test('and nothing else is, however it is dressed up', () => {
    expect(hostAllowed('https://github.com/x')).toBe(true)
    expect(hostAllowed('http://github.com/x')).toBe(false)
    expect(hostAllowed('https://evil.example/x')).toBe(false)
    expect(hostAllowed('https://github.com.evil.example/x')).toBe(false)
    expect(hostAllowed('file:///etc/passwd')).toBe(false)
    expect(hostAllowed('http://169.254.169.254/latest/meta-data/')).toBe(false)
  })
})

describe('redirects are followed one hop at a time', () => {
  test('within the allowlist, because GitHub redirects a .diff to its CDN', async () => {
    const { impl, seen } = fakeFetch([
      { url: /github\.com\/o\/r\/pull\/1\.diff$/, status: 302, headers: { location: 'https://patch-diff.githubusercontent.com/raw/o/r/pull/1.diff' } },
      { url: /patch-diff/, status: 200, body: PATCH },
    ])

    const result = await fetchPatch(target('/o/r/pull/1'), { fetchImpl: impl, unmetered: true })

    expect(result.ok).toBe(true)
    expect(result.via).toBe('public')
    expect(seen.length).toBe(2)
  })

  test('and not outside it, which is the whole reason they are followed by hand', async () => {
    const { impl, seen } = fakeFetch([
      { status: 302, headers: { location: 'https://evil.example/steal' } },
    ])

    const result = await fetchPatch(target('/o/r/pull/1'), { fetchImpl: impl, unmetered: true })

    expect(result.ok).toBe(false)
    // One request made, and the second never attempted.
    expect(seen.length).toBe(1)
    expect(seen.every(entry => !entry.url.includes('evil.example'))).toBe(true)
  })

  test('a redirect loop ends rather than spinning', async () => {
    const { impl, seen } = fakeFetch([
      { url: /.*/, status: 302, headers: { location: 'https://github.com/o/r/pull/1.diff' } },
    ])

    const result = await fetchPatch(target('/o/r/pull/1'), { fetchImpl: impl, unmetered: true })

    expect(result.ok).toBe(false)
    expect(seen.length).toBeLessThanOrEqual(7)
  })
})

describe('four failures that all arrive as a 404 or a 403', () => {
  const headers = (values: Record<string, string> = {}) => new Headers(values)

  test('unauthenticated, a 404 is "no such diff, or it is private"', () => {
    expect(classify(404, headers(), false)).toBe('not-found')
  })

  test('with a token GitHub accepted, a 404 is "this repository is not on that token"', () => {
    // The fine-grained token mistake, and the one nothing anywhere tells you
    // about: the token is real, the repository is simply not selected on it.
    expect(classify(404, headers(), true)).toBe('repository-not-selected')
  })

  test('a 401 is a token that expired or was revoked', () => {
    expect(classify(401, headers(), true)).toBe('token-expired')
  })

  test('an SSO header is an organisation the token was never authorized for', () => {
    expect(classify(403, headers({ 'x-github-sso': 'required; url=https://github.com/orgs/acme/sso' }), true)).toBe('sso-required')
  })

  test('a 403 with no remaining requests is a rate limit, not a permission', () => {
    expect(classify(403, headers({ 'x-ratelimit-remaining': '0' }), false)).toBe('rate-limited')
    expect(classify(429, headers(), false)).toBe('rate-limited')
  })

  test('a 403 with requests remaining is a permission', () => {
    expect(classify(403, headers({ 'x-ratelimit-remaining': '4000' }), false)).toBe('private')
  })

  test('a 406 is the issue-number mistake, which is a missing diff rather than an outage', () => {
    expect(classify(406, headers(), false)).toBe('not-found')
  })

  test('and every one of them says what to do about it', async () => {
    // Three answers, because a token means three doors are tried and the last
    // one is the reason a reader is told about.
    const { impl } = fakeFetch([{ status: 404 }, { status: 401 }, { status: 401 }])
    const result = await fetchPatch(target('/o/r/pull/1'), { fetchImpl: impl, token: 'x', unmetered: true })

    expect(result.reason).toBe('token-expired')
    expect(result.message).toContain('Generate a new one')
  })
})

describe('what comes back has to be a patch', () => {
  test('a page is not', () => {
    expect(looksLikePatch('<!DOCTYPE html><html>')).toBe(false)
  })

  test('every shape of one is', () => {
    expect(looksLikePatch(PATCH)).toBe(true)
    expect(looksLikePatch('From abc Mon Sep 17 00:00:00 2001\n')).toBe(true)
    expect(looksLikePatch('--- a/x\n+++ b/x\n')).toBe(true)
  })

  test('and an empty one is, because a change that changes nothing is real', () => {
    expect(looksLikePatch('')).toBe(true)
  })

  test('a 200 carrying a page is "no such diff", not an empty diff', async () => {
    // GitHub sends `/pull/12.diff` for an issue number to `/issues/12`, which
    // answers 200 with a page. Parsing it gives a diff of zero files and a page
    // saying the change is empty, which is a confident wrong answer.
    const { impl } = fakeFetch([{ status: 200, body: '<!DOCTYPE html><html>an issue</html>' }])
    const result = await fetchPatch(target('/o/r/pull/12'), { fetchImpl: impl, unmetered: true })

    expect(result.ok).toBe(false)
    expect(result.reason).toBe('not-found')
  })
})

describe('the three doors, tried in order', () => {
  test('the public URL alone when there is no token', async () => {
    const { impl, seen } = fakeFetch([{ status: 200, body: PATCH }])

    await fetchPatch(target('/o/r/pull/1'), { fetchImpl: impl, unmetered: true })

    expect(seen.length).toBe(1)
    expect(seen[0]!.headers.authorization).toBeUndefined()
  })

  test('then the authenticated web URL, then the API', async () => {
    const { impl, seen } = fakeFetch([
      { status: 404 },
      { status: 404 },
      { status: 200, body: PATCH },
    ])

    const result = await fetchPatch(target('/o/r/pull/1'), { fetchImpl: impl, token: 'ghp_x', unmetered: true })

    expect(result.ok).toBe(true)
    expect(result.via).toBe('api')
    expect(seen.length).toBe(3)
    expect(seen[0]!.headers.authorization).toBeUndefined()
    expect(seen[1]!.headers.authorization).toBe('Bearer ghp_x')
    expect(seen[2]!.url).toContain('api.github.com')
  })

  test('a rate limit stops rather than spending the next door on the same answer', async () => {
    const { impl, seen } = fakeFetch([
      { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 120) } },
    ])

    const result = await fetchPatch(target('/o/r/pull/1'), { fetchImpl: impl, token: 'ghp_x', unmetered: true })

    expect(result.reason).toBe('rate-limited')
    expect(result.retryAfterMs).toBeGreaterThan(0)
    expect(seen.length).toBe(1)
  })
})

describe('rendered with this instance\'s own renderer', () => {
  test('a patch becomes the same rows a review here would show', async () => {
    const { impl } = fakeFetch([{ status: 200, body: PATCH }])
    const rendered = await renderTargetDiff(target('/o/r/pull/1'), { fetchImpl: impl, unmetered: true })

    expect(rendered.ok).toBe(true)
    expect(rendered.files).toBe(1)
    expect(rendered.additions).toBe(1)
    expect(rendered.deletions).toBe(1)
    expect(rendered.html).toContain('diff-file')
    // Highlighted by the server, like every other diff on this instance.
    expect(rendered.html).toContain('t-keyword')
  })

  test('expanding a gap is not offered, because the lines were never sent', async () => {
    const { impl } = fakeFetch([{ status: 200, body: PATCH }])
    const rendered = await renderTargetDiff(target('/o/r/pull/1'), { fetchImpl: impl, unmetered: true })

    expect(rendered.html).not.toContain('data-diff-expand')
  })

  test('a failure carries the reason and the sentence, not just a false', async () => {
    const { impl } = fakeFetch([{ status: 404 }])
    const rendered = await renderTargetDiff(target('/o/r/pull/1'), { fetchImpl: impl, unmetered: true })

    expect(rendered.ok).toBe(false)
    expect(rendered.reason).toBe('not-found')
    expect(rendered.message).toContain('Check the owner')
  })
})

describe('the ceiling on this instance\'s outbound traffic', () => {
  /**
   * A limit on what *this box* will fetch, rather than on what any one caller
   * asks for.
   *
   * The API endpoint is throttled per address, and the viewer page is served by
   * the other process where that middleware never runs - so a per-caller limit
   * alone would be a limit with a door beside it. What an operator needs to be
   * able to say is "this instance will not fetch more than N patches from
   * GitHub in five minutes", and only an instance-wide ceiling says that.
   */
  test('spends down and then refuses', () => {
    resetOutboundWindow()

    const now = 1_000_000

    expect(takeOutboundSlot(now, 3)).toBe(true)
    expect(takeOutboundSlot(now, 3)).toBe(true)
    expect(takeOutboundSlot(now, 3)).toBe(true)
    expect(takeOutboundSlot(now, 3)).toBe(false)
  })

  test('and recovers on its own, which is what makes it a ceiling and not a breaker', () => {
    resetOutboundWindow()

    const now = 2_000_000

    expect(takeOutboundSlot(now, 1)).toBe(true)
    expect(takeOutboundSlot(now, 1)).toBe(false)
    expect(takeOutboundSlot(now + 5 * 60 * 1000, 1)).toBe(true)
  })

  test('a refused request is reported as a rate limit, which the page can explain', async () => {
    resetOutboundWindow()

    const { impl, seen } = fakeFetch([{ status: 200, body: PATCH }])

    // Spent at *now*, because `fetchPatch` reads the clock itself: a window
    // opened at some other time would simply have expired by the time it looks.
    while (takeOutboundSlot()) { /* spend the window */ }

    const result = await fetchPatch(target('/o/r/pull/1'), { fetchImpl: impl })

    expect(result.reason).toBe('rate-limited')
    // And nothing left this process, which is the point.
    expect(seen.length).toBe(0)

    resetOutboundWindow()
  })
})

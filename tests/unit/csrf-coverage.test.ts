// Which routes are exempt from CSRF, and why each one is.
//
// The check is default-on in this framework, which is the right polarity: a
// route somebody forgot to protect is protected. What that leaves is the
// opposite failure - an exemption added because a request was being refused,
// with the refusal treated as the problem rather than as the point.
//
// So the exemptions are a list here, with a reason each, and a new
// `.skipCsrf()` fails this file until somebody adds it and says why. That is
// the only part of CSRF worth a test: the mechanism is the framework's and has
// its own; the *policy* is ours and lives in route files nobody re-reads.

import { describe, expect, test } from 'bun:test'

/**
 * Every route allowed to skip the check, and the reason it may.
 *
 * The reason is not decoration. Each one has to answer the same question -
 * **what ambient credential is this route spending?** - because CSRF exists to
 * stop a third party spending the browser's. A route that takes no cookie has
 * nothing for an attacker to ride, and a route that takes one is never exempt
 * however inconvenient the check is.
 */
const ALLOWED: Array<{ file: string, count: number, because: string }> = [
  {
    file: 'routes/git.ts',
    count: 13,
    because: 'the git wire protocol and LFS. A git client sends Basic auth or a '
      + 'token and holds no cookie, so there is no ambient credential here; the '
      + 'two internal endpoints are called by hook scripts this server wrote, '
      + 'over loopback, with a shared secret.',
  },
  {
    file: 'routes/api.ts',
    count: 1,
    because: 'the MCP endpoint. It reads its bearer itself and refuses a request '
      + 'without one before anything else happens, so there is no '
      + 'cookie-authenticated path for a forged post to ride. Left on, it '
      + 'answers a client that forgot its token with a 403 about a cookie it '
      + 'was never going to send.',
  },
  {
    file: 'routes/notifications.ts',
    count: 1,
    because: 'RFC 8058 one-click unsubscribe. Gmail posts cross-origin with no '
      + 'cookie and no way to carry a token; the signed token in the path is '
      + 'the whole authorization, and somebody holding it can already '
      + 'unsubscribe by opening the link.',
  },
]

/** Route files, so a new one cannot quietly carry exemptions nobody counted. */
async function routeFiles(): Promise<string[]> {
  const found: string[] = []

  for await (const path of new Bun.Glob('routes/*.ts').scan({ cwd: process.cwd() }))
    found.push(path)

  return found.sort()
}

async function skipCount(path: string): Promise<number> {
  const source = await Bun.file(path).text()

  // The call, not the word: these files explain their exemptions at length, and
  // counting mentions would count the explanations.
  return (source.match(/\.skipCsrf\(\)/g) ?? []).length
}

describe('CSRF exemptions', () => {
  test('every exemption is one of the documented ones, in the expected number', async () => {
    /*
     * A count rather than a list of paths, deliberately.
     *
     * Matching route patterns would make this fail on a rename, which is churn
     * with no security content. What it has to catch is an exemption *appearing*
     * - and a count catches that whatever the route is called.
     */
    for (const entry of ALLOWED)
      expect({ file: entry.file, skips: await skipCount(entry.file) }).toEqual({ file: entry.file, skips: entry.count })
  })

  test('no other route file has any', async () => {
    const allowed = new Set(ALLOWED.map(entry => entry.file))
    const strays: Array<{ file: string, skips: number }> = []

    for (const file of await routeFiles()) {
      if (allowed.has(file))
        continue

      const skips = await skipCount(file)

      if (skips > 0)
        strays.push({ file, skips })
    }

    // Reported with the file, so a failure says where rather than only that.
    expect(strays).toEqual([])
  })

  test('each exemption says what ambient credential the route does not spend', async () => {
    // The test that keeps the list honest. An entry added with "the client
    // cannot send a token" and nothing else is an entry that has not answered
    // the question, and it is the answer that decides whether the exemption is
    // safe.
    for (const entry of ALLOWED) {
      expect(entry.because.length).toBeGreaterThan(80)
      expect(/cookie|bearer|token|secret|ambient/i.test(entry.because)).toBe(true)
    }
  })

  test('the actions those routes reach do not set skipCsrf on themselves as well', async () => {
    /*
     * There are two ways to be exempt - the route and the action - and an
     * action that carries it is exempt on *every* route that reaches it,
     * including one added later by somebody who never saw the flag.
     *
     * Nothing here uses that form, and this keeps it that way: an exemption
     * should be visible where the route is registered, which is the file
     * somebody reads when they ask what is exposed.
     */
    const carriers: string[] = []

    for await (const path of new Bun.Glob('app/**/*.ts').scan({ cwd: process.cwd() })) {
      const source = await Bun.file(path).text()

      if (/^\s*skipCsrf:\s*true/m.test(source))
        carriers.push(path)
    }

    expect(carriers).toEqual([])
  })
})

describe('what is not exempt', () => {
  test('the API surface is protected apart from the one documented route', async () => {
    // 95 or so state-changing routes in one file, one exemption. Asserted as a
    // ratio rather than a number so the test does not fail every time an
    // endpoint is added, which is the kind of failure people learn to update
    // without reading.
    const source = await Bun.file('routes/api.ts').text()
    const unsafe = (source.match(/route\.(post|put|patch|delete)\(/g) ?? []).length

    expect(unsafe).toBeGreaterThan(50)
    expect(await skipCount('routes/api.ts')).toBe(1)
  })
})

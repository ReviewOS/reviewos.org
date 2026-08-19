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
    count: 14,
    because: 'the git wire protocol, LFS, and the checkpoint bundle a bundle-uri '
      + 'client fetches. A git client sends Basic auth or a token and holds no '
      + 'cookie, so there is no ambient credential here; the two internal '
      + 'endpoints are called by hook scripts this server wrote, over loopback, '
      + 'with a shared secret.',
  },
  {
    file: 'routes/api.ts',
    count: 16,
    because: 'the MCP endpoint, the mirror webhook, the nine runner routes, and the '
      + 'three GitHub-compatible paths an action posts to. '
      + 'MCP reads its bearer itself and refuses a request without one before '
      + 'anything else happens; the mirror webhook is signed over its body by an '
      + 'upstream forge that holds no cookie; the runner endpoints authenticate a '
      + 'machine by its own registered token - or, after a claim, by the '
      + 'credential minted for that one job - and there is no browser and no '
      + 'session anywhere in that conversation. None of them accepts an ambient '
      + 'credential, so there is nothing for a forged cross-site post to ride. '
      + 'Left on, each answers its only real caller with a 403 about a cookie it '
      + 'was never going to send - which is exactly what the mirror webhook did '
      + 'until an audit noticed that its intended caller had never once got '
      + 'through. The fifth runner route is the artifact upload, which is the '
      + 'same machine sending the same job credential with a body of bytes '
      + 'instead of a body of JSON, and the sixth is the annotation report - a '
      + 'job saying what its steps found, on the same job credential, so that '
      + '`::error file=...::` from a compiler becomes a message on the diff. The '
      + 'seventh is the step upload - a job adding jobs it generated to its own '
      + 'run, on the same job credential, which is what makes the uploaded '
      + 'document unable to say which run it belongs to. The eighth is the '
      + 'dependency cache save - the same machine sending the same job '
      + 'credential with a tar as its body, and a scope it does not get to '
      + 'choose, since the instance works that out from the run row. The ninth '
      + 'is the orchestrator call - a workflow program journaling its next '
      + 'step, on the job credential that names its own run, which is the '
      + 'whole of its scoping. The tenth is the other half of that call: the '
      + 'result the program reports when the step finishes, on the same '
      + 'credential, and the entry it names is checked against that run rather '
      + 'than believed.',
  },
  {
    file: 'routes/actions.ts',
    count: 2,
    because: 'the two git routes that serve mirrored actions to runners. There '
      + 'is no session and no cookie anywhere in a git fetch: the client is '
      + '`git`, it holds no ambient credential for this instance, and what it '
      + 'is fetching is public code mirrored from a public host - no '
      + 'repository contents and no user data. Both are read-only, and '
      + '`git-receive-pack` is deliberately not served at all, so there is '
      + 'nothing here for a forged post to change even if a browser could be '
      + 'made to send one.',
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
  test('the API surface is protected apart from the documented routes', async () => {
    // Ninety-odd state-changing routes in one file, nine exemptions. The route
    // count is asserted as a floor rather than a number, so adding an endpoint
    // does not fail this test - which is the kind of failure people learn to
    // update without reading. The exemption count is exact, because that is the
    // number worth noticing a change in, and it is what caught the runner
    // routes arriving without anybody writing down why they were exempt - once
    // for the first three, again for the log append, and again for the
    // annotation report, once more for the step upload, again for the split a
    // job asks for with its own job token, and three more for the
    // GitHub-shaped surface - which reads its bearer the way MCP does and
    // refuses a request without one, so there is no ambient credential for a
    // forged post to ride - and once more for the dependency cache save, whose
    // body is a tar and whose scope the instance decides rather than the
    // sender, and twice more for the two halves of an orchestrator call -
    // asking what to do, and saying what it returned - whose only identifier
    // is the job token they arrive with.
    const source = await Bun.file('routes/api.ts').text()
    const unsafe = (source.match(/route\.(post|put|patch|delete)\(/g) ?? []).length

    expect(unsafe).toBeGreaterThan(50)
    expect(await skipCount('routes/api.ts')).toBe(16)
  })
})

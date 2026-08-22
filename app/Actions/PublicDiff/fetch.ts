/**
 * Fetching somebody else's patch, carefully.
 *
 * This is a fetcher pointed at the internet with a text box in front of it,
 * which is a thing to be honest about rather than a thing to build casually. So
 * three constraints are structural rather than advisory:
 *
 * **An allowlist of hosts.** Every request this makes goes to a host named
 * here. Not "validate the URL and then fetch it" - the URL is *built* from a
 * parsed target, so there is no input that reaches `fetch` as a URL at all.
 * That closes the whole class where a redirect, a punycode homograph or a
 * `@`-in-userinfo trick turns a fetcher into a way to read this server's
 * network.
 *
 * **Redirects are followed, but only within the allowlist.** GitHub answers a
 * `.diff` with a redirect to `patch-diff.githubusercontent.com`, so refusing
 * redirects outright would refuse the ordinary case. They are followed by hand,
 * one at a time, with the host checked at each step.
 *
 * **A byte ceiling and a timeout.** A patch is text and this reads it into
 * memory, so an unbounded one is an unbounded allocation on a shared server.
 *
 * ## Why it tries three ways
 *
 * The public URL first, because it needs no token and is what works for the
 * ninety-nine percent of diffs that are public. Then the authenticated web
 * URL, which is the same URL with the reader's own token on it - private
 * repositories, and public ones behind an organisation's SSO. Then the API,
 * which is a different endpoint with different permissions again: a
 * fine-grained token that can read a repository through the API may not be able
 * to read the web URL at all.
 *
 * And when all three fail it says **which** thing failed and what to do about
 * it. A bare 404 sends somebody to guess between "the pull request does not
 * exist", "my token expired", "I never authorized this token for that org" and
 * "the repository is not selected on my fine-grained token" - four different
 * afternoons.
 */

import type { DiffTarget } from './parse'
import publicDiff from '../../../config/publicdiff'

/**
 * Every host this may talk to.
 *
 * `github.com` serves the web `.diff`, `patch-diff.githubusercontent.com` is
 * where it redirects, `api.github.com` is the third attempt, and
 * `codeload.github.com` appears on some archive redirects. Nothing else, ever -
 * this is the list, not a default that a configuration file can widen, because
 * a widened allowlist is the whole vulnerability.
 */
export const ALLOWED_HOSTS: ReadonlySet<string> = new Set([
  'github.com',
  'www.github.com',
  'api.github.com',
  'patch-diff.githubusercontent.com',
  'codeload.github.com',
])

/**
 * How many upstream requests this instance will make, per five minutes, in
 * total.
 *
 * A ceiling on *this instance's outbound traffic*, not on any one caller's.
 * That is deliberate and it is the one that matters here: the API endpoint is
 * throttled per address, but the viewer page is served by the other process and
 * never sees that middleware, so a limit that only lived on the endpoint would
 * be a limit with a door beside it.
 *
 * It is also the honest shape of the promise. What an operator needs to be able
 * to say is "this box will not fetch more than N patches from GitHub in five
 * minutes", and no per-caller limit can say that.
 *
 * A refusal is `rate-limited`, which the page already knows how to explain -
 * and it recovers on its own, which is what makes a ceiling different from a
 * circuit breaker.
 */
const WINDOW_MS = 5 * 60 * 1000

const outbound = { windowStartedAt: 0, spent: 0 }

/**
 * Take one request from the window, or answer false.
 *
 * A fixed window rather than a sliding one: this is a safety ceiling on
 * outbound traffic, not a fairness mechanism, and a fixed window is two numbers
 * where a sliding one is a list that has to be swept.
 */
export function takeOutboundSlot(now: number = Date.now(), limit: number = publicDiff.requestsPerWindow): boolean {
  if (now - outbound.windowStartedAt >= WINDOW_MS) {
    outbound.windowStartedAt = now
    outbound.spent = 0
  }

  if (outbound.spent >= Math.max(1, limit))
    return false

  outbound.spent += 1

  return true
}

/** Exported for tests, which need a window that has not been spent. */
export function resetOutboundWindow(): void {
  outbound.windowStartedAt = 0
  outbound.spent = 0
}

/**
 * The most patch bytes read into memory for one request.
 *
 * Sixty-four megabytes, and the number is set by the diffs this is meant to
 * open rather than by a round figure. DiffsHub's own demo links are the bar
 * this viewer was written against, and one of them - `oven-sh/bun#30412` - is a
 * **43.3MB** patch. A ceiling that refuses the thing being demonstrated is a
 * ceiling in the wrong place.
 *
 * What it protects is this server's memory for one request, and it is not what
 * protects the reader: `MAX_RENDERED_FILES` is, by rendering the first three
 * hundred files and saying so. Those are different bounds on different
 * machines, and conflating them is how the browser-side limit came to be
 * enforced by a server-side one.
 */
export const MAX_PATCH_BYTES = 64 * 1024 * 1024

/** How long one upstream request may take before it is abandoned. */
export const FETCH_TIMEOUT_MS = 20_000

/** How many redirects are followed before this gives up. */
export const MAX_REDIRECTS = 5

/**
 * Why a fetch failed, in the reader's terms.
 *
 * Every one of these becomes a sentence on the page saying what to do. The
 * value of the enumeration is that the *reason* is decided here, where the
 * status and the headers are, rather than inferred later from a status code
 * that cannot tell four of these apart.
 */
export type FailureReason =
  | 'not-found'
  | 'private'
  | 'token-expired'
  | 'sso-required'
  | 'repository-not-selected'
  | 'rate-limited'
  | 'too-large'
  | 'upstream-error'
  | 'network'

export interface PatchResult {
  ok: boolean
  patch: string | null
  /** Which of the three attempts answered, for the page to say so. */
  via: 'public' | 'authenticated' | 'api' | null
  reason: FailureReason | null
  /** A sentence for a reader, naming what to do rather than what went wrong. */
  message: string | null
  /** When rate limited, when it resets, so a page can say how long. */
  retryAfterMs: number | null
}

/** What a reader is told, per reason. */
const MESSAGES: Record<FailureReason, string> = {
  'not-found': 'GitHub has no such pull request, commit or compare range. Check the owner, the repository and the number.',
  'private': 'That repository is private. Add a fine-grained personal access token below and try again - it is kept in this browser and sent only with the request for this diff.',
  'token-expired': 'That token is expired or was revoked. Generate a new one on GitHub and paste it in again.',
  'sso-required': 'That token has not been authorized for this organisation\'s SSO. Authorize it on the token\'s page on GitHub, then try again.',
  'repository-not-selected': 'That fine-grained token does not list this repository. Edit the token on GitHub and add the repository to it.',
  'rate-limited': 'GitHub is rate limiting this request. Adding a token raises the limit considerably, and waiting also works.',
  'too-large': 'That patch is larger than this viewer will fetch. The diff is real; it is bigger than a browser should be handed in one piece.',
  'upstream-error': 'GitHub answered with an error. That is usually temporary.',
  'network': 'GitHub could not be reached from this server.',
}

function failure(reason: FailureReason, retryAfterMs: number | null = null): PatchResult {
  return { ok: false, patch: null, via: null, reason, message: MESSAGES[reason], retryAfterMs }
}

/** The web URL for a target's patch, which is the public attempt. */
export function webPatchUrl(target: DiffTarget): string {
  const base = `https://github.com/${target.owner}/${target.repository}`

  if (target.kind === 'pull')
    return `${base}/pull/${target.ref}.diff`

  if (target.kind === 'commit')
    return `${base}/commit/${target.ref}.diff`

  return `${base}/compare/${target.ref}.diff`
}

/** The API URL for the same thing, which has different permissions. */
export function apiPatchUrl(target: DiffTarget): string {
  const base = `https://api.github.com/repos/${target.owner}/${target.repository}`

  if (target.kind === 'pull')
    return `${base}/pulls/${target.ref}`

  if (target.kind === 'commit')
    return `${base}/commits/${target.ref}`

  return `${base}/compare/${target.ref}`
}

function allowed(url: string): boolean {
  try {
    const parsed = new URL(url)

    return parsed.protocol === 'https:' && ALLOWED_HOSTS.has(parsed.hostname.toLowerCase())
  }
  catch {
    return false
  }
}

/**
 * Read a response's body with a ceiling, without buffering past it.
 *
 * `await response.text()` on a response with no `content-length` reads whatever
 * arrives, which on a hostile or simply enormous upstream is however much the
 * process has. This stops at the ceiling and says so.
 */
async function readBounded(response: Response, limit: number): Promise<string | null> {
  const declared = Number(response.headers.get('content-length') ?? '')

  if (Number.isFinite(declared) && declared > limit)
    return null

  const reader = response.body?.getReader()

  if (!reader)
    return null

  const chunks: Uint8Array[] = []
  let total = 0

  for (;;) {
    const { done, value } = await reader.read()

    if (done)
      break

    if (value) {
      total += value.byteLength

      if (total > limit) {
        await reader.cancel().catch(() => {})
        return null
      }

      chunks.push(value)
    }
  }

  return new TextDecoder().decode(await new Blob(chunks as BlobPart[]).arrayBuffer())
}

export interface FetchOptions {
  /** The reader's own token, when they gave one. Never stored on this server. */
  token?: string | null
  /** Injected by tests. */
  fetchImpl?: typeof fetch
  /** Overridden by tests so a fixture server can stand in for GitHub. */
  hosts?: ReadonlySet<string>
  /**
   * Skip the instance-wide outbound ceiling.
   *
   * For tests, which drive dozens of fetches against an injected `fetch` that
   * never leaves the process - and would otherwise spend a real window and make
   * the suite's later assertions depend on its earlier ones.
   */
  unmetered?: boolean
}

/**
 * One request, following redirects by hand so each hop is checked.
 *
 * `redirect: 'manual'` rather than `follow`, because `follow` hands the
 * allowlist to the upstream: GitHub redirecting to GitHub is fine and GitHub
 * redirecting anywhere else must not be followed, and only a manual loop can
 * tell the difference.
 */
async function request(
  url: string,
  headers: Record<string, string>,
  options: FetchOptions,
): Promise<Response | 'blocked' | 'network'> {
  const call = options.fetchImpl ?? fetch
  const hosts = options.hosts ?? ALLOWED_HOSTS

  const permitted = (candidate: string): boolean => {
    try {
      const parsed = new URL(candidate)

      return (parsed.protocol === 'https:' || (options.hosts !== undefined && parsed.protocol === 'http:'))
        && hosts.has(parsed.hostname.toLowerCase())
    }
    catch {
      return false
    }
  }

  let next = url

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!permitted(next))
      return 'blocked'

    let answer: Response

    try {
      answer = await call(next, {
        headers,
        redirect: 'manual',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
    }
    catch {
      return 'network'
    }

    if (answer.status < 300 || answer.status >= 400)
      return answer

    const location = answer.headers.get('location')

    if (!location)
      return answer

    // Resolved against the URL it came from, so a relative `Location` - which
    // GitHub does use - lands on the same host rather than being rejected.
    next = new URL(location, next).toString()
  }

  return 'blocked'
}

/**
 * Read what a failing response is actually telling us.
 *
 * This is the part that turns four indistinguishable 404s into four sentences.
 * GitHub says most of it in headers: `x-github-sso` names an organisation whose
 * SSO the token has not been authorized for, and `x-ratelimit-remaining` is
 * what separates a rate limit from a permission problem, both of which are 403.
 */
export function classify(status: number, headers: Headers, authenticated: boolean): FailureReason {
  if (status === 429 || (status === 403 && headers.get('x-ratelimit-remaining') === '0'))
    return 'rate-limited'

  if (headers.get('x-github-sso'))
    return 'sso-required'

  if (status === 401)
    return 'token-expired'

  if (status === 403)
    return authenticated ? 'repository-not-selected' : 'private'

  /*
   * A 404 with a token means something different from a 404 without one.
   *
   * GitHub answers 404 rather than 403 for a repository the caller may not see,
   * which is the right thing for them to do and the reason this cannot be read
   * off the status alone. Unauthenticated, it means "private, or not there".
   * *With* a token that GitHub accepted, it means the token is real and this
   * repository is not on it - which for a fine-grained token is the single most
   * common mistake, and the one nothing anywhere tells you about.
   */
  if (status === 404 || status === 410)
    return authenticated ? 'repository-not-selected' : 'not-found'

  /*
   * 406 means "that URL cannot be a diff", and it is how GitHub answers the
   * commonest mistake: `/pull/12.diff` for a number that is an *issue*. The
   * `.diff` redirects to `/issues/12` with no suffix, and asking that page for
   * `application/vnd.github.v3.diff` is not acceptable to it. To a reader it is
   * the same fact as a 404 - there is no such diff - so it says so rather than
   * "GitHub answered with an error", which sends somebody to check GitHub's
   * status page over a typo.
   */
  if (status === 406)
    return 'not-found'

  if (status >= 500)
    return 'upstream-error'

  return 'upstream-error'
}

function retryAfter(headers: Headers): number | null {
  const reset = Number(headers.get('x-ratelimit-reset') ?? '')

  if (Number.isFinite(reset) && reset > 0)
    return Math.max(0, reset * 1000 - Date.now())

  const after = Number(headers.get('retry-after') ?? '')

  return Number.isFinite(after) && after > 0 ? after * 1000 : null
}

/**
 * Fetch a target's patch, trying the public URL, then the authenticated one,
 * then the API - and reporting which one answered, or why none did.
 */
export async function fetchPatch(target: DiffTarget, options: FetchOptions = {}): Promise<PatchResult> {
  const token = typeof options.token === 'string' && options.token.trim() !== '' ? options.token.trim() : null

  const agent = {
    'user-agent': 'ReviewOS-diff-viewer',
    'accept': 'application/vnd.github.v3.diff',
  }

  const attempts: Array<{ via: PatchResult['via'], url: string, headers: Record<string, string>, authenticated: boolean }> = [
    { via: 'public', url: webPatchUrl(target), headers: agent, authenticated: false },
  ]

  if (token) {
    attempts.push({
      via: 'authenticated',
      url: webPatchUrl(target),
      headers: { ...agent, authorization: `Bearer ${token}` },
      authenticated: true,
    })
    attempts.push({
      via: 'api',
      url: apiPatchUrl(target),
      headers: { ...agent, 'authorization': `Bearer ${token}`, 'x-github-api-version': '2022-11-28' },
      authenticated: true,
    })
  }

  let last: PatchResult = failure('not-found')

  for (const attempt of attempts) {
    if (!options.unmetered && !takeOutboundSlot())
      return failure('rate-limited', WINDOW_MS)

    const answer = await request(attempt.url, attempt.headers, options)

    if (answer === 'blocked') {
      // Not a reader's problem to solve, and not a reason to try the next door:
      // a redirect off the allowlist is this viewer refusing, deliberately.
      return failure('upstream-error')
    }

    if (answer === 'network') {
      last = failure('network')
      continue
    }

    if (answer.ok) {
      const patch = await readBounded(answer, MAX_PATCH_BYTES)

      if (patch === null)
        return failure('too-large')

      /*
       * A 200 that is not a patch is a redirect that landed somewhere else -
       * most often `/pull/12.diff` for a number that is an issue, which GitHub
       * sends to `/issues/12` and answers with a page. Treated as "no such
       * diff" rather than parsed, because parsing it yields a diff of zero
       * files and a page saying the change is empty.
       */
      if (!looksLikePatch(patch)) {
        last = failure('not-found')
        continue
      }

      return { ok: true, patch, via: attempt.via, reason: null, message: null, retryAfterMs: null }
    }

    const reason = classify(answer.status, answer.headers, attempt.authenticated)

    last = failure(reason, reason === 'rate-limited' ? retryAfter(answer.headers) : null)

    // A rate limit is not a permission problem, so trying the next door with
    // the same token would spend another request to be told the same thing.
    if (reason === 'rate-limited')
      return last
  }

  return last
}

/**
 * Whether what came back is a patch at all.
 *
 * GitHub answers `/pull/12.diff` for a number that is an *issue* with a 302 to
 * `/issues/12` - no suffix - and that page is HTML with a 200 on it. Following
 * the redirect and handing the result to the diff parser produces a diff of
 * zero files and a page that says the change is empty, which is a confident
 * wrong answer to "does this pull request exist".
 *
 * A patch begins with `diff --git`, with `From ` for the mailbox form the
 * `.patch` endpoint returns, or with `---` for a bare unified diff. An empty
 * body is accepted, because a pull request that changes nothing is a real thing
 * and rendering it as empty is correct.
 */
export function looksLikePatch(body: string): boolean {
  const start = body.trimStart()

  if (start === '')
    return true

  return start.startsWith('diff --git')
    || start.startsWith('From ')
    || start.startsWith('--- ')
    || start.startsWith('Index: ')
}

/** Exported for the tests that check nothing else may be reached. */
export function hostAllowed(url: string): boolean {
  return allowed(url)
}

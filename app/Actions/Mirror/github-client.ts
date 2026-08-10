/**
 * Reading a repository's metadata from GitHub.
 *
 * The impure half of the metadata sync. Mapping lives in `github.ts`; this only
 * fetches, paginates, and knows what a rate limit looks like.
 */

const API = 'https://api.github.com'

export interface GitHubClientOptions {
  token?: string | null
  /** Injected in tests; defaults to global fetch. */
  fetchImpl?: typeof fetch
  /**
   * Where the API lives, for a fixture or a GitHub Enterprise instance.
   *
   * Defaults to the public API. Overriding the whole base rather than
   * intercepting `fetch` is what lets a test drive this client against a
   * fixture server that answers the *real* endpoints, paginates with a real
   * `Link` header, and returns a real 403 for a rate limit - so the pagination
   * and the backoff are exercised rather than stubbed past.
   */
  baseUrl?: string
  /**
   * How the token is presented, for forges that do not say `Bearer`.
   *
   * Gitea and Forgejo want `token abc` for an access token issued from their
   * settings page. Sending `Bearer` there is answered as *unauthenticated*
   * rather than rejected, so a private repository silently imports as empty -
   * which is why this is a parameter and not an assumption.
   */
  authorization?: (token: string) => string
}

export interface PageResult<T> {
  ok: boolean
  items: T[]
  error: string | null
  /** True when the page cap stopped the fetch, not the end of the collection. */
  truncated?: boolean
}

/**
 * Rate-limit state as GitHub reports it.
 *
 * A 403 from GitHub is usually a rate limit rather than a permission problem,
 * and the two want opposite responses: one should be retried later, the other
 * never. `x-ratelimit-remaining` is what tells them apart.
 */
export function isRateLimited(status: number, headers: Headers): boolean {
  if (status !== 403 && status !== 429) return false
  const remaining = headers.get('x-ratelimit-remaining')
  return remaining === null || remaining === '0'
}

/** When the limit resets, in ms from now, so a caller can wait rather than spin. */
export function resetDelayMs(headers: Headers, now: Date = new Date()): number {
  const header = headers.get('x-ratelimit-reset')
  // `Number('')` is 0, which is finite, so an absent header would otherwise read
  // as "the limit reset in 1970" and the caller would retry immediately.
  if (header === null || header.trim() === '') return 60_000

  const reset = Number(header)
  if (!Number.isFinite(reset)) return 60_000
  return Math.max(0, reset * 1000 - now.getTime())
}

/**
 * Whether there is another page.
 *
 * GitHub paginates by Link header rather than a count, so the only honest way
 * to know is to look for `rel="next"`. Guessing from a full page fails on a
 * collection that is an exact multiple of the page size.
 */
export function hasNextPage(headers: Headers): boolean {
  return nextPageUrl(headers) !== null
}

/**
 * The URL of the next page, exactly as GitHub gave it.
 *
 * Following this link is the only pagination that works past a few thousand
 * rows. Building `?page=N` by hand does not: on a large collection GitHub
 * answers 422 with "pagination with the page parameter is not supported for
 * large datasets, please use cursor based pagination". The `next` link already
 * carries that cursor, so honouring it costs nothing and is what the Link
 * header is for.
 *
 * A mirror is exactly the case that hits this, since it reads every issue a
 * repository ever had rather than the first page of them.
 */
export function nextPageUrl(headers: Headers): string | null {
  const link = headers.get('link') ?? ''

  for (const part of link.split(',')) {
    const match = /^\s*<([^>]+)>\s*;\s*rel="next"/.exec(part)
    if (match?.[1]) return match[1]
  }

  return null
}

export class GitHubClient {
  private token: string | null
  private fetchImpl: typeof fetch
  private baseUrl: string
  private authorization: (token: string) => string

  constructor(options: GitHubClientOptions = {}) {
    this.token = options.token ?? null
    this.fetchImpl = options.fetchImpl ?? fetch
    this.baseUrl = (options.baseUrl ?? API).replace(/\/$/, '')
    this.authorization = options.authorization ?? (token => `Bearer ${token}`)
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      // GitHub asks for a user agent and answers 403 without one, which is
      // otherwise indistinguishable from a permission failure.
      'user-agent': 'ReviewOS-Mirror',
    }
    if (this.token) headers.authorization = this.authorization(this.token)
    return headers
  }

  /**
   * Fetch every page of a collection.
   *
   * Capped rather than unbounded, because a repository with a hundred thousand
   * issues would otherwise hold a job open for hours on its first sync. But the
   * cap is high enough to cover any real repository in one pass, and reaching
   * it is reported rather than passed off as a complete import.
   *
   * The first version stopped at 20 pages and said nothing. A mirror of a
   * repository with 2,151 issues and pull requests imported the oldest 2,000
   * and looked finished - the missing 151 read as a repository that simply
   * never had them. A truncated mirror that admits it is recoverable; one that
   * claims to be complete is not.
   */
  async collect<T>(path: string, options: { maxPages?: number, perPage?: number } = {}): Promise<PageResult<T>> {
    const perPage = options.perPage ?? 100
    const maxPages = options.maxPages ?? 200
    const items: T[] = []

    const separator = path.includes('?') ? '&' : '?'
    let url: string | null = `${this.baseUrl}${path}${separator}per_page=${perPage}`

    for (let page = 1; page <= maxPages && url !== null; page++) {
      let response: Response
      try {
        response = await this.fetchImpl(url, { headers: this.headers() })
      }
      catch (error) {
        return { ok: false, items, error: error instanceof Error ? error.message : String(error) }
      }

      if (isRateLimited(response.status, response.headers))
        return { ok: false, items, error: `rate limited, resets in ${Math.round(resetDelayMs(response.headers) / 1000)}s` }

      if (response.status === 404)
        return { ok: false, items, error: 'not found — the repository may be private or renamed' }

      if (!response.ok)
        return { ok: false, items, error: `GitHub returned ${response.status}` }

      const body = await response.json().catch(() => null)
      if (!Array.isArray(body))
        return { ok: false, items, error: 'unexpected response shape' }

      items.push(...(body as T[]))

      // The next URL comes from GitHub rather than being constructed here, so
      // the cursor it carries survives into the following request.
      url = nextPageUrl(response.headers)
      if (url === null)
        return { ok: true, items, error: null, truncated: false }
    }

    // Fell out of the loop with a next page still waiting: the cap stopped us,
    // not the data. Reported as a failure so the caller records it and retries
    // rather than writing the partial set down as the whole truth.
    return {
      ok: false,
      items,
      error: `stopped after ${maxPages} pages with more to fetch`,
      truncated: true,
    }
  }

  issues(owner: string, name: string) {
    // `state=all` because a mirror that shows only open issues misrepresents
    // the repository, and closed issues are what most references point at.
    return this.collect<any>(`/repos/${owner}/${name}/issues?state=all&sort=created&direction=asc`)
  }

  pulls(owner: string, name: string) {
    return this.collect<any>(`/repos/${owner}/${name}/pulls?state=all&sort=created&direction=asc`)
  }

  /**
   * Review comments: the whole repository's, or one review's.
   *
   * The repository-wide form is GitHub's and is one request for everything.
   * Gitea and Forgejo have no equivalent, so a caller there passes the pull
   * request and the review and pays a request per review. Same method, because
   * the caller's question is the same and only the cost differs.
   */
  reviewComments(owner: string, name: string, index?: number, reviewId?: number) {
    if (index !== undefined && reviewId !== undefined)
      return this.collect<any>(`/repos/${owner}/${name}/pulls/${index}/reviews/${reviewId}/comments`)

    return this.collect<any>(`/repos/${owner}/${name}/pulls/comments?sort=created&direction=asc`)
  }

  labels(owner: string, name: string) {
    return this.collect<any>(`/repos/${owner}/${name}/labels`)
  }

  /**
   * The reviews on one pull request, for forges with no repository-wide list.
   *
   * Gitea and Forgejo have no equivalent of GitHub's `/pulls/comments`, so a
   * repository's reviews cost one request per pull request there. That is a
   * different cost model rather than a different field name, and it is why the
   * import asks the forge shape rather than assuming.
   */
  pullReviews(owner: string, name: string, index: number) {
    return this.collect<any>(`/repos/${owner}/${name}/pulls/${index}/reviews`)
  }

  /**
   * Every comment on every issue in the repository, in one collection.
   *
   * `/issues/comments` rather than a call per issue. A repository with two
   * thousand issues would otherwise cost two thousand requests against an hourly
   * limit, which is the difference between an import that finishes in an
   * afternoon and one that does not finish.
   */
  issueComments(owner: string, name: string) {
    return this.collect<any>(`/repos/${owner}/${name}/issues/comments`)
  }

  /** Releases, newest first, each carrying its assets inline. */
  releases(owner: string, name: string) {
    return this.collect<any>(`/repos/${owner}/${name}/releases`)
  }

  milestones(owner: string, name: string) {
    // `state=all` for the same reason issues are: a closed milestone is what
    // most of a repository's history is filed under.
    return this.collect<any>(`/repos/${owner}/${name}/milestones?state=all`)
  }

  /**
   * The repository itself: description, topics, visibility, default branch.
   *
   * A single object rather than a collection, so it does not go through
   * `collect`. Returns null rather than throwing on a failure, because this is
   * the *decorative* half of a sync - a mirror whose git data landed and whose
   * description did not is a working mirror with a stale sentence, and failing
   * the whole sync over that would stop the half that matters.
   */
  async repository(owner: string, name: string): Promise<any | null> {
    try {
      const answer = await this.fetchImpl(`${this.baseUrl}/repos/${owner}/${name}`, {
        headers: this.headers(),
      })

      if (!answer.ok)
        return null

      return await answer.json()
    }
    catch {
      return null
    }
  }
}

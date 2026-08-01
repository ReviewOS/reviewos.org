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
}

export interface PageResult<T> {
  ok: boolean
  items: T[]
  error: string | null
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
  return /rel="next"/.test(headers.get('link') ?? '')
}

export class GitHubClient {
  private token: string | null
  private fetchImpl: typeof fetch

  constructor(options: GitHubClientOptions = {}) {
    this.token = options.token ?? null
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      // GitHub asks for a user agent and answers 403 without one, which is
      // otherwise indistinguishable from a permission failure.
      'user-agent': 'ReviewOS-Mirror',
    }
    if (this.token) headers.authorization = `Bearer ${this.token}`
    return headers
  }

  /**
   * Fetch every page of a collection.
   *
   * Capped rather than unbounded: a repository with fifty thousand issues would
   * otherwise hold a job open for hours on its first sync, and a partial import
   * that finishes beats a complete one that never does.
   */
  async collect<T>(path: string, options: { maxPages?: number, perPage?: number } = {}): Promise<PageResult<T>> {
    const perPage = options.perPage ?? 100
    const maxPages = options.maxPages ?? 20
    const items: T[] = []

    for (let page = 1; page <= maxPages; page++) {
      const separator = path.includes('?') ? '&' : '?'
      const url = `${API}${path}${separator}per_page=${perPage}&page=${page}`

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

      if (!hasNextPage(response.headers)) break
    }

    return { ok: true, items, error: null }
  }

  issues(owner: string, name: string) {
    // `state=all` because a mirror that shows only open issues misrepresents
    // the repository, and closed issues are what most references point at.
    return this.collect<any>(`/repos/${owner}/${name}/issues?state=all&sort=created&direction=asc`)
  }

  pulls(owner: string, name: string) {
    return this.collect<any>(`/repos/${owner}/${name}/pulls?state=all&sort=created&direction=asc`)
  }

  reviewComments(owner: string, name: string) {
    return this.collect<any>(`/repos/${owner}/${name}/pulls/comments?sort=created&direction=asc`)
  }
}

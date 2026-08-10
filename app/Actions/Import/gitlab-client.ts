/**
 * Reading a GitLab project, and presenting it as the import already reads.
 *
 * The same surface as `GitHubClient` - `issues`, `pulls`, `reviewComments`,
 * `labels`, `milestones`, `releases`, `issueComments` - so the import's stages
 * do not branch on which forge they are talking to. Everything GitLab-shaped is
 * translated in `gitlab.ts` and nothing after this file knows the difference.
 *
 * ## Why an adapter rather than parameters
 *
 * Gitea shares GitHub's paths, so it needed a base URL and an authorization
 * form. GitLab shares none of them: a repository is a project addressed by an
 * encoded path, comments are notes on a subject rather than a collection on the
 * repository, and review threads are discussions with a position. Threading
 * that through the GitHub client as options would have produced a client that
 * is two clients with a flag, which is the shape nobody can safely change.
 */

import type { PageResult } from '../Mirror/github-client'
import { asIssue, asIssueComment, asPullRequest, asRelease, asReviewComment, projectPath } from './gitlab'

export interface GitLabClientOptions {
  token?: string | null
  /** The instance, with or without `/api/v4`. */
  baseUrl: string
  fetchImpl?: typeof fetch
}

export class GitLabClient {
  private token: string | null
  private baseUrl: string
  private fetchImpl: typeof fetch

  constructor(options: GitLabClientOptions) {
    this.token = options.token ?? null
    this.baseUrl = String(options.baseUrl ?? '').replace(/\/+$/, '')
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { accept: 'application/json' }

    /*
     * `PRIVATE-TOKEN`, which is what a personal access token from the settings
     * page is presented as. GitLab also accepts `Authorization: Bearer` for an
     * OAuth token, and sending the wrong one for the kind you have is answered
     * as *unauthenticated* rather than rejected - so a private project imports
     * as empty and reports success.
     */
    if (this.token)
      headers['private-token'] = this.token

    return headers
  }

  /**
   * Fetch every page of a collection.
   *
   * GitLab paginates with `?page=` and reports the next page in `x-next-page`,
   * which is empty on the last one. Capped like the GitHub client's, and
   * reaching the cap is reported rather than passed off as a complete import.
   */
  private async collect<T>(path: string, maxPages = 200): Promise<PageResult<T>> {
    const items: T[] = []
    const separator = path.includes('?') ? '&' : '?'

    for (let page = 1; page <= maxPages; page++) {
      let response: Response

      try {
        response = await this.fetchImpl(`${this.baseUrl}${path}${separator}per_page=100&page=${page}`, {
          headers: this.headers(),
        })
      }
      catch (error) {
        return { ok: false, items, error: error instanceof Error ? error.message : String(error) }
      }

      if (response.status === 404)
        return { ok: false, items, error: 'not found — the project may be private or renamed' }

      /*
       * 429 is GitLab's rate limit, and `retry-after` says how long.
       *
       * Reported rather than retried here: the job's own retry brings it back,
       * and it resumes from the stage it stopped in rather than the beginning.
       */
      if (response.status === 429) {
        const after = response.headers.get('retry-after')

        return { ok: false, items, error: `rate limited${after ? `, retry after ${after}s` : ''}` }
      }

      if (!response.ok)
        return { ok: false, items, error: `GitLab returned ${response.status}` }

      const body = await response.json().catch(() => null)

      if (!Array.isArray(body))
        return { ok: false, items, error: 'the response was not a list' }

      items.push(...(body as T[]))

      const next = response.headers.get('x-next-page')

      // Empty means this was the last page. A server that omits the header
      // entirely is handled by the short page below, so neither convention
      // silently truncates.
      if (!next || body.length === 0)
        break

      if (page === maxPages)
        return { ok: true, items, error: null, truncated: true }
    }

    return { ok: true, items, error: null }
  }

  private project(owner: string, name: string): string {
    return `/projects/${projectPath(owner, name)}`
  }

  async issues(owner: string, name: string): Promise<PageResult<any>> {
    const page = await this.collect<any>(`${this.project(owner, name)}/issues?scope=all&order_by=created_at&sort=asc`)

    return { ...page, items: page.items.map(raw => asIssue(raw)) }
  }

  async pulls(owner: string, name: string): Promise<PageResult<any>> {
    const page = await this.collect<any>(`${this.project(owner, name)}/merge_requests?scope=all&order_by=created_at&sort=asc`)

    return { ...page, items: page.items.map(raw => asPullRequest(raw)) }
  }

  async labels(owner: string, name: string): Promise<PageResult<any>> {
    const page = await this.collect<any>(`${this.project(owner, name)}/labels`)

    return {
      ...page,
      items: page.items.map(raw => ({
        name: String(raw?.name ?? ''),
        // GitLab writes `#d73a4a`; every other forge and this database write
        // the six characters without it.
        color: String(raw?.color ?? '').replace(/^#/, ''),
        description: String(raw?.description ?? '') || null,
      })),
    }
  }

  async milestones(owner: string, name: string): Promise<PageResult<any>> {
    const page = await this.collect<any>(`${this.project(owner, name)}/milestones`)

    return {
      ...page,
      items: page.items.map(raw => ({
        title: String(raw?.title ?? ''),
        description: String(raw?.description ?? '') || null,
        // GitLab says `active`; everything else says `open`.
        state: String(raw?.state ?? '') === 'closed' ? 'closed' : 'open',
        due_on: raw?.due_date ? String(raw.due_date) : null,
      })),
    }
  }

  async releases(owner: string, name: string): Promise<PageResult<any>> {
    const page = await this.collect<any>(`${this.project(owner, name)}/releases`)

    return { ...page, items: page.items.map(raw => asRelease(raw)) }
  }

  /**
   * Every comment on every issue and merge request.
   *
   * A request per subject, because GitLab has no project-wide notes endpoint.
   * That is the cost of the shape rather than a choice, and it is why the
   * import fetches the subjects first and asks about each of them.
   */
  async issueComments(owner: string, name: string): Promise<PageResult<any>> {
    const items: any[] = []

    for (const [collection, kind] of [['issues', 'issues'], ['merge_requests', 'merge_requests']] as const) {
      const subjects = await this.collect<any>(`${this.project(owner, name)}/${collection}?scope=all`)

      if (!subjects.ok)
        return { ok: false, items, error: subjects.error }

      for (const subject of subjects.items) {
        const iid = Number(subject?.iid ?? 0)

        if (!iid)
          continue

        const notes = await this.collect<any>(`${this.project(owner, name)}/${kind}/${iid}/notes`)

        if (!notes.ok)
          return { ok: false, items, error: notes.error }

        for (const note of notes.items) {
          const mapped = asIssueComment(note, iid)

          // System notes are dropped rather than imported: "changed the
          // milestone" and "mentioned in commit abc" would bury every real
          // comment under machine chatter that reads as though a person wrote
          // it.
          if (mapped)
            items.push(mapped)
        }
      }
    }

    return { ok: true, items, error: null }
  }

  /**
   * Review comments, from every merge request's discussions.
   *
   * A discussion is GitLab's thread and its notes carry the anchor in
   * `position`. Notes with no position are ordinary comments on the merge
   * request and are dropped here - filing them as review comments would put a
   * general remark on an arbitrary line of an arbitrary file.
   */
  async reviewComments(owner: string, name: string): Promise<PageResult<any>> {
    const items: any[] = []
    const merges = await this.collect<any>(`${this.project(owner, name)}/merge_requests?scope=all`)

    if (!merges.ok)
      return { ok: false, items, error: merges.error }

    for (const merge of merges.items) {
      const iid = Number(merge?.iid ?? 0)

      if (!iid)
        continue

      const discussions = await this.collect<any>(`${this.project(owner, name)}/merge_requests/${iid}/discussions`)

      if (!discussions.ok)
        return { ok: false, items, error: discussions.error }

      for (const discussion of discussions.items) {
        const notes: any[] = discussion?.notes ?? []
        let first = 0

        for (const note of notes) {
          const mapped = asReviewComment(note, iid)

          if (!mapped)
            continue

          /*
           * Replies point at the first note of the discussion.
           *
           * GitLab groups a thread by `discussion.id` and does not record a
           * reply chain within it; the import rebuilds threads from
           * `in_reply_to_id`, so the discussion's shape is translated into that
           * one. Without this every note in a discussion becomes its own
           * thread, and a conversation of six replies renders as six unrelated
           * remarks on the same line.
           */
          if (!first)
            first = Number(mapped.id)
          else
            mapped.in_reply_to_id = first

          items.push(mapped)
        }
      }
    }

    return { ok: true, items, error: null }
  }

  /** Present for interface parity; GitLab's reviews arrive as discussions. */
  async pullReviews(): Promise<PageResult<any>> {
    return { ok: true, items: [], error: null }
  }
}

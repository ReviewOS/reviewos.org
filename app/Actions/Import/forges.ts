/**
 * The forges this instance can import from, and where they actually differ.
 *
 * Gitea and Forgejo implement GitHub's API shape closely enough that the same
 * client reads both: `/repos/{owner}/{name}/issues` returns issues with a
 * `number`, a `title`, a `state` and a `user`, paginated the same way. Forgejo
 * is a fork of Gitea and its API is deliberately compatible, so the two are one
 * entry here rather than two.
 *
 * **What this file exists for is the handful of places they do not match.** An
 * importer written as though they were identical works on the fixtures somebody
 * built it against and then loses data on a real instance - which is the worst
 * outcome, because the migration looks like it worked.
 *
 * The differences that matter:
 *
 * - **Review comments have no repository-wide endpoint.** GitHub has
 *   `/repos/{owner}/{name}/pulls/comments`; Gitea does not, so reviews come
 *   from `/repos/{owner}/{name}/pulls/{index}/reviews` per pull request. That
 *   is a different cost model, not a different field name.
 * - **A pull request is numbered `index`**, not `number`, and its issues appear
 *   under `/issues` with the same index - so the "a pull request is also an
 *   issue" rule holds, but the field to read does not.
 * - **The API lives under `/api/v1`**, not at the host root.
 * - **A token is `token abc`**, not `Bearer abc`.
 *
 * Nothing here guesses. Each of these was read off the API documentation and is
 * asserted in a test against a fixture that answers the Gitea shape, so a
 * difference that is wrong fails rather than silently importing nothing.
 */

export type ForgeKind = 'github' | 'gitea' | 'gitlab'

/** What a page of anything looks like, whichever forge answered. */
export interface SourcePage {
  ok: boolean
  items: any[]
  error: string | null
  truncated?: boolean
}

/**
 * What the import needs from a forge, and nothing else.
 *
 * Both clients satisfy this: `GitHubClient` speaks GitHub's API directly and
 * reaches Gitea with a base URL and an authorization form, and `GitLabClient`
 * translates a different vocabulary into the same answers. Naming the surface
 * here rather than typing the job's client as `any` is what makes a client that
 * stops satisfying it a compile error instead of a stage that returns nothing.
 */
export interface ImportSource {
  issues: (owner: string, name: string) => Promise<SourcePage>
  pulls: (owner: string, name: string) => Promise<SourcePage>
  labels: (owner: string, name: string) => Promise<SourcePage>
  milestones: (owner: string, name: string) => Promise<SourcePage>
  releases: (owner: string, name: string) => Promise<SourcePage>
  issueComments: (owner: string, name: string) => Promise<SourcePage>
  reviewComments: (owner: string, name: string, index?: number, reviewId?: number) => Promise<SourcePage>
  pullReviews: (owner: string, name: string, index: number) => Promise<SourcePage>
}

export interface ForgeShape {
  kind: ForgeKind
  /** What to call it when talking to a person. */
  label: string
  /** Appended to the host to reach the API. */
  apiPrefix: string
  /** How the token is presented. */
  authorization: (token: string) => string
  /** Whether review comments can be read for the whole repository at once. */
  hasRepositoryWideReviewComments: boolean
}

export const FORGES: Record<ForgeKind, ForgeShape> = {
  github: {
    kind: 'github',
    label: 'GitHub',
    apiPrefix: '',
    authorization: token => `Bearer ${token}`,
    hasRepositoryWideReviewComments: true,
  },
  /*
   * GitLab is not a variation on GitHub's API, it is a different vocabulary
   * for the same ideas - so it has an adapter rather than parameters, in
   * `gitlab-client.ts`. The entry here exists so the command can name it and
   * the base URL rule is written down in one place.
   */
  gitlab: {
    kind: 'gitlab',
    label: 'GitLab',
    apiPrefix: '/api/v4',
    // A personal access token from the settings page. GitLab also takes
    // `Bearer` for an OAuth token, and the wrong one is answered as
    // unauthenticated rather than rejected.
    authorization: token => token,
    hasRepositoryWideReviewComments: true,
  },
  gitea: {
    kind: 'gitea',
    label: 'Gitea or Forgejo',
    apiPrefix: '/api/v1',
    // Gitea accepts `token <value>`; it also accepts `Bearer` for OAuth2
    // tokens, and `token` is what an access token from the settings page is.
    authorization: token => `token ${token}`,
    hasRepositoryWideReviewComments: false,
  },
}

/**
 * The number a pull request has, whichever forge it came from.
 *
 * GitHub calls it `number` and Gitea calls it `index`, and they mean the same
 * thing: the number in the URL, the number in `#123`, and the number this
 * import preserves. Reading the wrong one gives `undefined`, which becomes
 * `NaN`, which becomes a pull request numbered zero - and the failure is
 * silent, because a zero is a number.
 */
export function pullNumber(raw: unknown): number {
  const record = raw as Record<string, unknown> | null
  const value = Number(record?.number ?? record?.index ?? 0)

  return Number.isFinite(value) && value > 0 ? value : 0
}

/**
 * Where an instance's API lives, from whatever somebody pasted.
 *
 * People paste the address of the web interface, because that is the address
 * they know. `https://codeberg.org` and `https://codeberg.org/` and
 * `https://codeberg.org/api/v1` all have to mean the same thing, or the first
 * thing an operator sees is a 404 from a path they did not type.
 */
export function apiBase(host: string, kind: ForgeKind): string {
  const trimmed = String(host ?? '').trim().replace(/\/+$/, '')
  const prefix = FORGES[kind].apiPrefix

  if (!trimmed)
    return prefix

  // Already pointed at the API. Appending again would produce
  // `/api/v1/api/v1`, which answers 404 and reads as "the importer is broken".
  if (prefix && trimmed.endsWith(prefix))
    return trimmed

  return `${trimmed}${prefix}`
}

/**
 * The forge a host is, guessed only where the guess is certain.
 *
 * `github.com` is GitHub. Everything else has to be said, because a
 * self-hosted instance at `git.example.com` could be any of them, and guessing
 * wrong produces an import that fetches nothing and reports success on an empty
 * repository.
 */
export function forgeFor(host: string): ForgeKind | null {
  const lowered = String(host ?? '').toLowerCase()

  if (!lowered || lowered.includes('github.com'))
    return 'github'

  return null
}

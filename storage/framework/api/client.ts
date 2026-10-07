/* eslint-disable */
/**
 * Stacks API client, generated from the OpenAPI document.
 *
 * Do not edit. Run `buddy generate:openapi` to rebuild it from the routes.
 *
 * No imports and no dependencies: copy this file anywhere that has `fetch`.
 */

/** Every call answers with one of these. Nothing here throws for a 4xx. */
export type ApiResult<T> =
  | { ok: true, status: number, data: T, headers: Headers }
  | { ok: false, status: number, error: unknown, headers: Headers }

export interface ClientConfig {
  /** Where the API lives, e.g. `https://example.com`. No trailing slash needed. */
  baseUrl: string
  /** Sent as `Authorization: Bearer …` when present. */
  token?: string
  /** Extra headers on every request. */
  headers?: Record<string, string>
  /** Swap in a different fetch - a test double, or one that retries. */
  fetch?: typeof fetch
}

export interface RequestOptions {
  /** Abort in flight. */
  signal?: AbortSignal
  /** Headers for this call only, merged over the client's. */
  headers?: Record<string, string>
}

function buildUrl(config: ClientConfig, route: string, input: Record<string, unknown>, query: string[]): string {
  // Path parameters are substituted, never appended: a `{id}` left in the URL
  // is a 404 whose message is about the literal string "{id}".
  const filled = route.replace(/\{(\w+)\}/g, (_, key: string) => encodeURIComponent(String(input[key] ?? '')))
  const url = new URL(filled.replace(/^\/+/, '/'), config.baseUrl.endsWith('/') ? config.baseUrl : `${config.baseUrl}/`)

  for (const key of query) {
    const value = input[key]
    // Absent means absent. Sending `?path=` asks for the file called empty
    // string, which is a different question from not filtering.
    if (value === undefined || value === null) continue
    url.searchParams.set(key, String(value))
  }

  return url.toString()
}

async function request<T>(
  config: ClientConfig,
  method: string,
  route: string,
  input: Record<string, unknown>,
  query: string[],
  hasBody: boolean,
  options?: RequestOptions,
): Promise<ApiResult<T>> {
  const call = config.fetch ?? fetch
  const url = buildUrl(config, route, input, query)

  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...(config.headers ?? {}),
    ...(options?.headers ?? {}),
  }
  if (config.token) headers.Authorization = `Bearer ${config.token}`

  const body = hasBody && input.body !== undefined ? JSON.stringify(input.body) : undefined
  if (body !== undefined) headers['Content-Type'] = 'application/json'

  const response = await call(url, { method, headers, body, signal: options?.signal })

  const text = await response.text()
  let parsed: unknown = text
  if (text.length) {
    // A non-JSON body is kept verbatim rather than replaced with a parse error.
    // An endpoint that answered with HTML is worth seeing.
    try { parsed = JSON.parse(text) } catch { parsed = text }
  }
  else {
    parsed = null
  }

  return response.ok
    ? { ok: true, status: response.status, data: parsed as T, headers: response.headers }
    : { ok: false, status: response.status, error: parsed, headers: response.headers }
}

export function createClient(config: ClientConfig) {
  return {
    /** The configuration in use, so a caller can rebuild a variant of it. */
    config,

  /**
   * GET /.well-known/jwks.json
   */
  getWellKnownJwksJson(options?: RequestOptions): Promise<ApiResult<{ "keys"?: Array<Record<string, unknown>> }>> {
    return request(config, "GET", "/.well-known/jwks.json", {}, [], false, options)
  },

  /**
   * GET /.well-known/openid-configuration
   */
  getWellKnownOpenidConfiguration(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/.well-known/openid-configuration", {}, [], false, options)
  },

  /**
   * GET /.well-known/reviewos-step-keys.json
   */
  getWellKnownReviewosStepKeysJson(options?: RequestOptions): Promise<ApiResult<{ "keys"?: Array<Record<string, unknown>> }>> {
    return request(config, "GET", "/.well-known/reviewos-step-keys.json", {}, [], false, options)
  },

  /**
   * GET /_pages/*
   */
  getPages(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/_pages/*", {}, [], false, options)
  },

  /**
   * POST /actions/{host}/{owner}/{repository}/git-upload-pack
   */
  postActionsHostOwnerRepositoryGitUploadPack(input: { "host": string; "owner": string; "repository": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/actions/{host}/{owner}/{repository}/git-upload-pack", input ?? {}, [], false, options)
  },

  /**
   * GET /actions/{host}/{owner}/{repository}/info/refs
   */
  getActionsHostOwnerRepositoryInfoRefs(input: { "host": string; "owner": string; "repository": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/actions/{host}/{owner}/{repository}/info/refs", input ?? {}, [], false, options)
  },

  /**
   * GET /api/audit
   */
  getAudit(input?: { "organization_id"?: number; "actor_id"?: number; "owner"?: string; "repo"?: string; "action"?: string; "since"?: string; "until"?: string; "limit"?: number; "before"?: number; "format"?: "json" | "jsonl" }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/audit", input ?? {}, ["organization_id", "actor_id", "owner", "repo", "action", "since", "until", "limit", "before", "format"], false, options)
  },

  /**
   * POST /api/auth/atproto
   */
  postAuthAtproto(input: { body: { "identifier": string } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/auth/atproto", input ?? {}, [], true, options)
  },

  /**
   * GET /api/auth/atproto/callback
   */
  getAuthAtprotoCallback(input?: { "state"?: string; "code"?: string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/auth/atproto/callback", input ?? {}, ["state", "code"], false, options)
  },

  /**
   * POST /api/auth/login
   */
  postAuthLogin(input?: { body?: { "code"?: string; "email"?: string; "next"?: string; "passkey"?: string; "password"?: string } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/auth/login", input ?? {}, [], true, options)
  },

  /**
   * POST /api/auth/logout
   */
  postAuthLogout(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/auth/logout", {}, [], false, options)
  },

  /**
   * POST /api/auth/password/reset
   */
  postAuthPasswordReset(input?: { body?: { "email"?: string; "operation"?: string; "password"?: string; "token"?: string } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/auth/password/reset", input ?? {}, [], true, options)
  },

  /**
   * POST /api/auth/register
   */
  postAuthRegister(input?: { body?: { "email"?: string; "handle"?: string; "name"?: string; "next"?: string; "password"?: string } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/auth/register", input ?? {}, [], true, options)
  },

  /**
   * GET /api/auth/sso
   */
  getAuthSso(input?: { "code"?: string; "next"?: string; "state"?: string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/auth/sso", input ?? {}, ["code", "next", "state"], false, options)
  },

  /**
   * GET /api/auth/verify
   */
  getAuthVerify(input?: { "id"?: number; "token"?: string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/auth/verify", input ?? {}, ["id", "token"], false, options)
  },

  /**
   * POST /api/auth/verify/resend
   */
  postAuthVerifyResend(input?: { body?: { "id"?: number; "token"?: string } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/auth/verify/resend", input ?? {}, [], true, options)
  },

  /**
   * GET /api/auth/{provider}
   */
  getAuthProvider(input: { "provider": string; "next"?: string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/auth/{provider}", input ?? {}, ["next"], false, options)
  },

  /**
   * GET /api/auth/{provider}/callback
   */
  getAuthProviderCallback(input: { "provider": string; "code"?: string; "state"?: string; "error"?: string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/auth/{provider}/callback", input ?? {}, ["code", "state", "error"], false, options)
  },

  /**
   * POST /api/auth/{provider}/callback
   */
  postAuthProviderCallback(input: { "provider": string; body?: { "code"?: string; "state"?: string; "error"?: string } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/auth/{provider}/callback", input ?? {}, [], true, options)
  },

  /**
   * GET /api/discover
   */
  getDiscover(input?: { "before"?: number }, options?: RequestOptions): Promise<ApiResult<{ "entries"?: Array<Record<string, unknown>>; "cursor"?: number }>> {
    return request(config, "GET", "/api/discover", input ?? {}, ["before"], false, options)
  },

  /**
   * GET /api/explore
   */
  getExplore(input?: { "topic"?: string; "language"?: string; "days"?: number }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/explore", input ?? {}, ["topic", "language", "days"], false, options)
  },

  /**
   * GET /api/featured
   */
  getFeatured(input?: { "limit"?: number }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/featured", input ?? {}, ["limit"], false, options)
  },

  /**
   * GET /api/feed
   */
  getFeed(input?: { "before"?: unknown }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/feed", input ?? {}, ["before"], false, options)
  },

  /**
   * POST /api/gh/repos/{owner}/{repo}/issues/{number}/comments
   */
  postGhReposOwnerRepoIssuesNumberComments(input: { "owner": string; "repo": string; "number": string; body?: { "owner"?: string; "repo"?: string; "resource"?: string; "sha"?: string; "number"?: number } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/gh/repos/{owner}/{repo}/issues/{number}/comments", input ?? {}, [], true, options)
  },

  /**
   * POST /api/gh/repos/{owner}/{repo}/statuses/{sha}
   */
  postGhReposOwnerRepoStatusesSha(input: { "owner": string; "repo": string; "sha": string; body?: { "owner"?: string; "repo"?: string; "resource"?: string; "sha"?: string; "number"?: number } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/gh/repos/{owner}/{repo}/statuses/{sha}", input ?? {}, [], true, options)
  },

  /**
   * POST /api/gh/repos/{owner}/{repo}/{resource}
   */
  postGhReposOwnerRepoResource(input: { "owner": string; "repo": string; "resource": string; body?: { "owner"?: string; "repo"?: string; "resource"?: string; "sha"?: string; "number"?: number } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/gh/repos/{owner}/{repo}/{resource}", input ?? {}, [], true, options)
  },

  /**
   * GET /api/health
   */
  getHealth(input?: { "quick"?: string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/health", input ?? {}, ["quick"], false, options)
  },

  /**
   * GET /api/insight
   */
  getInsight(input?: { "owner"?: string; "repo"?: string; "days"?: number }, options?: RequestOptions): Promise<ApiResult<{ "window"?: { "days"?: number; "from"?: string; "to"?: string }; "overall"?: { "workflow"?: string; "path"?: string; "runs"?: number; "success_rate"?: number; "p50_ms"?: number; "p95_ms"?: number; "retry_rate"?: number; "samples"?: number }; "workflows"?: Array<{ "workflow"?: string; "path"?: string; "runs"?: number; "success_rate"?: number; "p50_ms"?: number; "p95_ms"?: number; "retry_rate"?: number; "samples"?: number }>; "failures_by_job"?: Array<{ "name"?: string; "failures"?: number; "runs"?: number }>; "wait"?: Array<{ "queue"?: string; "pool"?: string; "samples"?: number; "p50_ms"?: number; "p95_ms"?: number }>; "runners"?: Array<{ "runner"?: string; "busy_ms"?: number; "utilization"?: number; "idle_ms"?: number }>; "cost"?: { "repositories"?: Array<Record<string, unknown>>; "owners"?: Array<Record<string, unknown>>; "queues"?: Array<Record<string, unknown>> }; "flaky"?: { "runs_failed_by_known_flaky"?: number; "failed_runs"?: number; "share"?: number } }>> {
    return request(config, "GET", "/api/insight", input ?? {}, ["owner", "repo", "days"], false, options)
  },

  /**
   * POST /api/instance/admin
   */
  postInstanceAdmin(input?: { body?: { "operation"?: "stats" | "users" | "repositories" | "queue" | "promote" | "demote" | "retry-job" | "deprovision"; "handle"?: string; "search"?: string; "id"?: number; "limit"?: number } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/instance/admin", input ?? {}, [], true, options)
  },

  /**
   * POST /api/instance/fleet
   */
  postInstanceFleet(input?: { body?: { "operation"?: "list" | "create-pool" | "create-queue" | "pause-queue" | "resume-queue" | "require-signatures" | "attach-plugin" | "detach-plugin" | "plugin-policy" | "assign-repository" | "unassign-repository" | "assign-runner" | "stop-runner" | "create-runner" | "create-token" | "revoke-token" | "add-maintainer" | "remove-maintainer" | "set-secret" | "unset-secret" | "list-secrets"; "name"?: string; "slug"?: string; "labels"?: string; "reason"?: string; "pool"?: number; "queue"?: number; "runner"?: number; "repository"?: number; "force"?: boolean; "required"?: boolean; "plugin"?: string; "allowlist"?: string; "capabilities"?: string; "pinned"?: boolean; "token"?: number; "expires"?: string; "user"?: number; "key"?: string; "value"?: string } }, options?: RequestOptions): Promise<ApiResult<unknown>> {
    return request(config, "POST", "/api/instance/fleet", input ?? {}, [], true, options)
  },

  /**
   * POST /api/instance/settings
   */
  postInstanceSettings(input?: { body?: { "key"?: string; "value"?: string } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/instance/settings", input ?? {}, [], true, options)
  },

  /**
   * POST /api/mcp
   */
  postMcp(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/mcp", {}, [], false, options)
  },

  /**
   * GET /api/metrics
   */
  getMetrics(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/metrics", {}, [], false, options)
  },

  /**
   * POST /api/mirrors/sync
   */
  postMirrorsSync(input?: { body?: { "owner"?: string; "repo"?: string } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/mirrors/sync", input ?? {}, [], true, options)
  },

  /**
   * POST /api/mirrors/webhook
   */
  postMirrorsWebhook(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/mirrors/webhook", {}, [], false, options)
  },

  /**
   * GET /api/notification-deliveries
   */
  getNotificationDeliveries(options?: RequestOptions): Promise<ApiResult<{ "data": Array<{ "id": number; "channel": "email" | "sms" | "chat" | "database" | "push" | "broadcast"; "recipient": string; "subject"?: string; "body": string; "status": "pending" | "sent" | "delivered" | "failed" | "skipped"; "error"?: string; "metadata"?: string; "sent_at"?: unknown; "created_at"?: string; "updated_at"?: string }> }>> {
    return request(config, "GET", "/api/notification-deliveries", {}, [], false, options)
  },

  /**
   * GET /api/notification-deliveries/{id}
   */
  getNotificationDeliveriesId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "channel": "email" | "sms" | "chat" | "database" | "push" | "broadcast"; "recipient": string; "subject"?: string; "body": string; "status": "pending" | "sent" | "delivered" | "failed" | "skipped"; "error"?: string; "metadata"?: string; "sent_at"?: unknown; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "GET", "/api/notification-deliveries/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/notifications
   */
  getNotifications(options?: RequestOptions): Promise<ApiResult<{ "data": Array<{ "id": number; "uuid": string; "type": string; "data": string; "read_at"?: unknown; "created_at"?: string; "updated_at"?: string }> }>> {
    return request(config, "GET", "/api/notifications", {}, [], false, options)
  },

  /**
   * GET /api/notifications/{id}
   */
  getNotificationsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "type": string; "data": string; "read_at"?: unknown; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "GET", "/api/notifications/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/og
   */
  getOg(input?: { "path"?: string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/og", input ?? {}, ["path"], false, options)
  },

  /**
   * GET /api/openapi.json
   */
  getOpenapiJson(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/openapi.json", {}, [], false, options)
  },

  /**
   * GET /api/operations/{id}
   */
  getOperationsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/operations/{id}", input ?? {}, [], false, options)
  },

  /**
   * POST /api/operations/{id}/cancel
   */
  postOperationsIdCancel(input: { "id": string; body?: { "id"?: unknown } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/operations/{id}/cancel", input ?? {}, [], true, options)
  },

  /**
   * PUT /api/orgs
   */
  putOrgs(input?: { body?: { "handle"?: string; "organization_id"?: unknown } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "PUT", "/api/orgs", input ?? {}, [], true, options)
  },

  /**
   * POST /api/orgs
   */
  postOrgs(input?: { body?: { "billing_email"?: string; "description"?: string; "handle"?: string; "name"?: string } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/orgs", input ?? {}, [], true, options)
  },

  /**
   * DELETE /api/orgs
   */
  deleteOrgs(input?: { "confirm"?: string; "organization_id"?: unknown }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "DELETE", "/api/orgs", input ?? {}, ["confirm", "organization_id"], false, options)
  },

  /**
   * POST /api/orgs/delete
   */
  postOrgsDelete(input?: { body?: { "confirm"?: string; "organization_id"?: unknown } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/orgs/delete", input ?? {}, [], true, options)
  },

  /**
   * POST /api/orgs/machine-accounts
   */
  postOrgsMachineAccounts(input?: { body?: { "handle"?: string; "name"?: string; "organization_id"?: unknown } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/orgs/machine-accounts", input ?? {}, [], true, options)
  },

  /**
   * POST /api/orgs/members
   */
  postOrgsMembers(input?: { body?: { "handle"?: string; "organization_id"?: unknown; "role"?: string } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/orgs/members", input ?? {}, [], true, options)
  },

  /**
   * DELETE /api/orgs/members
   */
  deleteOrgsMembers(input?: { "organization_id"?: unknown; "user_id"?: number }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "DELETE", "/api/orgs/members", input ?? {}, ["organization_id", "user_id"], false, options)
  },

  /**
   * POST /api/orgs/members/accept
   */
  postOrgsMembersAccept(input?: { body?: { "operation"?: string; "organization_id"?: unknown } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/orgs/members/accept", input ?? {}, [], true, options)
  },

  /**
   * POST /api/orgs/members/remove
   */
  postOrgsMembersRemove(input?: { body?: { "organization_id"?: unknown; "user_id"?: number } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/orgs/members/remove", input ?? {}, [], true, options)
  },

  /**
   * PUT /api/orgs/members/role
   */
  putOrgsMembersRole(input?: { body?: { "organization_id"?: unknown; "role"?: string; "user_id"?: number } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "PUT", "/api/orgs/members/role", input ?? {}, [], true, options)
  },

  /**
   * POST /api/orgs/members/role
   */
  postOrgsMembersRole(input?: { body?: { "organization_id"?: unknown; "role"?: string; "user_id"?: number } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/orgs/members/role", input ?? {}, [], true, options)
  },

  /**
   * POST /api/orgs/teams
   */
  postOrgsTeams(input?: { body?: { "description"?: string; "name"?: string; "operation"?: string; "organization_id"?: unknown; "parent_team_id"?: unknown; "slug"?: string; "team_id"?: unknown } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/orgs/teams", input ?? {}, [], true, options)
  },

  /**
   * POST /api/orgs/teams/members
   */
  postOrgsTeamsMembers(input?: { body?: { "operation"?: string; "role"?: string; "team_id"?: unknown; "user_id"?: number } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/orgs/teams/members", input ?? {}, [], true, options)
  },

  /**
   * GET /api/orgs/tokens
   */
  getOrgsTokens(input?: { "organization_id"?: unknown }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/orgs/tokens", input ?? {}, ["organization_id"], false, options)
  },

  /**
   * POST /api/orgs/update
   */
  postOrgsUpdate(input?: { body?: { "handle"?: string; "organization_id"?: unknown } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/orgs/update", input ?? {}, [], true, options)
  },

  /**
   * GET /api/owners
   */
  getOwners(input: { "owner": string; "q"?: string; "page"?: number; "per_page"?: number }, options?: RequestOptions): Promise<ApiResult<unknown>> {
    return request(config, "GET", "/api/owners", input ?? {}, ["owner", "q", "page", "per_page"], false, options)
  },

  /**
   * GET /api/releases
   */
  getReleases(options?: RequestOptions): Promise<ApiResult<{ "data": Array<{ "id": number; "uuid": string; "version"?: string; "type"?: string; "status"?: string; "notes"?: string; "downloads"?: number; "author"?: string; "repository_id"?: number; "user_id"?: number; "tag_name"?: string; "target_sha"?: string; "name"?: string; "is_prerelease"?: boolean; "published_at"?: string; "created_at"?: string; "updated_at"?: string }> }>> {
    return request(config, "GET", "/api/releases", {}, [], false, options)
  },

  /**
   * GET /api/releases/{id}
   */
  getReleasesId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "version"?: string; "type"?: string; "status"?: string; "notes"?: string; "downloads"?: number; "author"?: string; "repository_id"?: number; "user_id"?: number; "tag_name"?: string; "target_sha"?: string; "name"?: string; "is_prerelease"?: boolean; "published_at"?: string; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "GET", "/api/releases/{id}", input ?? {}, [], false, options)
  },

  /**
   * PUT /api/repos
   */
  putRepos(input?: { body?: { "owner"?: string; "repo"?: string; "allow_merge_commit"?: unknown; "allow_rebase_merge"?: unknown; "allow_squash_merge"?: unknown; "default_branch"?: string; "default_merge_strategy"?: string; "delete_branch_on_merge"?: unknown; "description"?: string; "homepage"?: string; "is_archived"?: unknown; "is_template"?: unknown; "name"?: string; "visibility"?: string } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "PUT", "/api/repos", input ?? {}, [], true, options)
  },

  /**
   * POST /api/repos
   */
  postRepos(input?: { body?: { "owner"?: string; "default_branch"?: string; "description"?: string; "gitignore"?: string; "host"?: string; "license"?: string; "license_holder"?: string; "name"?: string; "readme"?: unknown; "visibility"?: string } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/repos", input ?? {}, [], true, options)
  },

  /**
   * DELETE /api/repos
   */
  deleteRepos(input: { "owner": string; "repo"?: string; "repository"?: string; "confirm"?: string }, options?: RequestOptions): Promise<ApiResult<unknown>> {
    return request(config, "DELETE", "/api/repos", input ?? {}, ["owner", "repo", "repository", "confirm"], false, options)
  },

  /**
   * GET /api/repos/archive
   */
  getReposArchive(input?: { "owner"?: string; "repo"?: string; "format"?: string; "ref"?: string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/repos/archive", input ?? {}, ["owner", "repo", "format", "ref"], false, options)
  },

  /**
   * POST /api/repos/attachments
   */
  postReposAttachments(input?: { body?: { "owner"?: string; "repo"?: string } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/repos/attachments", input ?? {}, [], true, options)
  },

  /**
   * GET /api/repos/badge
   */
  getReposBadge(input?: { "owner"?: string; "repo"?: string; "workflow"?: string; "branch"?: string; "label"?: string }, options?: RequestOptions): Promise<ApiResult<unknown>> {
    return request(config, "GET", "/api/repos/badge", input ?? {}, ["owner", "repo", "workflow", "branch", "label"], false, options)
  },

  /**
   * GET /api/repos/blame
   */
  getReposBlame(input?: { "owner"?: string; "repo"?: string; "limit"?: number; "path"?: string; "ref"?: string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/repos/blame", input ?? {}, ["owner", "repo", "limit", "path", "ref"], false, options)
  },

  /**
   * GET /api/repos/blob
   */
  getReposBlob(input?: { "owner"?: string; "repo"?: string; "path"?: string; "ref"?: string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/repos/blob", input ?? {}, ["owner", "repo", "path", "ref"], false, options)
  },

  /**
   * GET /api/repos/blob/rows
   */
  getReposBlobRows(input?: { "owner"?: string; "repo"?: string; "count"?: number; "from"?: unknown; "path"?: string; "ref"?: string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/repos/blob/rows", input ?? {}, ["owner", "repo", "count", "from", "path", "ref"], false, options)
  },

  /**
   * GET /api/repos/branches
   */
  getReposBranches(input?: { "owner"?: string; "repo"?: string; "ref"?: string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/repos/branches", input ?? {}, ["owner", "repo", "ref"], false, options)
  },

  /**
   * GET /api/repos/checks
   */
  getReposChecks(input: { "owner": string; "repository"?: string; "sha"?: string; "number"?: number }, options?: RequestOptions): Promise<ApiResult<{ "sha"?: string; "state"?: "success" | "failure" | "pending" | "neutral"; "counts"?: Record<string, unknown>; "statuses"?: Array<Record<string, unknown>>; "check_runs"?: Array<Record<string, unknown>> }>> {
    return request(config, "GET", "/api/repos/checks", input ?? {}, ["owner", "repository", "sha", "number"], false, options)
  },

  /**
   * POST /api/repos/checks
   */
  postReposChecks(input: { body: { "owner": string; "repository"?: string; "sha": string; "kind"?: "status" | "check_run" } }, options?: RequestOptions): Promise<ApiResult<{ "id"?: number; "name"?: string; "status"?: "queued" | "in_progress" | "completed"; "conclusion"?: string; "ignored"?: string }>> {
    return request(config, "POST", "/api/repos/checks", input ?? {}, [], true, options)
  },

  /**
   * POST /api/repos/collaborators
   */
  postReposCollaborators(input?: { body?: { "owner"?: string; "repo"?: string; "handle"?: string; "operation"?: string; "permission"?: string } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/repos/collaborators", input ?? {}, [], true, options)
  },

  /**
   * GET /api/repos/commit
   */
  getReposCommit(input?: { "owner"?: string; "repo"?: string; "ref"?: string; "sha"?: string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/repos/commit", input ?? {}, ["owner", "repo", "ref", "sha"], false, options)
  },

  /**
   * GET /api/repos/commits
   */
  getReposCommits(input?: { "owner"?: string; "repo"?: string; "before"?: string; "limit"?: number; "path"?: string; "ref"?: string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/repos/commits", input ?? {}, ["owner", "repo", "before", "limit", "path", "ref"], false, options)
  },

  /**
   * GET /api/repos/compare
   */
  getReposCompare(input?: { "owner"?: string; "repo"?: string; "base"?: string; "head"?: string; "ref"?: string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/repos/compare", input ?? {}, ["owner", "repo", "base", "head", "ref"], false, options)
  },

  /**
   * POST /api/repos/coverage
   */
  postReposCoverage(input: { body: { "owner": string; "repo"?: string; "repository"?: string; "sha": string; "lcov"?: string } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/repos/coverage", input ?? {}, [], true, options)
  },

  /**
   * POST /api/repos/delete
   */
  postReposDelete(input: { body: { "owner": string; "repo"?: string; "repository"?: string; "confirm"?: string } }, options?: RequestOptions): Promise<ApiResult<unknown>> {
    return request(config, "POST", "/api/repos/delete", input ?? {}, [], true, options)
  },

  /**
   * POST /api/repos/deploy-keys
   */
  postReposDeployKeys(input?: { body?: { "owner"?: string; "repo"?: string; "can_write"?: string; "id"?: number; "key"?: string; "operation"?: string; "title"?: string } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/repos/deploy-keys", input ?? {}, [], true, options)
  },

  /**
   * POST /api/repos/deployments
   */
  postReposDeployments(input?: { body?: { "owner"?: string; "repo"?: string; "operation"?: "list" | "create" | "update" | "deactivate" | "rollback" | "history" | "health" | "hold" | "resume"; "environment"?: string; "sha"?: string; "ref"?: string; "url"?: string; "state"?: "in_progress" | "active" | "failed" | "inactive"; "description"?: string; "stages"?: string; "health"?: string; "pull_request"?: number; "run"?: number; "reason"?: string; "id"?: number; "limit"?: number } }, options?: RequestOptions): Promise<ApiResult<unknown>> {
    return request(config, "POST", "/api/repos/deployments", input ?? {}, [], true, options)
  },

  /**
   * POST /api/repos/dispatches
   */
  postReposDispatches(input?: { body?: { "owner"?: string; "repo"?: string; "event_type"?: string } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/repos/dispatches", input ?? {}, [], true, options)
  },

  /**
   * POST /api/repos/environments
   */
  postReposEnvironments(input?: { body?: { "owner"?: string; "repo"?: string; "operation"?: "list" | "create" | "update" | "delete" | "add-reviewer" | "remove-reviewer"; "name"?: string; "wait_minutes"?: number; "require_checks"?: boolean; "branches"?: string; "description"?: string; "reviewer"?: string } }, options?: RequestOptions): Promise<ApiResult<unknown>> {
    return request(config, "POST", "/api/repos/environments", input ?? {}, [], true, options)
  },

  /**
   * POST /api/repos/forks
   */
  postReposForks(input: { body: { "owner": string; "repo"?: string; "repository"?: string; "to"?: string } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/repos/forks", input ?? {}, [], true, options)
  },

  /**
   * GET /api/repos/issues
   */
  getReposIssues(input: { "owner": string; "repo"?: string; "repository"?: string; "state"?: "open" | "closed" | "all"; "sort"?: "created" | "updated" | "comments"; "direction"?: "asc" | "desc"; "labels"?: string; "label"?: string; "assignee"?: string; "author"?: string; "milestone"?: string; "q"?: string; "search"?: string; "limit"?: number; "cursor"?: string }, options?: RequestOptions): Promise<ApiResult<unknown>> {
    return request(config, "GET", "/api/repos/issues", input ?? {}, ["owner", "repo", "repository", "state", "sort", "direction", "labels", "label", "assignee", "author", "milestone", "q", "search", "limit", "cursor"], false, options)
  },

  /**
   * PUT /api/repos/issues
   */
  putReposIssues(input?: { body?: { "owner"?: string; "repo"?: string; "number"?: number; "body"?: string; "title"?: string } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "PUT", "/api/repos/issues", input ?? {}, [], true, options)
  },

  /**
   * POST /api/repos/issues
   */
  postReposIssues(input: { body: { "owner": string; "repo"?: string; "repository"?: string; "title": string; "body"?: string; "labels"?: Array<unknown>; "milestone_id"?: number } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/repos/issues", input ?? {}, [], true, options)
  },

  /**
   * PUT /api/repos/issues/assignees
   */
  putReposIssuesAssignees(input: { body: { "owner": string; "repo"?: string; "repository"?: string; "number": number; "assignees"?: Array<unknown> } }, options?: RequestOptions): Promise<ApiResult<unknown>> {
    return request(config, "PUT", "/api/repos/issues/assignees", input ?? {}, [], true, options)
  },

  /**
   * POST /api/repos/issues/bulk
   */
  postReposIssuesBulk(input?: { body?: { "owner"?: string; "repo"?: string; "label"?: string; "milestone_id"?: number; "numbers"?: string; "operation"?: string } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/repos/issues/bulk", input ?? {}, [], true, options)
  },

  /**
   * PUT /api/repos/issues/comments
   */
  putReposIssuesComments(input?: { body?: { "owner"?: string; "repo"?: string; "body"?: string; "comment_id"?: unknown } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "PUT", "/api/repos/issues/comments", input ?? {}, [], true, options)
  },

  /**
   * POST /api/repos/issues/comments
   */
  postReposIssuesComments(input: { body: { "owner": string; "repo"?: string; "repository"?: string; "number": number; "body": string } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/repos/issues/comments", input ?? {}, [], true, options)
  },

  /**
   * DELETE /api/repos/issues/comments
   */
  deleteReposIssuesComments(input?: { "owner"?: string; "repo"?: string; "comment_id"?: unknown }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "DELETE", "/api/repos/issues/comments", input ?? {}, ["owner", "repo", "comment_id"], false, options)
  },

  /**
   * PUT /api/repos/issues/labels
   */
  putReposIssuesLabels(input: { body: { "owner": string; "repo"?: string; "repository"?: string; "number": number; "labels"?: Array<unknown> } }, options?: RequestOptions): Promise<ApiResult<unknown>> {
    return request(config, "PUT", "/api/repos/issues/labels", input ?? {}, [], true, options)
  },

  /**
   * PUT /api/repos/issues/lock
   */
  putReposIssuesLock(input: { body: { "owner": string; "repo"?: string; "repository"?: string; "number": number; "locked"?: boolean } }, options?: RequestOptions): Promise<ApiResult<unknown>> {
    return request(config, "PUT", "/api/repos/issues/lock", input ?? {}, [], true, options)
  },

  /**
   * PUT /api/repos/issues/milestone
   */
  putReposIssuesMilestone(input?: { body?: { "owner"?: string; "repo"?: string; "number"?: number; "milestone"?: string } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "PUT", "/api/repos/issues/milestone", input ?? {}, [], true, options)
  },

  /**
   * POST /api/repos/issues/reactions
   */
  postReposIssuesReactions(input?: { body?: { "owner"?: string; "repo"?: string; "number"?: number; "comment_id"?: unknown; "content"?: string } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/repos/issues/reactions", input ?? {}, [], true, options)
  },

  /**
   * PUT /api/repos/issues/state
   */
  putReposIssuesState(input?: { body?: { "owner"?: string; "repo"?: string; "number"?: number; "reason"?: string; "state"?: string } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "PUT", "/api/repos/issues/state", input ?? {}, [], true, options)
  },

  /**
   * PUT /api/repos/issues/tasks
   */
  putReposIssuesTasks(input?: { body?: { "owner"?: string; "repo"?: string; "number"?: number; "checked"?: string; "comment_id"?: unknown; "expected"?: string; "index"?: unknown } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "PUT", "/api/repos/issues/tasks", input ?? {}, [], true, options)
  },

  /**
   * POST /api/repos/labels
   */
  postReposLabels(input?: { body?: { "owner"?: string; "repo"?: string; "color"?: string; "description"?: string; "id"?: number; "name"?: string; "operation"?: string } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/repos/labels", input ?? {}, [], true, options)
  },

  /**
   * GET /api/repos/media
   */
  getReposMedia(input: { "owner": string; "repo"?: string; "repository"?: string; "ref"?: string; "path": string }, options?: RequestOptions): Promise<ApiResult<unknown>> {
    return request(config, "GET", "/api/repos/media", input ?? {}, ["owner", "repo", "repository", "ref", "path"], false, options)
  },

  /**
   * POST /api/repos/milestones
   */
  postReposMilestones(input?: { body?: { "owner"?: string; "repo"?: string; "description"?: string; "due_on"?: string; "id"?: number; "operation"?: string; "title"?: string } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/repos/milestones", input ?? {}, [], true, options)
  },

  /**
   * POST /api/repos/pages
   */
  postReposPages(input?: { body?: { "owner"?: string; "repo"?: string; "operation"?: "show" | "update"; "enabled"?: boolean; "source_branch"?: string; "domain"?: string; "visibility"?: "public" | "repository" } }, options?: RequestOptions): Promise<ApiResult<unknown>> {
    return request(config, "POST", "/api/repos/pages", input ?? {}, [], true, options)
  },

  /**
   * POST /api/repos/protected-branches
   */
  postReposProtectedBranches(input?: { body?: { "owner"?: string; "repo"?: string; "operation"?: string; "pattern"?: string; "allow_deletion"?: unknown; "allow_force_push"?: unknown; "dismiss_stale_reviews"?: unknown; "require_conversation_resolution"?: unknown; "require_human_approval_for_agents"?: unknown; "require_linear_history"?: unknown; "required_approvals"?: unknown; "required_checks"?: unknown; "require_up_to_date"?: unknown; "enforce_admins"?: unknown; "push_restrictions"?: unknown; "push_restrictions_users"?: unknown; "push_restrictions_teams"?: unknown } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/repos/protected-branches", input ?? {}, [], true, options)
  },

  /**
   * GET /api/repos/pulls
   */
  getReposPulls(input?: { "owner"?: string; "repo"?: string; "state"?: "open" | "closed" | "merged" | "all"; "author"?: string; "base"?: string; "per_page"?: number; "cursor"?: string; "fields"?: string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/repos/pulls", input ?? {}, ["owner", "repo", "state", "author", "base", "per_page", "cursor", "fields"], false, options)
  },

  /**
   * PUT /api/repos/pulls
   */
  putReposPulls(input?: { body?: { "owner"?: string; "repo"?: string; "number"?: number } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "PUT", "/api/repos/pulls", input ?? {}, [], true, options)
  },

  /**
   * POST /api/repos/pulls
   */
  postReposPulls(input: { body: { "owner": string; "repo"?: string; "repository"?: string; "title": string; "head": string; "base"?: string; "body"?: string; "draft"?: boolean } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/repos/pulls", input ?? {}, [], true, options)
  },

  /**
   * POST /api/repos/pulls/auto-merge
   */
  postReposPullsAutoMerge(input?: { body?: { "owner"?: string; "repo"?: string; "number"?: number; "strategy"?: string } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/repos/pulls/auto-merge", input ?? {}, [], true, options)
  },

  /**
   * POST /api/repos/pulls/auto-merge/disarm
   */
  postReposPullsAutoMergeDisarm(input?: { body?: { "owner"?: string; "repo"?: string; "number"?: number } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/repos/pulls/auto-merge/disarm", input ?? {}, [], true, options)
  },

  /**
   * POST /api/repos/pulls/comments
   */
  postReposPullsComments(input?: { body?: { "owner"?: string; "repo"?: string; "number"?: number; "path"?: string; "line"?: number; "side"?: "left" | "right"; "start_line"?: number; "body"?: string; "thread_id"?: number } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/repos/pulls/comments", input ?? {}, [], true, options)
  },

  /**
   * GET /api/repos/pulls/diff/blame
   */
  getReposPullsDiffBlame(input?: { "owner"?: string; "repo"?: string; "number"?: number; "line"?: number; "path"?: string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/repos/pulls/diff/blame", input ?? {}, ["owner", "repo", "number", "line", "path"], false, options)
  },

  /**
   * GET /api/repos/pulls/diff/conflicts
   */
  getReposPullsDiffConflicts(input?: { "owner"?: string; "repo"?: string; "number"?: number }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/repos/pulls/diff/conflicts", input ?? {}, ["owner", "repo", "number"], false, options)
  },

  /**
   * GET /api/repos/pulls/diff/context
   */
  getReposPullsDiffContext(input?: { "owner"?: string; "repo"?: string; "number"?: number; "from"?: unknown; "layout"?: string; "offset"?: unknown; "path"?: string; "to"?: unknown }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/repos/pulls/diff/context", input ?? {}, ["owner", "repo", "number", "from", "layout", "offset", "path", "to"], false, options)
  },

  /**
   * GET /api/repos/pulls/diff/interdiff
   */
  getReposPullsDiffInterdiff(input?: { "owner"?: string; "repo"?: string; "number"?: number; "path"?: string; "since"?: string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/repos/pulls/diff/interdiff", input ?? {}, ["owner", "repo", "number", "path", "since"], false, options)
  },

  /**
   * GET /api/repos/pulls/diff/manifest
   */
  getReposPullsDiffManifest(input?: { "owner"?: string; "repo"?: string; "number"?: number; "highlight"?: string; "layout"?: string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/repos/pulls/diff/manifest", input ?? {}, ["owner", "repo", "number", "highlight", "layout"], false, options)
  },

  /**
   * GET /api/repos/pulls/diff/rows
   */
  getReposPullsDiffRows(input?: { "owner"?: string; "repo"?: string; "number"?: number; "from"?: string; "highlight"?: string; "layout"?: string; "open"?: string; "to"?: unknown }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/repos/pulls/diff/rows", input ?? {}, ["owner", "repo", "number", "from", "highlight", "layout", "open", "to"], false, options)
  },

  /**
   * GET /api/repos/pulls/diff/structured
   */
  getReposPullsDiffStructured(input?: { "owner"?: string; "repo"?: string; "number"?: number; "path"?: string; "per_page"?: number; "offset"?: number }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/repos/pulls/diff/structured", input ?? {}, ["owner", "repo", "number", "path", "per_page", "offset"], false, options)
  },

  /**
   * POST /api/repos/pulls/last-look
   */
  postReposPullsLastLook(input?: { body?: { "owner"?: string; "repo"?: string; "number"?: number } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/repos/pulls/last-look", input ?? {}, [], true, options)
  },

  /**
   * POST /api/repos/pulls/live
   */
  postReposPullsLive(input?: { body?: { "owner"?: string; "repo"?: string; "number"?: number } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/repos/pulls/live", input ?? {}, [], true, options)
  },

  /**
   * POST /api/repos/pulls/merge
   */
  postReposPullsMerge(input: { body: { "owner": string; "repo"?: string; "repository"?: string; "number": number; "strategy"?: "merge" | "squash" | "rebase"; "subject"?: string; "body_text"?: string } }, options?: RequestOptions): Promise<ApiResult<unknown>> {
    return request(config, "POST", "/api/repos/pulls/merge", input ?? {}, [], true, options)
  },

  /**
   * POST /api/repos/pulls/merge-stack
   */
  postReposPullsMergeStack(input?: { body?: { "owner"?: string; "repo"?: string; "number"?: number; "strategy"?: string } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/repos/pulls/merge-stack", input ?? {}, [], true, options)
  },

  /**
   * POST /api/repos/pulls/mergeability
   */
  postReposPullsMergeability(input?: { body?: { "owner"?: string; "repo"?: string; "number"?: number; "force"?: string } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/repos/pulls/mergeability", input ?? {}, [], true, options)
  },

  /**
   * POST /api/repos/pulls/restore-branch
   */
  postReposPullsRestoreBranch(input?: { body?: { "owner"?: string; "repo"?: string; "number"?: number } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/repos/pulls/restore-branch", input ?? {}, [], true, options)
  },

  /**
   * POST /api/repos/pulls/review-requests
   */
  postReposPullsReviewRequests(input: { body: { "owner": string; "repo"?: string; "repository"?: string; "number": number; "reviewer_id": number; "reviewer_type"?: "user" | "team" } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/repos/pulls/review-requests", input ?? {}, [], true, options)
  },

  /**
   * GET /api/repos/pulls/review-state
   */
  getReposPullsReviewState(input?: { "owner"?: string; "repo"?: string; "number"?: number }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/repos/pulls/review-state", input ?? {}, ["owner", "repo", "number"], false, options)
  },

  /**
   * PUT /api/repos/pulls/review-state/draft
   */
  putReposPullsReviewStateDraft(input?: { body?: { "owner"?: string; "repo"?: string; "number"?: number } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "PUT", "/api/repos/pulls/review-state/draft", input ?? {}, [], true, options)
  },

  /**
   * GET /api/repos/pulls/review-state/since
   */
  getReposPullsReviewStateSince(input?: { "owner"?: string; "repo"?: string; "number"?: number; "since"?: string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/repos/pulls/review-state/since", input ?? {}, ["owner", "repo", "number", "since"], false, options)
  },

  /**
   * GET /api/repos/pulls/review-state/stale
   */
  getReposPullsReviewStateStale(input?: { "owner"?: string; "repo"?: string; "number"?: number }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/repos/pulls/review-state/stale", input ?? {}, ["owner", "repo", "number"], false, options)
  },

  /**
   * PUT /api/repos/pulls/review-state/viewed
   */
  putReposPullsReviewStateViewed(input?: { body?: { "owner"?: string; "repo"?: string; "number"?: number; "path"?: string; "viewed"?: string } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "PUT", "/api/repos/pulls/review-state/viewed", input ?? {}, [], true, options)
  },

  /**
   * POST /api/repos/pulls/reviews
   */
  postReposPullsReviews(input?: { body?: { "owner"?: string; "repo"?: string; "number"?: number; "state"?: "approved" | "changes_requested" | "commented"; "body"?: string; "comments"?: Array<unknown> } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/repos/pulls/reviews", input ?? {}, [], true, options)
  },

  /**
   * PUT /api/repos/pulls/reviews/dismiss
   */
  putReposPullsReviewsDismiss(input?: { body?: { "owner"?: string; "repo"?: string; "number"?: number; "reason"?: string; "review_id"?: unknown } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "PUT", "/api/repos/pulls/reviews/dismiss", input ?? {}, [], true, options)
  },

  /**
   * GET /api/repos/pulls/show
   */
  getReposPullsShow(input?: { "owner"?: string; "repo"?: string; "number"?: number; "fields"?: string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/repos/pulls/show", input ?? {}, ["owner", "repo", "number", "fields"], false, options)
  },

  /**
   * GET /api/repos/pulls/stack
   */
  getReposPullsStack(input?: { "owner"?: string; "repo"?: string; "number"?: number }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/repos/pulls/stack", input ?? {}, ["owner", "repo", "number"], false, options)
  },

  /**
   * PUT /api/repos/pulls/state
   */
  putReposPullsState(input?: { body?: { "owner"?: string; "repo"?: string; "number"?: number; "state"?: string } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "PUT", "/api/repos/pulls/state", input ?? {}, [], true, options)
  },

  /**
   * GET /api/repos/pulls/suggested-reviewers
   */
  getReposPullsSuggestedReviewers(input?: { "owner"?: string; "repo"?: string; "number"?: number }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/repos/pulls/suggested-reviewers", input ?? {}, ["owner", "repo", "number"], false, options)
  },

  /**
   * PUT /api/repos/pulls/threads
   */
  putReposPullsThreads(input?: { body?: { "owner"?: string; "repo"?: string; "resolved"?: string; "thread_id"?: unknown } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "PUT", "/api/repos/pulls/threads", input ?? {}, [], true, options)
  },

  /**
   * GET /api/repos/raw
   */
  getReposRaw(input?: { "owner"?: string; "repo"?: string; "inline"?: string; "path"?: string; "ref"?: string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/repos/raw", input ?? {}, ["owner", "repo", "inline", "path", "ref"], false, options)
  },

  /**
   * GET /api/repos/releases
   */
  getReposReleases(input?: { "owner"?: string; "repo"?: string; "ref"?: string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/repos/releases", input ?? {}, ["owner", "repo", "ref"], false, options)
  },

  /**
   * POST /api/repos/releases
   */
  postReposReleases(input?: { body?: { "owner"?: string; "repo"?: string; "body"?: string; "is_draft"?: unknown; "is_prerelease"?: string; "name"?: string; "operation"?: string; "tag_name"?: string } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/repos/releases", input ?? {}, [], true, options)
  },

  /**
   * GET /api/repos/releases/assets
   */
  getReposReleasesAssets(input?: { "owner"?: string; "repo"?: string; "name"?: string; "ref"?: string; "tag_name"?: string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/repos/releases/assets", input ?? {}, ["owner", "repo", "name", "ref", "tag_name"], false, options)
  },

  /**
   * POST /api/repos/releases/assets
   */
  postReposReleasesAssets(input?: { body?: { "owner"?: string; "repo"?: string; "tag_name"?: string } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/repos/releases/assets", input ?? {}, [], true, options)
  },

  /**
   * POST /api/repos/repair-settings
   */
  postReposRepairSettings(input?: { body?: { "owner"?: string; "repo"?: string; "operation"?: string; "enabled"?: boolean; "forbidden_paths"?: string; "steps"?: string; "max_attempts"?: number; "max_minutes"?: number; "max_cost"?: number } }, options?: RequestOptions): Promise<ApiResult<{ "repair"?: { "enabled"?: boolean; "forbidden_paths"?: Array<string>; "steps"?: Array<string>; "max_attempts"?: number; "max_minutes"?: number; "max_cost"?: number }; "defaults"?: Record<string, unknown> }>> {
    return request(config, "POST", "/api/repos/repair-settings", input ?? {}, [], true, options)
  },

  /**
   * GET /api/repos/search
   */
  getReposSearch(input: { "owner": string; "repository"?: string; "q": string; "ref"?: string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/repos/search", input ?? {}, ["owner", "repository", "q", "ref"], false, options)
  },

  /**
   * POST /api/repos/secrets
   */
  postReposSecrets(input?: { body?: { "owner"?: string; "repo"?: string; "operation"?: "list" | "set" | "unset"; "scope"?: "instance" | "owner" | "repository" | "environment"; "reference"?: string; "environment"?: string; "key"?: string; "value"?: string } }, options?: RequestOptions): Promise<ApiResult<{ "secrets"?: Array<{ "key"?: string; "scope"?: string; "updated_at"?: string }> }>> {
    return request(config, "POST", "/api/repos/secrets", input ?? {}, [], true, options)
  },

  /**
   * POST /api/repos/settings
   */
  postReposSettings(input?: { body?: { "owner"?: string; "repo"?: string; "allow_merge_commit"?: unknown; "allow_rebase_merge"?: unknown; "allow_squash_merge"?: unknown; "default_branch"?: string; "default_merge_strategy"?: string; "delete_branch_on_merge"?: unknown; "description"?: string; "homepage"?: string; "is_archived"?: unknown; "is_template"?: unknown; "name"?: string; "visibility"?: string } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/repos/settings", input ?? {}, [], true, options)
  },

  /**
   * POST /api/repos/stars
   */
  postReposStars(input: { body: { "owner": string; "repo"?: string; "repository"?: string } }, options?: RequestOptions): Promise<ApiResult<unknown>> {
    return request(config, "POST", "/api/repos/stars", input ?? {}, [], true, options)
  },

  /**
   * GET /api/repos/tags
   */
  getReposTags(input?: { "owner"?: string; "repo"?: string; "ref"?: string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/repos/tags", input ?? {}, ["owner", "repo", "ref"], false, options)
  },

  /**
   * POST /api/repos/teams
   */
  postReposTeams(input?: { body?: { "owner"?: string; "repo"?: string; "operation"?: string; "permission"?: string; "team_id"?: unknown } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/repos/teams", input ?? {}, [], true, options)
  },

  /**
   * GET /api/repos/tests
   */
  getReposTests(input?: { "owner"?: string; "repo"?: string; "view"?: "suites" | "runs" | "executions" | "states"; "suite"?: string; "branch"?: string; "run"?: number; "test"?: number; "state"?: string; "limit"?: number; "cursor"?: number }, options?: RequestOptions): Promise<ApiResult<{ "suites"?: Array<Record<string, unknown>>; "runs"?: Array<Record<string, unknown>>; "executions"?: Array<Record<string, unknown>>; "states"?: Array<Record<string, unknown>>; "next"?: number }>> {
    return request(config, "GET", "/api/repos/tests", input ?? {}, ["owner", "repo", "view", "suite", "branch", "run", "test", "state", "limit", "cursor"], false, options)
  },

  /**
   * POST /api/repos/tests/ingest
   */
  postReposTestsIngest(input?: { body?: { "owner"?: string; "repo"?: string; "suite"?: string; "sha"?: string; "branch"?: string; "key"?: string; "format"?: "junit" | "json"; "report"?: string } }, options?: RequestOptions): Promise<ApiResult<{ "run"?: number; "verdict"?: string; "duplicate"?: boolean; "counts"?: { "passed"?: number; "failed"?: number; "skipped"?: number; "muted_failures"?: number }; "newly_flaky"?: Array<string> }>> {
    return request(config, "POST", "/api/repos/tests/ingest", input ?? {}, [], true, options)
  },

  /**
   * POST /api/repos/tests/manage
   */
  postReposTestsManage(input?: { body?: { "owner"?: string; "repo"?: string; "operation"?: "list" | "flaky" | "quarantined" | "mute" | "skip" | "enable" | "own" | "history"; "suite"?: string; "test"?: number; "reason"?: string; "review"?: string; "who"?: string; "limit"?: number } }, options?: RequestOptions): Promise<ApiResult<unknown>> {
    return request(config, "POST", "/api/repos/tests/manage", input ?? {}, [], true, options)
  },

  /**
   * POST /api/repos/tests/monitors
   */
  postReposTestsMonitors(input?: { body?: { "owner"?: string; "repo"?: string; "operation"?: "list" | "create" | "update" | "delete" | "evaluate"; "monitor"?: number; "suite"?: string; "condition"?: "flaky" | "fail_rate" | "duration"; "threshold"?: number; "window_days"?: number; "enabled"?: boolean } }, options?: RequestOptions): Promise<ApiResult<unknown>> {
    return request(config, "POST", "/api/repos/tests/monitors", input ?? {}, [], true, options)
  },

  /**
   * POST /api/repos/tests/split
   */
  postReposTestsSplit(input?: { body?: { "owner"?: string; "repo"?: string; "suite"?: string; "nodes"?: number; "index"?: number } }, options?: RequestOptions): Promise<ApiResult<{ "items"?: Array<string>; "estimated_ms"?: number; "unknown"?: number; "note"?: string }>> {
    return request(config, "POST", "/api/repos/tests/split", input ?? {}, [], true, options)
  },

  /**
   * PUT /api/repos/topics
   */
  putReposTopics(input?: { body?: { "owner"?: string; "repo"?: string; "topics"?: string } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "PUT", "/api/repos/topics", input ?? {}, [], true, options)
  },

  /**
   * POST /api/repos/topics
   */
  postReposTopics(input?: { body?: { "owner"?: string; "repo"?: string; "topics"?: string } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/repos/topics", input ?? {}, [], true, options)
  },

  /**
   * POST /api/repos/transfer
   */
  postReposTransfer(input: { body: { "owner": string; "repo"?: string; "repository"?: string; "to"?: string; "new_owner"?: string } }, options?: RequestOptions): Promise<ApiResult<unknown>> {
    return request(config, "POST", "/api/repos/transfer", input ?? {}, [], true, options)
  },

  /**
   * GET /api/repos/tree
   */
  getReposTree(input?: { "owner"?: string; "repo"?: string; "path"?: string; "ref"?: string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/repos/tree", input ?? {}, ["owner", "repo", "path", "ref"], false, options)
  },

  /**
   * POST /api/repos/variables
   */
  postReposVariables(input?: { body?: { "owner"?: string; "repo"?: string; "operation"?: "list" | "set" | "unset"; "scope"?: "instance" | "owner" | "repository"; "key"?: string; "value"?: string } }, options?: RequestOptions): Promise<ApiResult<{ "variables"?: Array<{ "key"?: string; "value"?: string; "scope"?: string; "from"?: string; "shadowed"?: Array<Record<string, unknown>> }> }>> {
    return request(config, "POST", "/api/repos/variables", input ?? {}, [], true, options)
  },

  /**
   * PUT /api/repos/watches
   */
  putReposWatches(input: { body: { "owner": string; "repo"?: string; "repository"?: string; "subscription"?: "all" | "participating" | "ignore" | "none" } }, options?: RequestOptions): Promise<ApiResult<unknown>> {
    return request(config, "PUT", "/api/repos/watches", input ?? {}, [], true, options)
  },

  /**
   * POST /api/repos/watches
   */
  postReposWatches(input: { body: { "owner": string; "repo"?: string; "repository"?: string; "subscription"?: "all" | "participating" | "ignore" | "none" } }, options?: RequestOptions): Promise<ApiResult<unknown>> {
    return request(config, "POST", "/api/repos/watches", input ?? {}, [], true, options)
  },

  /**
   * POST /api/repos/webhooks
   */
  postReposWebhooks(input: { body: { "owner": string; "repo"?: string; "repository"?: string; "operation"?: "create" | "update" | "delete" | "deliveries"; "id"?: number; "url"?: string; "secret"?: string; "content_type"?: string; "active"?: boolean; "limit"?: number; "events"?: unknown } }, options?: RequestOptions): Promise<ApiResult<unknown>> {
    return request(config, "POST", "/api/repos/webhooks", input ?? {}, [], true, options)
  },

  /**
   * POST /api/repos/webhooks/redeliver
   */
  postReposWebhooksRedeliver(input?: { body?: { "owner"?: string; "repo"?: string; "delivery_id"?: unknown } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/repos/webhooks/redeliver", input ?? {}, [], true, options)
  },

  /**
   * GET /api/repos/workflow-metrics
   */
  getReposWorkflowMetrics(input?: { "owner"?: string; "repo"?: string; "workflow"?: number; "days"?: number }, options?: RequestOptions): Promise<ApiResult<{ "window"?: { "days"?: number; "since"?: string }; "runs"?: Record<string, unknown>; "jobs"?: Record<string, unknown>; "steps"?: Array<Record<string, unknown>>; "cache"?: Record<string, unknown> }>> {
    return request(config, "GET", "/api/repos/workflow-metrics", input ?? {}, ["owner", "repo", "workflow", "days"], false, options)
  },

  /**
   * POST /api/repos/workflow-notifications
   */
  postReposWorkflowNotifications(input?: { body?: { "owner"?: string; "repo"?: string; "operation"?: "list" | "add" | "remove"; "user"?: string; "workflow"?: string; "branch"?: string; "job"?: string; "condition"?: "failure" | "success" | "recovery" | "always"; "id"?: number } }, options?: RequestOptions): Promise<ApiResult<unknown>> {
    return request(config, "POST", "/api/repos/workflow-notifications", input ?? {}, [], true, options)
  },

  /**
   * GET /api/repos/workflow-runs
   */
  getReposWorkflowRuns(input?: { "owner"?: string; "repo"?: string; "state"?: string; "branch"?: string; "sha"?: string; "workflow"?: number; "per_page"?: number; "cursor"?: string }, options?: RequestOptions): Promise<ApiResult<{ "workflow_runs"?: Array<Record<string, unknown>>; "next"?: string }>> {
    return request(config, "GET", "/api/repos/workflow-runs", input ?? {}, ["owner", "repo", "state", "branch", "sha", "workflow", "per_page", "cursor"], false, options)
  },

  /**
   * POST /api/repos/workflow-runs/approve
   */
  postReposWorkflowRunsApprove(input?: { body?: { "owner"?: string; "repo"?: string; "number"?: number; "job"?: unknown } }, options?: RequestOptions): Promise<ApiResult<{ "job"?: { "job_id"?: string; "state"?: string }; "run"?: { "number"?: number; "state"?: string }; "outputs"?: Record<string, unknown> }>> {
    return request(config, "POST", "/api/repos/workflow-runs/approve", input ?? {}, [], true, options)
  },

  /**
   * POST /api/repos/workflow-runs/approve-fork
   */
  postReposWorkflowRunsApproveFork(input?: { body?: { "owner"?: string; "repo"?: string; "number"?: number; "decision"?: string } }, options?: RequestOptions): Promise<ApiResult<{ "run"?: { "number"?: number; "state"?: string; "approval_state"?: string; "trusted"?: boolean }; "note"?: string }>> {
    return request(config, "POST", "/api/repos/workflow-runs/approve-fork", input ?? {}, [], true, options)
  },

  /**
   * GET /api/repos/workflow-runs/artifact
   */
  getReposWorkflowRunsArtifact(input: { "owner"?: string; "repo"?: string; "id": number }, options?: RequestOptions): Promise<ApiResult<unknown>> {
    return request(config, "GET", "/api/repos/workflow-runs/artifact", input ?? {}, ["owner", "repo", "id"], false, options)
  },

  /**
   * GET /api/repos/workflow-runs/artifacts
   */
  getReposWorkflowRunsArtifacts(input?: { "owner"?: string; "repo"?: string; "number"?: number; "q"?: string }, options?: RequestOptions): Promise<ApiResult<{ "artifacts"?: Array<Record<string, unknown>>; "total_bytes"?: number }>> {
    return request(config, "GET", "/api/repos/workflow-runs/artifacts", input ?? {}, ["owner", "repo", "number", "q"], false, options)
  },

  /**
   * GET /api/repos/workflow-runs/artifacts/archive
   */
  getReposWorkflowRunsArtifactsArchive(input?: { "owner"?: string; "repo"?: string; "number"?: number }, options?: RequestOptions): Promise<ApiResult<unknown>> {
    return request(config, "GET", "/api/repos/workflow-runs/artifacts/archive", input ?? {}, ["owner", "repo", "number"], false, options)
  },

  /**
   * POST /api/repos/workflow-runs/cancel
   */
  postReposWorkflowRunsCancel(input?: { body?: { "owner"?: string; "repo"?: string; "number"?: number; "reason"?: string } }, options?: RequestOptions): Promise<ApiResult<{ "workflow_run"?: { "number"?: number; "state"?: string }; "cancelled"?: boolean; "reason"?: string }>> {
    return request(config, "POST", "/api/repos/workflow-runs/cancel", input ?? {}, [], true, options)
  },

  /**
   * POST /api/repos/workflow-runs/cancel-job
   */
  postReposWorkflowRunsCancelJob(input?: { body?: { "owner"?: string; "repo"?: string; "number"?: number; "job"?: string; "reason"?: string } }, options?: RequestOptions): Promise<ApiResult<{ "job"?: { "job_id"?: string; "state"?: string }; "run_state"?: string; "cancelled"?: boolean }>> {
    return request(config, "POST", "/api/repos/workflow-runs/cancel-job", input ?? {}, [], true, options)
  },

  /**
   * POST /api/repos/workflow-runs/event
   */
  postReposWorkflowRunsEvent(input?: { body?: { "owner"?: string; "repo"?: string; "number"?: number; "event"?: string; "payload"?: string; "key"?: string } }, options?: RequestOptions): Promise<ApiResult<{ "event"?: string; "duplicate"?: boolean; "delivered"?: number }>> {
    return request(config, "POST", "/api/repos/workflow-runs/event", input ?? {}, [], true, options)
  },

  /**
   * GET /api/repos/workflow-runs/log
   */
  getReposWorkflowRunsLog(input: { "owner"?: string; "repo"?: string; "job": number; "after"?: number; "attempt"?: number }, options?: RequestOptions): Promise<ApiResult<{ "chunks"?: Array<Record<string, unknown>>; "cursor"?: number; "state"?: string; "attempt"?: number }>> {
    return request(config, "GET", "/api/repos/workflow-runs/log", input ?? {}, ["owner", "repo", "job", "after", "attempt"], false, options)
  },

  /**
   * GET /api/repos/workflow-runs/log-image
   */
  getReposWorkflowRunsLogImage(input?: { "owner"?: string; "repo"?: string; "number"?: number; "artifact"?: string }, options?: RequestOptions): Promise<ApiResult<unknown>> {
    return request(config, "GET", "/api/repos/workflow-runs/log-image", input ?? {}, ["owner", "repo", "number", "artifact"], false, options)
  },

  /**
   * POST /api/repos/workflow-runs/pause
   */
  postReposWorkflowRunsPause(input?: { body?: { "owner"?: string; "repo"?: string; "number"?: number; "action"?: string } }, options?: RequestOptions): Promise<ApiResult<{ "workflow_run"?: { "number"?: number; "state"?: string }; "changed"?: boolean }>> {
    return request(config, "POST", "/api/repos/workflow-runs/pause", input ?? {}, [], true, options)
  },

  /**
   * POST /api/repos/workflow-runs/rerun
   */
  postReposWorkflowRunsRerun(input?: { body?: { "owner"?: string; "repo"?: string; "number"?: number; "scope"?: string; "job"?: string; "step"?: string } }, options?: RequestOptions): Promise<ApiResult<{ "workflow_run"?: { "number"?: number; "state"?: string; "attempt"?: number }; "jobs"?: number; "reused"?: number; "reason"?: string }>> {
    return request(config, "POST", "/api/repos/workflow-runs/rerun", input ?? {}, [], true, options)
  },

  /**
   * GET /api/repos/workflow-runs/show
   */
  getReposWorkflowRunsShow(input?: { "owner"?: string; "repo"?: string; "number"?: number }, options?: RequestOptions): Promise<ApiResult<{ "workflow_run"?: Record<string, unknown> }>> {
    return request(config, "GET", "/api/repos/workflow-runs/show", input ?? {}, ["owner", "repo", "number"], false, options)
  },

  /**
   * POST /api/repos/workflow-templates
   */
  postReposWorkflowTemplates(input?: { body?: { "owner"?: string; "repo"?: string; "operation"?: "list" | "publish" | "remove" | "apply"; "slug"?: string; "name"?: string; "description"?: string; "path"?: string; "source"?: string; "template"?: number; "branch"?: string; "overwrite"?: boolean } }, options?: RequestOptions): Promise<ApiResult<unknown>> {
    return request(config, "POST", "/api/repos/workflow-templates", input ?? {}, [], true, options)
  },

  /**
   * GET /api/repos/workflows
   */
  getReposWorkflows(input?: { "owner"?: string; "repo"?: string; "state"?: string; "per_page"?: number; "cursor"?: string }, options?: RequestOptions): Promise<ApiResult<{ "workflows"?: Array<Record<string, unknown>>; "next"?: string }>> {
    return request(config, "GET", "/api/repos/workflows", input ?? {}, ["owner", "repo", "state", "per_page", "cursor"], false, options)
  },

  /**
   * POST /api/repos/workflows/dispatch
   */
  postReposWorkflowsDispatch(input?: { body?: { "owner"?: string; "repo"?: string; "workflow"?: string; "ref"?: string; "key"?: string } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/repos/workflows/dispatch", input ?? {}, [], true, options)
  },

  /**
   * POST /api/repos/workflows/manage
   */
  postReposWorkflowsManage(input?: { body?: { "owner"?: string; "repo"?: string; "workflow"?: string; "operation"?: "enable" | "disable"; "reason"?: string } }, options?: RequestOptions): Promise<ApiResult<unknown>> {
    return request(config, "POST", "/api/repos/workflows/manage", input ?? {}, [], true, options)
  },

  /**
   * GET /api/repos/workflows/show
   */
  getReposWorkflowsShow(input?: { "owner"?: string; "repo"?: string; "workflow"?: string; "version"?: number }, options?: RequestOptions): Promise<ApiResult<{ "workflow"?: Record<string, unknown>; "versions"?: Array<Record<string, unknown>>; "version"?: Record<string, unknown> }>> {
    return request(config, "GET", "/api/repos/workflows/show", input ?? {}, ["owner", "repo", "workflow", "version"], false, options)
  },

  /**
   * GET /api/reviews/queue
   */
  getReviewsQueue(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/reviews/queue", {}, [], false, options)
  },

  /**
   * POST /api/runner/annotations
   */
  postRunnerAnnotations(input?: { body?: { "summary"?: string; "context"?: string; "append"?: boolean } }, options?: RequestOptions): Promise<ApiResult<{ "recorded"?: number; "check_run"?: number }>> {
    return request(config, "POST", "/api/runner/annotations", input ?? {}, [], true, options)
  },

  /**
   * POST /api/runner/artifacts
   */
  postRunnerArtifacts(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/runner/artifacts", {}, [], false, options)
  },

  /**
   * POST /api/runner/artifacts/fetch
   */
  postRunnerArtifactsFetch(input?: { body?: { "name"?: string } }, options?: RequestOptions): Promise<ApiResult<unknown>> {
    return request(config, "POST", "/api/runner/artifacts/fetch", input ?? {}, [], true, options)
  },

  /**
   * POST /api/runner/caches
   */
  postRunnerCaches(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/runner/caches", {}, [], false, options)
  },

  /**
   * GET /api/runner/caches/restore
   */
  getRunnerCachesRestore(input?: { "key"?: string }, options?: RequestOptions): Promise<ApiResult<unknown>> {
    return request(config, "GET", "/api/runner/caches/restore", input ?? {}, ["key"], false, options)
  },

  /**
   * POST /api/runner/claim
   */
  postRunnerClaim(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/runner/claim", {}, [], false, options)
  },

  /**
   * GET /api/runner/download
   */
  getRunnerDownload(input?: { "target"?: string }, options?: RequestOptions): Promise<ApiResult<unknown>> {
    return request(config, "GET", "/api/runner/download", input ?? {}, ["target"], false, options)
  },

  /**
   * POST /api/runner/heartbeat
   */
  postRunnerHeartbeat(input?: { body?: { "steps"?: Array<unknown> } }, options?: RequestOptions): Promise<ApiResult<{ "lease_expires_at"?: string; "steps_recorded"?: number }>> {
    return request(config, "POST", "/api/runner/heartbeat", input ?? {}, [], true, options)
  },

  /**
   * POST /api/runner/logs
   */
  postRunnerLogs(input: { body: { "sequence": number; "content"?: string; "stream"?: "stdout" | "stderr" } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/runner/logs", input ?? {}, [], true, options)
  },

  /**
   * POST /api/runner/metadata
   */
  postRunnerMetadata(input?: { body?: { "action"?: string; "key"?: string; "value"?: string; "if_version"?: number } }, options?: RequestOptions): Promise<ApiResult<{ "entry"?: { "key"?: string; "value"?: string; "version"?: number }; "entries"?: Array<Record<string, unknown>> }>> {
    return request(config, "POST", "/api/runner/metadata", input ?? {}, [], true, options)
  },

  /**
   * POST /api/runner/oidc
   */
  postRunnerOidc(input?: { body?: { "audience"?: string } }, options?: RequestOptions): Promise<ApiResult<{ "value"?: string; "expires_in"?: number; "claims"?: Record<string, unknown> }>> {
    return request(config, "POST", "/api/runner/oidc", input ?? {}, [], true, options)
  },

  /**
   * POST /api/runner/orchestrator
   */
  postRunnerOrchestrator(input: { body: { "sequence": number; "kind"?: string; "name"?: string } }, options?: RequestOptions): Promise<ApiResult<{ "decision"?: string; "result"?: unknown; "entry_id"?: number; "reason"?: string; "wake_at"?: string }>> {
    return request(config, "POST", "/api/runner/orchestrator", input ?? {}, [], true, options)
  },

  /**
   * POST /api/runner/orchestrator/result
   */
  postRunnerOrchestratorResult(input: { body: { "entry_id": number } }, options?: RequestOptions): Promise<ApiResult<{ "recorded"?: boolean }>> {
    return request(config, "POST", "/api/runner/orchestrator/result", input ?? {}, [], true, options)
  },

  /**
   * POST /api/runner/register
   */
  postRunnerRegister(input?: { body?: { "name"?: string; "labels"?: string; "tags"?: string } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/runner/register", input ?? {}, [], true, options)
  },

  /**
   * POST /api/runner/report
   */
  postRunnerReport(input?: { body?: { "state"?: "succeeded" | "failed" | "cancelled"; "error"?: string } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/runner/report", input ?? {}, [], true, options)
  },

  /**
   * POST /api/runner/split
   */
  postRunnerSplit(input?: { body?: { "suite"?: string; "nodes"?: number; "index"?: number } }, options?: RequestOptions): Promise<ApiResult<{ "items"?: Array<string>; "estimated_ms"?: number; "unknown"?: number; "note"?: string }>> {
    return request(config, "POST", "/api/runner/split", input ?? {}, [], true, options)
  },

  /**
   * POST /api/runner/upload
   */
  postRunnerUpload(input: { body: { "steps": string } }, options?: RequestOptions): Promise<ApiResult<{ "added"?: Array<number>; "reason"?: string }>> {
    return request(config, "POST", "/api/runner/upload", input ?? {}, [], true, options)
  },

  /**
   * GET /api/search
   */
  getSearch(input?: { "q"?: string; "scope"?: "repositories" | "issues" | "pulls" | "users" | "code"; "page"?: number; "per_page"?: number }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/search", input ?? {}, ["q", "scope", "page", "per_page"], false, options)
  },

  /**
   * GET /api/search/code
   */
  getSearchCode(input: { "q": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/search/code", input ?? {}, ["q"], false, options)
  },

  /**
   * GET /api/user
   */
  getUser(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/user", {}, [], false, options)
  },

  /**
   * POST /api/user/atproto
   */
  postUserAtproto(input?: { body?: { "operation"?: "link" | "list" | "unlink"; "identifier"?: string } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/user/atproto", input ?? {}, [], true, options)
  },

  /**
   * POST /api/user/forge-credentials
   */
  postUserForgeCredentials(input?: { body?: { "operation"?: "connect" | "list" | "disconnect"; "host"?: string; "provider"?: "github" | "gitlab" | "gitea"; "token"?: string } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/user/forge-credentials", input ?? {}, [], true, options)
  },

  /**
   * POST /api/user/gpg-keys
   */
  postUserGpgKeys(input?: { body?: { "key"?: string } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/user/gpg-keys", input ?? {}, [], true, options)
  },

  /**
   * DELETE /api/user/gpg-keys
   */
  deleteUserGpgKeys(input?: { "id"?: number }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "DELETE", "/api/user/gpg-keys", input ?? {}, ["id"], false, options)
  },

  /**
   * POST /api/user/gpg-keys/delete
   */
  postUserGpgKeysDelete(input?: { body?: { "id"?: number } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/user/gpg-keys/delete", input ?? {}, [], true, options)
  },

  /**
   * POST /api/user/keys
   */
  postUserKeys(input?: { body?: { "key"?: string; "title"?: string } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/user/keys", input ?? {}, [], true, options)
  },

  /**
   * DELETE /api/user/keys
   */
  deleteUserKeys(input?: { "id"?: number }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "DELETE", "/api/user/keys", input ?? {}, ["id"], false, options)
  },

  /**
   * POST /api/user/keys/delete
   */
  postUserKeysDelete(input?: { body?: { "id"?: number } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/user/keys/delete", input ?? {}, [], true, options)
  },

  /**
   * GET /api/user/notifications
   */
  getUserNotifications(input?: { "reason"?: string; "repository"?: string; "unread"?: string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/user/notifications", input ?? {}, ["reason", "repository", "unread"], false, options)
  },

  /**
   * POST /api/user/notifications/mutes
   */
  postUserNotificationsMutes(input?: { body?: { "duration"?: string; "muted"?: string; "subject_id"?: unknown; "subject_type"?: string } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/user/notifications/mutes", input ?? {}, [], true, options)
  },

  /**
   * POST /api/user/notifications/preferences
   */
  postUserNotificationsPreferences(input?: { body?: { "channel"?: string; "delivery"?: string; "event"?: string } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/user/notifications/preferences", input ?? {}, [], true, options)
  },

  /**
   * POST /api/user/notifications/push
   */
  postUserNotificationsPush(input?: { body?: { "auth"?: string; "endpoint"?: string; "operation"?: string; "p256dh"?: string } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/user/notifications/push", input ?? {}, [], true, options)
  },

  /**
   * POST /api/user/notifications/push/test
   */
  postUserNotificationsPushTest(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/user/notifications/push/test", {}, [], false, options)
  },

  /**
   * POST /api/user/notifications/read
   */
  postUserNotificationsRead(input?: { body?: { "id"?: number; "ids"?: string; "mark_all"?: unknown; "reason"?: string; "repository"?: string } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/user/notifications/read", input ?? {}, [], true, options)
  },

  /**
   * PUT /api/user/notifications/schedule
   */
  putUserNotificationsSchedule(input?: { body?: { "breaks_through"?: string; "days"?: number; "do_not_disturb_until"?: string; "ends_at"?: string; "starts_at"?: string; "timezone"?: string } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "PUT", "/api/user/notifications/schedule", input ?? {}, [], true, options)
  },

  /**
   * POST /api/user/passkeys
   */
  postUserPasskeys(input?: { body?: { "operation"?: "list" | "options" | "register" | "remove"; "id"?: unknown; "credential"?: string } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/user/passkeys", input ?? {}, [], true, options)
  },

  /**
   * POST /api/user/profile
   */
  postUserProfile(input?: { body?: { "handle"?: string; "website"?: string } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/user/profile", input ?? {}, [], true, options)
  },

  /**
   * POST /api/user/sessions
   */
  postUserSessions(input?: { body?: { "operation"?: "list" | "revoke" | "revoke-others"; "id"?: number } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/user/sessions", input ?? {}, [], true, options)
  },

  /**
   * GET /api/user/tokens
   */
  getUserTokens(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/user/tokens", {}, [], false, options)
  },

  /**
   * POST /api/user/tokens
   */
  postUserTokens(input: { body: { "name": string; "selection"?: "all" | "organization" | "selected"; "expires_at"?: string; "organization_id"?: number; "machine_account_id"?: number; "permissions"?: Array<unknown>; "repository_ids"?: Array<unknown> } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/user/tokens", input ?? {}, [], true, options)
  },

  /**
   * DELETE /api/user/tokens
   */
  deleteUserTokens(input: { "id": number; "reason"?: string }, options?: RequestOptions): Promise<ApiResult<unknown>> {
    return request(config, "DELETE", "/api/user/tokens", input ?? {}, ["id", "reason"], false, options)
  },

  /**
   * POST /api/user/tokens/revoke
   */
  postUserTokensRevoke(input: { body: { "id": number; "reason"?: string } }, options?: RequestOptions): Promise<ApiResult<unknown>> {
    return request(config, "POST", "/api/user/tokens/revoke", input ?? {}, [], true, options)
  },

  /**
   * POST /api/user/tokens/rotate
   */
  postUserTokensRotate(input: { body: { "id": number; "expires_at"?: string } }, options?: RequestOptions): Promise<ApiResult<unknown>> {
    return request(config, "POST", "/api/user/tokens/rotate", input ?? {}, [], true, options)
  },

  /**
   * POST /api/user/two-factor
   */
  postUserTwoFactor(input?: { body?: { "operation"?: "status" | "begin" | "enable" | "disable" | "recovery-codes"; "code"?: string } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/user/two-factor", input ?? {}, [], true, options)
  },

  /**
   * GET /api/view/manifest
   */
  getViewManifest(input?: { "owner"?: string; "repo"?: string; "kind"?: string; "ref"?: string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/view/manifest", input ?? {}, ["owner", "repo", "kind", "ref"], false, options)
  },

  /**
   * GET /api/view/patch
   */
  getViewPatch(input?: { "owner"?: string; "repo"?: string; "kind"?: string; "ref"?: string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/view/patch", input ?? {}, ["owner", "repo", "kind", "ref"], false, options)
  },

  /**
   * GET /api/view/rows
   */
  getViewRows(input?: { "owner"?: string; "repo"?: string; "kind"?: string; "ref"?: string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/view/rows", input ?? {}, ["owner", "repo", "kind", "ref"], false, options)
  },

  /**
   * GET /atproto/client-metadata.json
   */
  getAtprotoClientMetadataJson(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/atproto/client-metadata.json", {}, [], false, options)
  },

  /**
   * GET /attachments/{key}
   */
  getAttachmentsKey(input: { "key": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/attachments/{key}", input ?? {}, [], false, options)
  },

  /**
   * GET /git/{owner}/{repository}/bundles/checkpoint
   */
  getGitOwnerRepositoryBundlesCheckpoint(input: { "owner": string; "repository": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/git/{owner}/{repository}/bundles/checkpoint", input ?? {}, [], false, options)
  },

  /**
   * POST /git/{owner}/{repository}/git-receive-pack
   */
  postGitOwnerRepositoryGitReceivePack(input: { "owner": string; "repository": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/git/{owner}/{repository}/git-receive-pack", input ?? {}, [], false, options)
  },

  /**
   * POST /git/{owner}/{repository}/git-upload-pack
   */
  postGitOwnerRepositoryGitUploadPack(input: { "owner": string; "repository": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/git/{owner}/{repository}/git-upload-pack", input ?? {}, [], false, options)
  },

  /**
   * GET /git/{owner}/{repository}/info/lfs/locks
   */
  getGitOwnerRepositoryInfoLfsLocks(input: { "owner": string; "repository": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/git/{owner}/{repository}/info/lfs/locks", input ?? {}, [], false, options)
  },

  /**
   * POST /git/{owner}/{repository}/info/lfs/locks
   */
  postGitOwnerRepositoryInfoLfsLocks(input: { "owner": string; "repository": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/git/{owner}/{repository}/info/lfs/locks", input ?? {}, [], false, options)
  },

  /**
   * POST /git/{owner}/{repository}/info/lfs/locks/verify
   */
  postGitOwnerRepositoryInfoLfsLocksVerify(input: { "owner": string; "repository": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/git/{owner}/{repository}/info/lfs/locks/verify", input ?? {}, [], false, options)
  },

  /**
   * POST /git/{owner}/{repository}/info/lfs/locks/{id}/unlock
   */
  postGitOwnerRepositoryInfoLfsLocksIdUnlock(input: { "owner": string; "repository": string; "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/git/{owner}/{repository}/info/lfs/locks/{id}/unlock", input ?? {}, [], false, options)
  },

  /**
   * POST /git/{owner}/{repository}/info/lfs/objects/batch
   */
  postGitOwnerRepositoryInfoLfsObjectsBatch(input: { "owner": string; "repository": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/git/{owner}/{repository}/info/lfs/objects/batch", input ?? {}, [], false, options)
  },

  /**
   * GET /git/{owner}/{repository}/info/lfs/objects/{oid}
   */
  getGitOwnerRepositoryInfoLfsObjectsOid(input: { "owner": string; "repository": string; "oid": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/git/{owner}/{repository}/info/lfs/objects/{oid}", input ?? {}, [], false, options)
  },

  /**
   * PUT /git/{owner}/{repository}/info/lfs/objects/{oid}
   */
  putGitOwnerRepositoryInfoLfsObjectsOid(input: { "owner": string; "repository": string; "oid": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "PUT", "/git/{owner}/{repository}/info/lfs/objects/{oid}", input ?? {}, [], false, options)
  },

  /**
   * POST /git/{owner}/{repository}/info/lfs/verify
   */
  postGitOwnerRepositoryInfoLfsVerify(input: { "owner": string; "repository": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/git/{owner}/{repository}/info/lfs/verify", input ?? {}, [], false, options)
  },

  /**
   * GET /git/{owner}/{repository}/info/refs
   */
  getGitOwnerRepositoryInfoRefs(input: { "owner": string; "repository": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/git/{owner}/{repository}/info/refs", input ?? {}, [], false, options)
  },

  /**
   * POST /internal/git/post-receive
   */
  postInternalGitPostReceive(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/internal/git/post-receive", {}, [], false, options)
  },

  /**
   * POST /internal/git/pre-receive
   */
  postInternalGitPreReceive(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/internal/git/pre-receive", {}, [], false, options)
  },

  /**
   * POST /unsubscribe/{token}
   */
  postUnsubscribeToken(input: { "token": string; body?: { "token"?: string } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/unsubscribe/{token}", input ?? {}, [], true, options)
  },

  /**
   * GET /{owner}/{repository}/bundles/checkpoint
   */
  getOwnerRepositoryBundlesCheckpoint(input: { "owner": string; "repository": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/{owner}/{repository}/bundles/checkpoint", input ?? {}, [], false, options)
  },

  /**
   * POST /{owner}/{repository}/git-receive-pack
   */
  postOwnerRepositoryGitReceivePack(input: { "owner": string; "repository": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/{owner}/{repository}/git-receive-pack", input ?? {}, [], false, options)
  },

  /**
   * POST /{owner}/{repository}/git-upload-pack
   */
  postOwnerRepositoryGitUploadPack(input: { "owner": string; "repository": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/{owner}/{repository}/git-upload-pack", input ?? {}, [], false, options)
  },

  /**
   * GET /{owner}/{repository}/info/lfs/locks
   */
  getOwnerRepositoryInfoLfsLocks(input: { "owner": string; "repository": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/{owner}/{repository}/info/lfs/locks", input ?? {}, [], false, options)
  },

  /**
   * POST /{owner}/{repository}/info/lfs/locks
   */
  postOwnerRepositoryInfoLfsLocks(input: { "owner": string; "repository": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/{owner}/{repository}/info/lfs/locks", input ?? {}, [], false, options)
  },

  /**
   * POST /{owner}/{repository}/info/lfs/locks/verify
   */
  postOwnerRepositoryInfoLfsLocksVerify(input: { "owner": string; "repository": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/{owner}/{repository}/info/lfs/locks/verify", input ?? {}, [], false, options)
  },

  /**
   * POST /{owner}/{repository}/info/lfs/locks/{id}/unlock
   */
  postOwnerRepositoryInfoLfsLocksIdUnlock(input: { "owner": string; "repository": string; "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/{owner}/{repository}/info/lfs/locks/{id}/unlock", input ?? {}, [], false, options)
  },

  /**
   * POST /{owner}/{repository}/info/lfs/objects/batch
   */
  postOwnerRepositoryInfoLfsObjectsBatch(input: { "owner": string; "repository": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/{owner}/{repository}/info/lfs/objects/batch", input ?? {}, [], false, options)
  },

  /**
   * GET /{owner}/{repository}/info/lfs/objects/{oid}
   */
  getOwnerRepositoryInfoLfsObjectsOid(input: { "owner": string; "repository": string; "oid": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/{owner}/{repository}/info/lfs/objects/{oid}", input ?? {}, [], false, options)
  },

  /**
   * PUT /{owner}/{repository}/info/lfs/objects/{oid}
   */
  putOwnerRepositoryInfoLfsObjectsOid(input: { "owner": string; "repository": string; "oid": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "PUT", "/{owner}/{repository}/info/lfs/objects/{oid}", input ?? {}, [], false, options)
  },

  /**
   * POST /{owner}/{repository}/info/lfs/verify
   */
  postOwnerRepositoryInfoLfsVerify(input: { "owner": string; "repository": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/{owner}/{repository}/info/lfs/verify", input ?? {}, [], false, options)
  },

  /**
   * GET /{owner}/{repository}/info/refs
   */
  getOwnerRepositoryInfoRefs(input: { "owner": string; "repository": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/{owner}/{repository}/info/refs", input ?? {}, [], false, options)
  },
  }
}

export type Client = ReturnType<typeof createClient>

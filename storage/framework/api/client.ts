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
   * GET /_stacks/mail/preview
   */
  getStacksMailPreview(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/_stacks/mail/preview", {}, [], false, options)
  },

  /**
   * GET /_stacks/mail/preview/{name}
   */
  getStacksMailPreviewName(input: { "name": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/_stacks/mail/preview/{name}", input ?? {}, [], false, options)
  },

  /**
   * GET /_stacks/mail/preview/{name}/raw
   */
  getStacksMailPreviewNameRaw(input: { "name": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/_stacks/mail/preview/{name}/raw", input ?? {}, [], false, options)
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
   * POST /ai/ask
   */
  postAiAsk(input?: { body?: { "question"?: string } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/ai/ask", input ?? {}, [], true, options)
  },

  /**
   * POST /ai/summary
   */
  postAiSummary(input?: { body?: { "text"?: string } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/ai/summary", input ?? {}, [], true, options)
  },

  /**
   * GET /api/activities
   */
  getActivities(options?: RequestOptions): Promise<ApiResult<{ "data": Array<{ "id": number; "uuid": string; "type": string; "description": string; "subject_type"?: string; "subject_id"?: number; "causer"?: string; "properties"?: string; "ip_address"?: string; "user_id"?: number; "created_at"?: string; "updated_at"?: string }> }>> {
    return request(config, "GET", "/api/activities", {}, [], false, options)
  },

  /**
   * GET /api/activities/{id}
   */
  getActivitiesId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "type": string; "description": string; "subject_type"?: string; "subject_id"?: number; "causer"?: string; "properties"?: string; "ip_address"?: string; "user_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "GET", "/api/activities/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/analytics-events
   */
  getAnalyticsEvents(options?: RequestOptions): Promise<ApiResult<{ "data": Array<{ "id": number; "uuid": string; "name": string; "category": string; "path"?: string; "value"?: number; "currency": string; "properties"?: string; "created_at"?: string; "updated_at"?: string }> }>> {
    return request(config, "GET", "/api/analytics-events", {}, [], false, options)
  },

  /**
   * POST /api/analytics-events
   */
  postAnalyticsEvents(options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name": string; "category": string; "path"?: string; "value"?: number; "currency": string; "properties"?: string; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "POST", "/api/analytics-events", {}, [], false, options)
  },

  /**
   * POST /api/analytics-events/bulk-delete
   */
  postAnalyticsEventsBulkDelete(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/analytics-events/bulk-delete", {}, [], false, options)
  },

  /**
   * GET /api/analytics-events/{id}
   */
  getAnalyticsEventsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name": string; "category": string; "path"?: string; "value"?: number; "currency": string; "properties"?: string; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "GET", "/api/analytics-events/{id}", input ?? {}, [], false, options)
  },

  /**
   * DELETE /api/analytics-events/{id}
   */
  deleteAnalyticsEventsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name": string; "category": string; "path"?: string; "value"?: number; "currency": string; "properties"?: string; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "DELETE", "/api/analytics-events/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/analytics/blog
   */
  getAnalyticsBlog(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/analytics/blog", {}, [], false, options)
  },

  /**
   * GET /api/analytics/browsers
   */
  getAnalyticsBrowsers(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/analytics/browsers", {}, [], false, options)
  },

  /**
   * GET /api/analytics/commerce
   */
  getAnalyticsCommerce(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/analytics/commerce", {}, [], false, options)
  },

  /**
   * GET /api/analytics/countries
   */
  getAnalyticsCountries(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/analytics/countries", {}, [], false, options)
  },

  /**
   * GET /api/analytics/devices
   */
  getAnalyticsDevices(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/analytics/devices", {}, [], false, options)
  },

  /**
   * GET /api/analytics/events
   */
  getAnalyticsEventsGet(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/analytics/events", {}, [], false, options)
  },

  /**
   * GET /api/analytics/marketing
   */
  getAnalyticsMarketing(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/analytics/marketing", {}, [], false, options)
  },

  /**
   * GET /api/analytics/pages
   */
  getAnalyticsPages(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/analytics/pages", {}, [], false, options)
  },

  /**
   * GET /api/analytics/referrers
   */
  getAnalyticsReferrers(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/analytics/referrers", {}, [], false, options)
  },

  /**
   * GET /api/analytics/sales
   */
  getAnalyticsSales(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/analytics/sales", {}, [], false, options)
  },

  /**
   * GET /api/analytics/web
   */
  getAnalyticsWeb(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/analytics/web", {}, [], false, options)
  },

  /**
   * GET /api/audit
   */
  getAudit(input?: { "organization_id"?: number; "actor_id"?: number; "owner"?: string; "repo"?: string; "action"?: string; "since"?: string; "until"?: string; "limit"?: number; "before"?: number; "format"?: "json" | "jsonl" }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/audit", input ?? {}, ["organization_id", "actor_id", "owner", "repo", "action", "since", "until", "limit", "before", "format"], false, options)
  },

  /**
   * POST /api/auth/login
   */
  postAuthLogin(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/auth/login", {}, [], false, options)
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
  postAuthPasswordReset(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/auth/password/reset", {}, [], false, options)
  },

  /**
   * POST /api/auth/register
   */
  postAuthRegister(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/auth/register", {}, [], false, options)
  },

  /**
   * GET /api/auth/sso
   */
  getAuthSso(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/auth/sso", {}, [], false, options)
  },

  /**
   * GET /api/auth/verify
   */
  getAuthVerify(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/auth/verify", {}, [], false, options)
  },

  /**
   * POST /api/auth/verify/resend
   */
  postAuthVerifyResend(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/auth/verify/resend", {}, [], false, options)
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
   * GET /api/authors
   */
  getAuthors(options?: RequestOptions): Promise<ApiResult<{ "data": Array<{ "id": number; "uuid": string; "name"?: string; "email"?: string; "bio"?: string; "avatar"?: string; "user_id"?: number; "created_at"?: string; "updated_at"?: string }> }>> {
    return request(config, "GET", "/api/authors", {}, [], false, options)
  },

  /**
   * POST /api/authors
   */
  postAuthors(options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name"?: string; "email"?: string; "bio"?: string; "avatar"?: string; "user_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "POST", "/api/authors", {}, [], false, options)
  },

  /**
   * POST /api/authors/bulk-delete
   */
  postAuthorsBulkDelete(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/authors/bulk-delete", {}, [], false, options)
  },

  /**
   * GET /api/authors/{id}
   */
  getAuthorsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name"?: string; "email"?: string; "bio"?: string; "avatar"?: string; "user_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "GET", "/api/authors/{id}", input ?? {}, [], false, options)
  },

  /**
   * PUT /api/authors/{id}
   */
  putAuthorsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name"?: string; "email"?: string; "bio"?: string; "avatar"?: string; "user_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PUT", "/api/authors/{id}", input ?? {}, [], false, options)
  },

  /**
   * DELETE /api/authors/{id}
   */
  deleteAuthorsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name"?: string; "email"?: string; "bio"?: string; "avatar"?: string; "user_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "DELETE", "/api/authors/{id}", input ?? {}, [], false, options)
  },

  /**
   * PATCH /api/authors/{id}
   */
  patchAuthorsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name"?: string; "email"?: string; "bio"?: string; "avatar"?: string; "user_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PATCH", "/api/authors/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/board-columns
   */
  getBoardColumns(options?: RequestOptions): Promise<ApiResult<{ "data": Array<{ "id": number; "uuid": string; "board_id"?: number; "name"?: string; "position"?: number; "card_limit"?: number; "color"?: string; "created_at"?: string; "updated_at"?: string }> }>> {
    return request(config, "GET", "/api/board-columns", {}, [], false, options)
  },

  /**
   * POST /api/board-columns
   */
  postBoardColumns(options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "board_id"?: number; "name"?: string; "position"?: number; "card_limit"?: number; "color"?: string; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "POST", "/api/board-columns", {}, [], false, options)
  },

  /**
   * POST /api/board-columns/bulk-delete
   */
  postBoardColumnsBulkDelete(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/board-columns/bulk-delete", {}, [], false, options)
  },

  /**
   * GET /api/board-columns/{id}
   */
  getBoardColumnsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "board_id"?: number; "name"?: string; "position"?: number; "card_limit"?: number; "color"?: string; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "GET", "/api/board-columns/{id}", input ?? {}, [], false, options)
  },

  /**
   * PUT /api/board-columns/{id}
   */
  putBoardColumnsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "board_id"?: number; "name"?: string; "position"?: number; "card_limit"?: number; "color"?: string; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PUT", "/api/board-columns/{id}", input ?? {}, [], false, options)
  },

  /**
   * DELETE /api/board-columns/{id}
   */
  deleteBoardColumnsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "board_id"?: number; "name"?: string; "position"?: number; "card_limit"?: number; "color"?: string; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "DELETE", "/api/board-columns/{id}", input ?? {}, [], false, options)
  },

  /**
   * PATCH /api/board-columns/{id}
   */
  patchBoardColumnsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "board_id"?: number; "name"?: string; "position"?: number; "card_limit"?: number; "color"?: string; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PATCH", "/api/board-columns/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/boards
   */
  getBoards(options?: RequestOptions): Promise<ApiResult<{ "data": Array<{ "id": number; "uuid": string; "name"?: string; "description"?: string; "icon"?: string; "color"?: string; "position"?: number; "archived"?: boolean; "created_at"?: string; "updated_at"?: string }> }>> {
    return request(config, "GET", "/api/boards", {}, [], false, options)
  },

  /**
   * POST /api/boards
   */
  postBoards(options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name"?: string; "description"?: string; "icon"?: string; "color"?: string; "position"?: number; "archived"?: boolean; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "POST", "/api/boards", {}, [], false, options)
  },

  /**
   * POST /api/boards/bulk-delete
   */
  postBoardsBulkDelete(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/boards/bulk-delete", {}, [], false, options)
  },

  /**
   * GET /api/boards/{id}
   */
  getBoardsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name"?: string; "description"?: string; "icon"?: string; "color"?: string; "position"?: number; "archived"?: boolean; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "GET", "/api/boards/{id}", input ?? {}, [], false, options)
  },

  /**
   * PUT /api/boards/{id}
   */
  putBoardsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name"?: string; "description"?: string; "icon"?: string; "color"?: string; "position"?: number; "archived"?: boolean; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PUT", "/api/boards/{id}", input ?? {}, [], false, options)
  },

  /**
   * DELETE /api/boards/{id}
   */
  deleteBoardsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name"?: string; "description"?: string; "icon"?: string; "color"?: string; "position"?: number; "archived"?: boolean; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "DELETE", "/api/boards/{id}", input ?? {}, [], false, options)
  },

  /**
   * PATCH /api/boards/{id}
   */
  patchBoardsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name"?: string; "description"?: string; "icon"?: string; "color"?: string; "position"?: number; "archived"?: boolean; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PATCH", "/api/boards/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/campaign-sends
   */
  getCampaignSends(options?: RequestOptions): Promise<ApiResult<{ "data": Array<{ "id": number; "uuid": string; "campaign_id": number; "subscriber_id": number; "email_list_id": number; "status": "queued" | "sent" | "failed" | "bounced" | "complained"; "provider_message_id"?: string; "error"?: string; "sent_at"?: unknown; "opened_at"?: unknown; "clicked_at"?: unknown; "created_at"?: string; "updated_at"?: string }> }>> {
    return request(config, "GET", "/api/campaign-sends", {}, [], false, options)
  },

  /**
   * GET /api/campaign-sends/{id}
   */
  getCampaignSendsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "campaign_id": number; "subscriber_id": number; "email_list_id": number; "status": "queued" | "sent" | "failed" | "bounced" | "complained"; "provider_message_id"?: string; "error"?: string; "sent_at"?: unknown; "opened_at"?: unknown; "clicked_at"?: unknown; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "GET", "/api/campaign-sends/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/campaigns
   */
  getCampaigns(options?: RequestOptions): Promise<ApiResult<{ "data": Array<{ "id": number; "uuid": string; "name": string; "description"?: string; "type": "email" | "sms" | "push" | "social" | "multi-channel"; "status": "draft" | "scheduled" | "sending" | "sent" | "paused" | "cancelled" | "failed" | "active" | "completed" | "archived"; "subject"?: string; "template"?: string; "text"?: string; "from_name"?: string; "from_address"?: string; "email_list_id"?: number; "scheduled_at"?: unknown; "sent_at"?: unknown; "audience_size"?: number; "sent_count"?: number; "open_rate"?: number; "click_rate"?: number; "conversion_rate"?: number; "budget"?: number; "spent"?: number; "currency": string; "start_date"?: unknown; "end_date"?: unknown; "created_at"?: string; "updated_at"?: string }> }>> {
    return request(config, "GET", "/api/campaigns", {}, [], false, options)
  },

  /**
   * POST /api/campaigns
   */
  postCampaigns(options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name": string; "description"?: string; "type": "email" | "sms" | "push" | "social" | "multi-channel"; "status": "draft" | "scheduled" | "sending" | "sent" | "paused" | "cancelled" | "failed" | "active" | "completed" | "archived"; "subject"?: string; "template"?: string; "text"?: string; "from_name"?: string; "from_address"?: string; "email_list_id"?: number; "scheduled_at"?: unknown; "sent_at"?: unknown; "audience_size"?: number; "sent_count"?: number; "open_rate"?: number; "click_rate"?: number; "conversion_rate"?: number; "budget"?: number; "spent"?: number; "currency": string; "start_date"?: unknown; "end_date"?: unknown; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "POST", "/api/campaigns", {}, [], false, options)
  },

  /**
   * POST /api/campaigns/bulk-delete
   */
  postCampaignsBulkDelete(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/campaigns/bulk-delete", {}, [], false, options)
  },

  /**
   * GET /api/campaigns/{id}
   */
  getCampaignsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name": string; "description"?: string; "type": "email" | "sms" | "push" | "social" | "multi-channel"; "status": "draft" | "scheduled" | "sending" | "sent" | "paused" | "cancelled" | "failed" | "active" | "completed" | "archived"; "subject"?: string; "template"?: string; "text"?: string; "from_name"?: string; "from_address"?: string; "email_list_id"?: number; "scheduled_at"?: unknown; "sent_at"?: unknown; "audience_size"?: number; "sent_count"?: number; "open_rate"?: number; "click_rate"?: number; "conversion_rate"?: number; "budget"?: number; "spent"?: number; "currency": string; "start_date"?: unknown; "end_date"?: unknown; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "GET", "/api/campaigns/{id}", input ?? {}, [], false, options)
  },

  /**
   * PUT /api/campaigns/{id}
   */
  putCampaignsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name": string; "description"?: string; "type": "email" | "sms" | "push" | "social" | "multi-channel"; "status": "draft" | "scheduled" | "sending" | "sent" | "paused" | "cancelled" | "failed" | "active" | "completed" | "archived"; "subject"?: string; "template"?: string; "text"?: string; "from_name"?: string; "from_address"?: string; "email_list_id"?: number; "scheduled_at"?: unknown; "sent_at"?: unknown; "audience_size"?: number; "sent_count"?: number; "open_rate"?: number; "click_rate"?: number; "conversion_rate"?: number; "budget"?: number; "spent"?: number; "currency": string; "start_date"?: unknown; "end_date"?: unknown; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PUT", "/api/campaigns/{id}", input ?? {}, [], false, options)
  },

  /**
   * DELETE /api/campaigns/{id}
   */
  deleteCampaignsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name": string; "description"?: string; "type": "email" | "sms" | "push" | "social" | "multi-channel"; "status": "draft" | "scheduled" | "sending" | "sent" | "paused" | "cancelled" | "failed" | "active" | "completed" | "archived"; "subject"?: string; "template"?: string; "text"?: string; "from_name"?: string; "from_address"?: string; "email_list_id"?: number; "scheduled_at"?: unknown; "sent_at"?: unknown; "audience_size"?: number; "sent_count"?: number; "open_rate"?: number; "click_rate"?: number; "conversion_rate"?: number; "budget"?: number; "spent"?: number; "currency": string; "start_date"?: unknown; "end_date"?: unknown; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "DELETE", "/api/campaigns/{id}", input ?? {}, [], false, options)
  },

  /**
   * PATCH /api/campaigns/{id}
   */
  patchCampaignsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name": string; "description"?: string; "type": "email" | "sms" | "push" | "social" | "multi-channel"; "status": "draft" | "scheduled" | "sending" | "sent" | "paused" | "cancelled" | "failed" | "active" | "completed" | "archived"; "subject"?: string; "template"?: string; "text"?: string; "from_name"?: string; "from_address"?: string; "email_list_id"?: number; "scheduled_at"?: unknown; "sent_at"?: unknown; "audience_size"?: number; "sent_count"?: number; "open_rate"?: number; "click_rate"?: number; "conversion_rate"?: number; "budget"?: number; "spent"?: number; "currency": string; "start_date"?: unknown; "end_date"?: unknown; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PATCH", "/api/campaigns/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/card-comments
   */
  getCardComments(options?: RequestOptions): Promise<ApiResult<{ "data": Array<{ "id": number; "uuid": string; "card_id"?: number; "user_id"?: number; "body"?: string; "created_at"?: string; "updated_at"?: string }> }>> {
    return request(config, "GET", "/api/card-comments", {}, [], false, options)
  },

  /**
   * POST /api/card-comments
   */
  postCardComments(options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "card_id"?: number; "user_id"?: number; "body"?: string; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "POST", "/api/card-comments", {}, [], false, options)
  },

  /**
   * POST /api/card-comments/bulk-delete
   */
  postCardCommentsBulkDelete(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/card-comments/bulk-delete", {}, [], false, options)
  },

  /**
   * GET /api/card-comments/{id}
   */
  getCardCommentsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "card_id"?: number; "user_id"?: number; "body"?: string; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "GET", "/api/card-comments/{id}", input ?? {}, [], false, options)
  },

  /**
   * DELETE /api/card-comments/{id}
   */
  deleteCardCommentsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "card_id"?: number; "user_id"?: number; "body"?: string; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "DELETE", "/api/card-comments/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/cards
   */
  getCards(options?: RequestOptions): Promise<ApiResult<{ "data": Array<{ "id": number; "uuid": string; "column_id"?: number; "board_id"?: number; "title"?: string; "description"?: string; "position"?: number; "created_by_user_id"?: number; "due_date"?: string; "archived"?: boolean; "board_column_id"?: number; "user_id"?: number; "created_at"?: string; "updated_at"?: string }> }>> {
    return request(config, "GET", "/api/cards", {}, [], false, options)
  },

  /**
   * POST /api/cards
   */
  postCards(options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "column_id"?: number; "board_id"?: number; "title"?: string; "description"?: string; "position"?: number; "created_by_user_id"?: number; "due_date"?: string; "archived"?: boolean; "board_column_id"?: number; "user_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "POST", "/api/cards", {}, [], false, options)
  },

  /**
   * POST /api/cards/bulk-delete
   */
  postCardsBulkDelete(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/cards/bulk-delete", {}, [], false, options)
  },

  /**
   * GET /api/cards/{id}
   */
  getCardsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "column_id"?: number; "board_id"?: number; "title"?: string; "description"?: string; "position"?: number; "created_by_user_id"?: number; "due_date"?: string; "archived"?: boolean; "board_column_id"?: number; "user_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "GET", "/api/cards/{id}", input ?? {}, [], false, options)
  },

  /**
   * PUT /api/cards/{id}
   */
  putCardsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "column_id"?: number; "board_id"?: number; "title"?: string; "description"?: string; "position"?: number; "created_by_user_id"?: number; "due_date"?: string; "archived"?: boolean; "board_column_id"?: number; "user_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PUT", "/api/cards/{id}", input ?? {}, [], false, options)
  },

  /**
   * DELETE /api/cards/{id}
   */
  deleteCardsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "column_id"?: number; "board_id"?: number; "title"?: string; "description"?: string; "position"?: number; "created_by_user_id"?: number; "due_date"?: string; "archived"?: boolean; "board_column_id"?: number; "user_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "DELETE", "/api/cards/{id}", input ?? {}, [], false, options)
  },

  /**
   * PATCH /api/cards/{id}
   */
  patchCardsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "column_id"?: number; "board_id"?: number; "title"?: string; "description"?: string; "position"?: number; "created_by_user_id"?: number; "due_date"?: string; "archived"?: boolean; "board_column_id"?: number; "user_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PATCH", "/api/cards/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/cart
   */
  getCart(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/cart", {}, [], false, options)
  },

  /**
   * GET /api/cart-items
   */
  getCartItems(options?: RequestOptions): Promise<ApiResult<{ "data": Array<{ "id": number; "uuid": string; "quantity"?: number; "unit_price"?: number; "total_price"?: number; "tax_rate"?: number; "tax_amount"?: number; "discount_percentage"?: number; "discount_amount"?: number; "product_name"?: string; "product_sku"?: string; "product_image"?: string; "notes"?: string; "cart_id"?: number; "created_at"?: string; "updated_at"?: string }> }>> {
    return request(config, "GET", "/api/cart-items", {}, [], false, options)
  },

  /**
   * POST /api/cart-items
   */
  postCartItems(options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "quantity"?: number; "unit_price"?: number; "total_price"?: number; "tax_rate"?: number; "tax_amount"?: number; "discount_percentage"?: number; "discount_amount"?: number; "product_name"?: string; "product_sku"?: string; "product_image"?: string; "notes"?: string; "cart_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "POST", "/api/cart-items", {}, [], false, options)
  },

  /**
   * POST /api/cart-items/bulk-delete
   */
  postCartItemsBulkDelete(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/cart-items/bulk-delete", {}, [], false, options)
  },

  /**
   * GET /api/cart-items/{id}
   */
  getCartItemsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "quantity"?: number; "unit_price"?: number; "total_price"?: number; "tax_rate"?: number; "tax_amount"?: number; "discount_percentage"?: number; "discount_amount"?: number; "product_name"?: string; "product_sku"?: string; "product_image"?: string; "notes"?: string; "cart_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "GET", "/api/cart-items/{id}", input ?? {}, [], false, options)
  },

  /**
   * PUT /api/cart-items/{id}
   */
  putCartItemsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "quantity"?: number; "unit_price"?: number; "total_price"?: number; "tax_rate"?: number; "tax_amount"?: number; "discount_percentage"?: number; "discount_amount"?: number; "product_name"?: string; "product_sku"?: string; "product_image"?: string; "notes"?: string; "cart_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PUT", "/api/cart-items/{id}", input ?? {}, [], false, options)
  },

  /**
   * DELETE /api/cart-items/{id}
   */
  deleteCartItemsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "quantity"?: number; "unit_price"?: number; "total_price"?: number; "tax_rate"?: number; "tax_amount"?: number; "discount_percentage"?: number; "discount_amount"?: number; "product_name"?: string; "product_sku"?: string; "product_image"?: string; "notes"?: string; "cart_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "DELETE", "/api/cart-items/{id}", input ?? {}, [], false, options)
  },

  /**
   * PATCH /api/cart-items/{id}
   */
  patchCartItemsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "quantity"?: number; "unit_price"?: number; "total_price"?: number; "tax_rate"?: number; "tax_amount"?: number; "discount_percentage"?: number; "discount_amount"?: number; "product_name"?: string; "product_sku"?: string; "product_image"?: string; "notes"?: string; "cart_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PATCH", "/api/cart-items/{id}", input ?? {}, [], false, options)
  },

  /**
   * POST /api/cart/add
   */
  postCartAdd(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/cart/add", {}, [], false, options)
  },

  /**
   * POST /api/cart/update
   */
  postCartUpdate(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/cart/update", {}, [], false, options)
  },

  /**
   * GET /api/carts
   */
  getCarts(options?: RequestOptions): Promise<ApiResult<{ "data": Array<{ "id": number; "uuid": string; "status"?: "active" | "abandoned" | "converted" | "expired"; "total_items"?: number; "subtotal"?: number; "tax_amount"?: number; "discount_amount"?: number; "total"?: number; "expires_at"?: unknown; "currency"?: string; "notes"?: string; "applied_coupon_id"?: string; "customer_id"?: number; "coupon_id"?: number; "created_at"?: string; "updated_at"?: string }> }>> {
    return request(config, "GET", "/api/carts", {}, [], false, options)
  },

  /**
   * POST /api/carts
   */
  postCarts(options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "status"?: "active" | "abandoned" | "converted" | "expired"; "total_items"?: number; "subtotal"?: number; "tax_amount"?: number; "discount_amount"?: number; "total"?: number; "expires_at"?: unknown; "currency"?: string; "notes"?: string; "applied_coupon_id"?: string; "customer_id"?: number; "coupon_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "POST", "/api/carts", {}, [], false, options)
  },

  /**
   * POST /api/carts/bulk-delete
   */
  postCartsBulkDelete(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/carts/bulk-delete", {}, [], false, options)
  },

  /**
   * GET /api/carts/{id}
   */
  getCartsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "status"?: "active" | "abandoned" | "converted" | "expired"; "total_items"?: number; "subtotal"?: number; "tax_amount"?: number; "discount_amount"?: number; "total"?: number; "expires_at"?: unknown; "currency"?: string; "notes"?: string; "applied_coupon_id"?: string; "customer_id"?: number; "coupon_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "GET", "/api/carts/{id}", input ?? {}, [], false, options)
  },

  /**
   * PUT /api/carts/{id}
   */
  putCartsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "status"?: "active" | "abandoned" | "converted" | "expired"; "total_items"?: number; "subtotal"?: number; "tax_amount"?: number; "discount_amount"?: number; "total"?: number; "expires_at"?: unknown; "currency"?: string; "notes"?: string; "applied_coupon_id"?: string; "customer_id"?: number; "coupon_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PUT", "/api/carts/{id}", input ?? {}, [], false, options)
  },

  /**
   * DELETE /api/carts/{id}
   */
  deleteCartsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "status"?: "active" | "abandoned" | "converted" | "expired"; "total_items"?: number; "subtotal"?: number; "tax_amount"?: number; "discount_amount"?: number; "total"?: number; "expires_at"?: unknown; "currency"?: string; "notes"?: string; "applied_coupon_id"?: string; "customer_id"?: number; "coupon_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "DELETE", "/api/carts/{id}", input ?? {}, [], false, options)
  },

  /**
   * PATCH /api/carts/{id}
   */
  patchCartsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "status"?: "active" | "abandoned" | "converted" | "expired"; "total_items"?: number; "subtotal"?: number; "tax_amount"?: number; "discount_amount"?: number; "total"?: number; "expires_at"?: unknown; "currency"?: string; "notes"?: string; "applied_coupon_id"?: string; "customer_id"?: number; "coupon_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PATCH", "/api/carts/{id}", input ?? {}, [], false, options)
  },

  /**
   * POST /api/checkout/contact
   */
  postCheckoutContact(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/checkout/contact", {}, [], false, options)
  },

  /**
   * POST /api/checkout/place
   */
  postCheckoutPlace(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/checkout/place", {}, [], false, options)
  },

  /**
   * POST /api/checkout/shipping
   */
  postCheckoutShipping(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/checkout/shipping", {}, [], false, options)
  },

  /**
   * GET /api/comments
   */
  getComments(options?: RequestOptions): Promise<ApiResult<{ "data": Array<{ "id": number; "uuid": string; "author_name": string; "author_email": string; "content": string; "body"?: string; "post_title"?: string; "status": "pending" | "approved" | "spam" | "trash"; "ip_address"?: string; "user_agent"?: string; "is_approved"?: number; "post_id"?: number; "user_id"?: number; "created_at"?: string; "updated_at"?: string }> }>> {
    return request(config, "GET", "/api/comments", {}, [], false, options)
  },

  /**
   * POST /api/comments
   */
  postComments(options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "author_name": string; "author_email": string; "content": string; "body"?: string; "post_title"?: string; "status": "pending" | "approved" | "spam" | "trash"; "ip_address"?: string; "user_agent"?: string; "is_approved"?: number; "post_id"?: number; "user_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "POST", "/api/comments", {}, [], false, options)
  },

  /**
   * POST /api/comments/bulk-delete
   */
  postCommentsBulkDelete(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/comments/bulk-delete", {}, [], false, options)
  },

  /**
   * GET /api/comments/{id}
   */
  getCommentsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "author_name": string; "author_email": string; "content": string; "body"?: string; "post_title"?: string; "status": "pending" | "approved" | "spam" | "trash"; "ip_address"?: string; "user_agent"?: string; "is_approved"?: number; "post_id"?: number; "user_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "GET", "/api/comments/{id}", input ?? {}, [], false, options)
  },

  /**
   * PUT /api/comments/{id}
   */
  putCommentsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "author_name": string; "author_email": string; "content": string; "body"?: string; "post_title"?: string; "status": "pending" | "approved" | "spam" | "trash"; "ip_address"?: string; "user_agent"?: string; "is_approved"?: number; "post_id"?: number; "user_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PUT", "/api/comments/{id}", input ?? {}, [], false, options)
  },

  /**
   * DELETE /api/comments/{id}
   */
  deleteCommentsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "author_name": string; "author_email": string; "content": string; "body"?: string; "post_title"?: string; "status": "pending" | "approved" | "spam" | "trash"; "ip_address"?: string; "user_agent"?: string; "is_approved"?: number; "post_id"?: number; "user_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "DELETE", "/api/comments/{id}", input ?? {}, [], false, options)
  },

  /**
   * PATCH /api/comments/{id}
   */
  patchCommentsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "author_name": string; "author_email": string; "content": string; "body"?: string; "post_title"?: string; "status": "pending" | "approved" | "spam" | "trash"; "ip_address"?: string; "user_agent"?: string; "is_approved"?: number; "post_id"?: number; "user_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PATCH", "/api/comments/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/commerce/coupons
   */
  getCommerceCoupons(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/commerce/coupons", {}, [], false, options)
  },

  /**
   * POST /api/commerce/coupons
   */
  postCommerceCoupons(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/commerce/coupons", {}, [], false, options)
  },

  /**
   * GET /api/commerce/coupons/{id}
   */
  getCommerceCouponsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/commerce/coupons/{id}", input ?? {}, [], false, options)
  },

  /**
   * DELETE /api/commerce/coupons/{id}
   */
  deleteCommerceCouponsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "DELETE", "/api/commerce/coupons/{id}", input ?? {}, [], false, options)
  },

  /**
   * PATCH /api/commerce/coupons/{id}
   */
  patchCommerceCouponsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "PATCH", "/api/commerce/coupons/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/commerce/customers
   */
  getCommerceCustomers(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/commerce/customers", {}, [], false, options)
  },

  /**
   * POST /api/commerce/customers
   */
  postCommerceCustomers(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/commerce/customers", {}, [], false, options)
  },

  /**
   * GET /api/commerce/customers/{id}
   */
  getCommerceCustomersId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/commerce/customers/{id}", input ?? {}, [], false, options)
  },

  /**
   * DELETE /api/commerce/customers/{id}
   */
  deleteCommerceCustomersId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "DELETE", "/api/commerce/customers/{id}", input ?? {}, [], false, options)
  },

  /**
   * PATCH /api/commerce/customers/{id}
   */
  patchCommerceCustomersId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "PATCH", "/api/commerce/customers/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/commerce/dashboard
   */
  getCommerceDashboard(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/commerce/dashboard", {}, [], false, options)
  },

  /**
   * GET /api/commerce/delivery-routes
   */
  getCommerceDeliveryRoutes(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/commerce/delivery-routes", {}, [], false, options)
  },

  /**
   * POST /api/commerce/delivery-routes
   */
  postCommerceDeliveryRoutes(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/commerce/delivery-routes", {}, [], false, options)
  },

  /**
   * GET /api/commerce/delivery-routes/{id}
   */
  getCommerceDeliveryRoutesId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/commerce/delivery-routes/{id}", input ?? {}, [], false, options)
  },

  /**
   * DELETE /api/commerce/delivery-routes/{id}
   */
  deleteCommerceDeliveryRoutesId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "DELETE", "/api/commerce/delivery-routes/{id}", input ?? {}, [], false, options)
  },

  /**
   * PATCH /api/commerce/delivery-routes/{id}
   */
  patchCommerceDeliveryRoutesId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "PATCH", "/api/commerce/delivery-routes/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/commerce/digital-deliveries
   */
  getCommerceDigitalDeliveries(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/commerce/digital-deliveries", {}, [], false, options)
  },

  /**
   * POST /api/commerce/digital-deliveries
   */
  postCommerceDigitalDeliveries(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/commerce/digital-deliveries", {}, [], false, options)
  },

  /**
   * GET /api/commerce/digital-deliveries/{id}
   */
  getCommerceDigitalDeliveriesId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/commerce/digital-deliveries/{id}", input ?? {}, [], false, options)
  },

  /**
   * DELETE /api/commerce/digital-deliveries/{id}
   */
  deleteCommerceDigitalDeliveriesId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "DELETE", "/api/commerce/digital-deliveries/{id}", input ?? {}, [], false, options)
  },

  /**
   * PATCH /api/commerce/digital-deliveries/{id}
   */
  patchCommerceDigitalDeliveriesId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "PATCH", "/api/commerce/digital-deliveries/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/commerce/drivers
   */
  getCommerceDrivers(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/commerce/drivers", {}, [], false, options)
  },

  /**
   * POST /api/commerce/drivers
   */
  postCommerceDrivers(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/commerce/drivers", {}, [], false, options)
  },

  /**
   * GET /api/commerce/drivers/{id}
   */
  getCommerceDriversId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/commerce/drivers/{id}", input ?? {}, [], false, options)
  },

  /**
   * DELETE /api/commerce/drivers/{id}
   */
  deleteCommerceDriversId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "DELETE", "/api/commerce/drivers/{id}", input ?? {}, [], false, options)
  },

  /**
   * PATCH /api/commerce/drivers/{id}
   */
  patchCommerceDriversId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "PATCH", "/api/commerce/drivers/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/commerce/gift-cards
   */
  getCommerceGiftCards(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/commerce/gift-cards", {}, [], false, options)
  },

  /**
   * POST /api/commerce/gift-cards
   */
  postCommerceGiftCards(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/commerce/gift-cards", {}, [], false, options)
  },

  /**
   * GET /api/commerce/gift-cards/stats
   */
  getCommerceGiftCardsStats(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/commerce/gift-cards/stats", {}, [], false, options)
  },

  /**
   * GET /api/commerce/gift-cards/{id}
   */
  getCommerceGiftCardsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/commerce/gift-cards/{id}", input ?? {}, [], false, options)
  },

  /**
   * DELETE /api/commerce/gift-cards/{id}
   */
  deleteCommerceGiftCardsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "DELETE", "/api/commerce/gift-cards/{id}", input ?? {}, [], false, options)
  },

  /**
   * PATCH /api/commerce/gift-cards/{id}
   */
  patchCommerceGiftCardsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "PATCH", "/api/commerce/gift-cards/{id}", input ?? {}, [], false, options)
  },

  /**
   * PATCH /api/commerce/gift-cards/{id}/balance
   */
  patchCommerceGiftCardsIdBalance(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "PATCH", "/api/commerce/gift-cards/{id}/balance", input ?? {}, [], false, options)
  },

  /**
   * GET /api/commerce/license-keys
   */
  getCommerceLicenseKeys(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/commerce/license-keys", {}, [], false, options)
  },

  /**
   * POST /api/commerce/license-keys
   */
  postCommerceLicenseKeys(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/commerce/license-keys", {}, [], false, options)
  },

  /**
   * GET /api/commerce/license-keys/{id}
   */
  getCommerceLicenseKeysId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/commerce/license-keys/{id}", input ?? {}, [], false, options)
  },

  /**
   * DELETE /api/commerce/license-keys/{id}
   */
  deleteCommerceLicenseKeysId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "DELETE", "/api/commerce/license-keys/{id}", input ?? {}, [], false, options)
  },

  /**
   * PATCH /api/commerce/license-keys/{id}
   */
  patchCommerceLicenseKeysId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "PATCH", "/api/commerce/license-keys/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/commerce/orders
   */
  getCommerceOrders(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/commerce/orders", {}, [], false, options)
  },

  /**
   * POST /api/commerce/orders
   */
  postCommerceOrders(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/commerce/orders", {}, [], false, options)
  },

  /**
   * GET /api/commerce/orders/export
   */
  getCommerceOrdersExport(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/commerce/orders/export", {}, [], false, options)
  },

  /**
   * GET /api/commerce/orders/{id}
   */
  getCommerceOrdersId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/commerce/orders/{id}", input ?? {}, [], false, options)
  },

  /**
   * DELETE /api/commerce/orders/{id}
   */
  deleteCommerceOrdersId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "DELETE", "/api/commerce/orders/{id}", input ?? {}, [], false, options)
  },

  /**
   * PATCH /api/commerce/orders/{id}
   */
  patchCommerceOrdersId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "PATCH", "/api/commerce/orders/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/commerce/payment-stats
   */
  getCommercePaymentStats(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/commerce/payment-stats", {}, [], false, options)
  },

  /**
   * GET /api/commerce/payment-trends
   */
  getCommercePaymentTrends(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/commerce/payment-trends", {}, [], false, options)
  },

  /**
   * GET /api/commerce/payments
   */
  getCommercePayments(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/commerce/payments", {}, [], false, options)
  },

  /**
   * POST /api/commerce/payments
   */
  postCommercePayments(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/commerce/payments", {}, [], false, options)
  },

  /**
   * GET /api/commerce/payments/{id}
   */
  getCommercePaymentsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/commerce/payments/{id}", input ?? {}, [], false, options)
  },

  /**
   * DELETE /api/commerce/payments/{id}
   */
  deleteCommercePaymentsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "DELETE", "/api/commerce/payments/{id}", input ?? {}, [], false, options)
  },

  /**
   * PATCH /api/commerce/payments/{id}
   */
  patchCommercePaymentsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "PATCH", "/api/commerce/payments/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/commerce/pos
   */
  getCommercePos(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/commerce/pos", {}, [], false, options)
  },

  /**
   * GET /api/commerce/print-devices
   */
  getCommercePrintDevices(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/commerce/print-devices", {}, [], false, options)
  },

  /**
   * POST /api/commerce/print-devices
   */
  postCommercePrintDevices(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/commerce/print-devices", {}, [], false, options)
  },

  /**
   * GET /api/commerce/print-devices/{id}
   */
  getCommercePrintDevicesId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/commerce/print-devices/{id}", input ?? {}, [], false, options)
  },

  /**
   * DELETE /api/commerce/print-devices/{id}
   */
  deleteCommercePrintDevicesId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "DELETE", "/api/commerce/print-devices/{id}", input ?? {}, [], false, options)
  },

  /**
   * PATCH /api/commerce/print-devices/{id}
   */
  patchCommercePrintDevicesId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "PATCH", "/api/commerce/print-devices/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/commerce/product-categories
   */
  getCommerceProductCategories(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/commerce/product-categories", {}, [], false, options)
  },

  /**
   * POST /api/commerce/product-categories
   */
  postCommerceProductCategories(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/commerce/product-categories", {}, [], false, options)
  },

  /**
   * GET /api/commerce/product-manufacturers
   */
  getCommerceProductManufacturers(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/commerce/product-manufacturers", {}, [], false, options)
  },

  /**
   * POST /api/commerce/product-manufacturers
   */
  postCommerceProductManufacturers(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/commerce/product-manufacturers", {}, [], false, options)
  },

  /**
   * GET /api/commerce/product-manufacturers/{id}
   */
  getCommerceProductManufacturersId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/commerce/product-manufacturers/{id}", input ?? {}, [], false, options)
  },

  /**
   * DELETE /api/commerce/product-manufacturers/{id}
   */
  deleteCommerceProductManufacturersId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "DELETE", "/api/commerce/product-manufacturers/{id}", input ?? {}, [], false, options)
  },

  /**
   * PATCH /api/commerce/product-manufacturers/{id}
   */
  patchCommerceProductManufacturersId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "PATCH", "/api/commerce/product-manufacturers/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/commerce/products
   */
  getCommerceProducts(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/commerce/products", {}, [], false, options)
  },

  /**
   * POST /api/commerce/products
   */
  postCommerceProducts(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/commerce/products", {}, [], false, options)
  },

  /**
   * GET /api/commerce/products/reviews
   */
  getCommerceProductsReviews(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/commerce/products/reviews", {}, [], false, options)
  },

  /**
   * POST /api/commerce/products/reviews
   */
  postCommerceProductsReviews(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/commerce/products/reviews", {}, [], false, options)
  },

  /**
   * GET /api/commerce/products/reviews/{id}
   */
  getCommerceProductsReviewsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/commerce/products/reviews/{id}", input ?? {}, [], false, options)
  },

  /**
   * PATCH /api/commerce/products/reviews/{id}
   */
  patchCommerceProductsReviewsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "PATCH", "/api/commerce/products/reviews/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/commerce/products/units
   */
  getCommerceProductsUnits(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/commerce/products/units", {}, [], false, options)
  },

  /**
   * POST /api/commerce/products/units
   */
  postCommerceProductsUnits(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/commerce/products/units", {}, [], false, options)
  },

  /**
   * GET /api/commerce/products/units/{id}
   */
  getCommerceProductsUnitsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/commerce/products/units/{id}", input ?? {}, [], false, options)
  },

  /**
   * DELETE /api/commerce/products/units/{id}
   */
  deleteCommerceProductsUnitsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "DELETE", "/api/commerce/products/units/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/commerce/products/variants
   */
  getCommerceProductsVariants(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/commerce/products/variants", {}, [], false, options)
  },

  /**
   * POST /api/commerce/products/variants
   */
  postCommerceProductsVariants(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/commerce/products/variants", {}, [], false, options)
  },

  /**
   * GET /api/commerce/products/variants/{id}
   */
  getCommerceProductsVariantsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/commerce/products/variants/{id}", input ?? {}, [], false, options)
  },

  /**
   * DELETE /api/commerce/products/variants/{id}
   */
  deleteCommerceProductsVariantsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "DELETE", "/api/commerce/products/variants/{id}", input ?? {}, [], false, options)
  },

  /**
   * PATCH /api/commerce/products/variants/{id}
   */
  patchCommerceProductsVariantsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "PATCH", "/api/commerce/products/variants/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/commerce/products/{id}
   */
  getCommerceProductsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/commerce/products/{id}", input ?? {}, [], false, options)
  },

  /**
   * DELETE /api/commerce/products/{id}
   */
  deleteCommerceProductsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "DELETE", "/api/commerce/products/{id}", input ?? {}, [], false, options)
  },

  /**
   * PATCH /api/commerce/products/{id}
   */
  patchCommerceProductsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "PATCH", "/api/commerce/products/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/commerce/products/{productId}/variants
   */
  getCommerceProductsProductIdVariants(input: { "productId": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/commerce/products/{productId}/variants", input ?? {}, [], false, options)
  },

  /**
   * GET /api/commerce/receipts
   */
  getCommerceReceipts(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/commerce/receipts", {}, [], false, options)
  },

  /**
   * POST /api/commerce/receipts
   */
  postCommerceReceipts(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/commerce/receipts", {}, [], false, options)
  },

  /**
   * GET /api/commerce/receipts/{id}
   */
  getCommerceReceiptsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/commerce/receipts/{id}", input ?? {}, [], false, options)
  },

  /**
   * DELETE /api/commerce/receipts/{id}
   */
  deleteCommerceReceiptsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "DELETE", "/api/commerce/receipts/{id}", input ?? {}, [], false, options)
  },

  /**
   * PATCH /api/commerce/receipts/{id}
   */
  patchCommerceReceiptsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "PATCH", "/api/commerce/receipts/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/commerce/shipping-methods
   */
  getCommerceShippingMethods(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/commerce/shipping-methods", {}, [], false, options)
  },

  /**
   * POST /api/commerce/shipping-methods
   */
  postCommerceShippingMethods(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/commerce/shipping-methods", {}, [], false, options)
  },

  /**
   * GET /api/commerce/shipping-methods/{id}
   */
  getCommerceShippingMethodsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/commerce/shipping-methods/{id}", input ?? {}, [], false, options)
  },

  /**
   * DELETE /api/commerce/shipping-methods/{id}
   */
  deleteCommerceShippingMethodsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "DELETE", "/api/commerce/shipping-methods/{id}", input ?? {}, [], false, options)
  },

  /**
   * PATCH /api/commerce/shipping-methods/{id}
   */
  patchCommerceShippingMethodsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "PATCH", "/api/commerce/shipping-methods/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/commerce/shipping-rates
   */
  getCommerceShippingRates(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/commerce/shipping-rates", {}, [], false, options)
  },

  /**
   * POST /api/commerce/shipping-rates
   */
  postCommerceShippingRates(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/commerce/shipping-rates", {}, [], false, options)
  },

  /**
   * GET /api/commerce/shipping-rates/{id}
   */
  getCommerceShippingRatesId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/commerce/shipping-rates/{id}", input ?? {}, [], false, options)
  },

  /**
   * DELETE /api/commerce/shipping-rates/{id}
   */
  deleteCommerceShippingRatesId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "DELETE", "/api/commerce/shipping-rates/{id}", input ?? {}, [], false, options)
  },

  /**
   * PATCH /api/commerce/shipping-rates/{id}
   */
  patchCommerceShippingRatesId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "PATCH", "/api/commerce/shipping-rates/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/commerce/shipping-zones
   */
  getCommerceShippingZones(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/commerce/shipping-zones", {}, [], false, options)
  },

  /**
   * POST /api/commerce/shipping-zones
   */
  postCommerceShippingZones(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/commerce/shipping-zones", {}, [], false, options)
  },

  /**
   * GET /api/commerce/shipping-zones/{id}
   */
  getCommerceShippingZonesId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/commerce/shipping-zones/{id}", input ?? {}, [], false, options)
  },

  /**
   * DELETE /api/commerce/shipping-zones/{id}
   */
  deleteCommerceShippingZonesId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "DELETE", "/api/commerce/shipping-zones/{id}", input ?? {}, [], false, options)
  },

  /**
   * PATCH /api/commerce/shipping-zones/{id}
   */
  patchCommerceShippingZonesId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "PATCH", "/api/commerce/shipping-zones/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/commerce/tax-rates
   */
  getCommerceTaxRates(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/commerce/tax-rates", {}, [], false, options)
  },

  /**
   * POST /api/commerce/tax-rates
   */
  postCommerceTaxRates(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/commerce/tax-rates", {}, [], false, options)
  },

  /**
   * GET /api/commerce/tax-rates/{id}
   */
  getCommerceTaxRatesId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/commerce/tax-rates/{id}", input ?? {}, [], false, options)
  },

  /**
   * DELETE /api/commerce/tax-rates/{id}
   */
  deleteCommerceTaxRatesId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "DELETE", "/api/commerce/tax-rates/{id}", input ?? {}, [], false, options)
  },

  /**
   * PATCH /api/commerce/tax-rates/{id}
   */
  patchCommerceTaxRatesId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "PATCH", "/api/commerce/tax-rates/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/commerce/waitlist/products
   */
  getCommerceWaitlistProducts(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/commerce/waitlist/products", {}, [], false, options)
  },

  /**
   * POST /api/commerce/waitlist/products
   */
  postCommerceWaitlistProducts(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/commerce/waitlist/products", {}, [], false, options)
  },

  /**
   * GET /api/commerce/waitlist/products/analytics
   */
  getCommerceWaitlistProductsAnalytics(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/commerce/waitlist/products/analytics", {}, [], false, options)
  },

  /**
   * GET /api/commerce/waitlist/products/quantity-distribution
   */
  getCommerceWaitlistProductsQuantityDistribution(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/commerce/waitlist/products/quantity-distribution", {}, [], false, options)
  },

  /**
   * GET /api/commerce/waitlist/products/status
   */
  getCommerceWaitlistProductsStatus(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/commerce/waitlist/products/status", {}, [], false, options)
  },

  /**
   * GET /api/commerce/waitlist/products/time-series
   */
  getCommerceWaitlistProductsTimeSeries(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/commerce/waitlist/products/time-series", {}, [], false, options)
  },

  /**
   * GET /api/commerce/waitlist/products/{id}
   */
  getCommerceWaitlistProductsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/commerce/waitlist/products/{id}", input ?? {}, [], false, options)
  },

  /**
   * DELETE /api/commerce/waitlist/products/{id}
   */
  deleteCommerceWaitlistProductsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "DELETE", "/api/commerce/waitlist/products/{id}", input ?? {}, [], false, options)
  },

  /**
   * PATCH /api/commerce/waitlist/products/{id}
   */
  patchCommerceWaitlistProductsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "PATCH", "/api/commerce/waitlist/products/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/commerce/waitlist/restaurants
   */
  getCommerceWaitlistRestaurants(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/commerce/waitlist/restaurants", {}, [], false, options)
  },

  /**
   * POST /api/commerce/waitlist/restaurants
   */
  postCommerceWaitlistRestaurants(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/commerce/waitlist/restaurants", {}, [], false, options)
  },

  /**
   * GET /api/commerce/waitlist/restaurants/dashboard
   */
  getCommerceWaitlistRestaurantsDashboard(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/commerce/waitlist/restaurants/dashboard", {}, [], false, options)
  },

  /**
   * GET /api/commerce/waitlist/restaurants/{id}
   */
  getCommerceWaitlistRestaurantsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/commerce/waitlist/restaurants/{id}", input ?? {}, [], false, options)
  },

  /**
   * DELETE /api/commerce/waitlist/restaurants/{id}
   */
  deleteCommerceWaitlistRestaurantsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "DELETE", "/api/commerce/waitlist/restaurants/{id}", input ?? {}, [], false, options)
  },

  /**
   * PATCH /api/commerce/waitlist/restaurants/{id}
   */
  patchCommerceWaitlistRestaurantsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "PATCH", "/api/commerce/waitlist/restaurants/{id}", input ?? {}, [], false, options)
  },

  /**
   * contact.send
   */
  contactSend(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/contact", {}, [], false, options)
  },

  /**
   * GET /api/coupons
   */
  getCoupons(options?: RequestOptions): Promise<ApiResult<{ "data": Array<{ "id": number; "uuid": string; "code"?: string; "description"?: string; "status"?: "Active" | "Scheduled" | "Expired"; "is_active"?: boolean; "discount_type"?: "fixed_amount" | "percentage"; "discount_value"?: number; "min_order_amount"?: number; "max_discount_amount"?: number; "free_product_id"?: string; "usage_limit"?: number; "usage_count"?: number; "start_date"?: unknown; "end_date"?: unknown; "product_id"?: number; "created_at"?: string; "updated_at"?: string }> }>> {
    return request(config, "GET", "/api/coupons", {}, [], false, options)
  },

  /**
   * POST /api/coupons
   */
  postCoupons(options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "code"?: string; "description"?: string; "status"?: "Active" | "Scheduled" | "Expired"; "is_active"?: boolean; "discount_type"?: "fixed_amount" | "percentage"; "discount_value"?: number; "min_order_amount"?: number; "max_discount_amount"?: number; "free_product_id"?: string; "usage_limit"?: number; "usage_count"?: number; "start_date"?: unknown; "end_date"?: unknown; "product_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "POST", "/api/coupons", {}, [], false, options)
  },

  /**
   * POST /api/coupons/bulk-delete
   */
  postCouponsBulkDelete(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/coupons/bulk-delete", {}, [], false, options)
  },

  /**
   * GET /api/coupons/{id}
   */
  getCouponsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "code"?: string; "description"?: string; "status"?: "Active" | "Scheduled" | "Expired"; "is_active"?: boolean; "discount_type"?: "fixed_amount" | "percentage"; "discount_value"?: number; "min_order_amount"?: number; "max_discount_amount"?: number; "free_product_id"?: string; "usage_limit"?: number; "usage_count"?: number; "start_date"?: unknown; "end_date"?: unknown; "product_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "GET", "/api/coupons/{id}", input ?? {}, [], false, options)
  },

  /**
   * PUT /api/coupons/{id}
   */
  putCouponsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "code"?: string; "description"?: string; "status"?: "Active" | "Scheduled" | "Expired"; "is_active"?: boolean; "discount_type"?: "fixed_amount" | "percentage"; "discount_value"?: number; "min_order_amount"?: number; "max_discount_amount"?: number; "free_product_id"?: string; "usage_limit"?: number; "usage_count"?: number; "start_date"?: unknown; "end_date"?: unknown; "product_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PUT", "/api/coupons/{id}", input ?? {}, [], false, options)
  },

  /**
   * DELETE /api/coupons/{id}
   */
  deleteCouponsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "code"?: string; "description"?: string; "status"?: "Active" | "Scheduled" | "Expired"; "is_active"?: boolean; "discount_type"?: "fixed_amount" | "percentage"; "discount_value"?: number; "min_order_amount"?: number; "max_discount_amount"?: number; "free_product_id"?: string; "usage_limit"?: number; "usage_count"?: number; "start_date"?: unknown; "end_date"?: unknown; "product_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "DELETE", "/api/coupons/{id}", input ?? {}, [], false, options)
  },

  /**
   * PATCH /api/coupons/{id}
   */
  patchCouponsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "code"?: string; "description"?: string; "status"?: "Active" | "Scheduled" | "Expired"; "is_active"?: boolean; "discount_type"?: "fixed_amount" | "percentage"; "discount_value"?: number; "min_order_amount"?: number; "max_discount_amount"?: number; "free_product_id"?: string; "usage_limit"?: number; "usage_count"?: number; "start_date"?: unknown; "end_date"?: unknown; "product_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PATCH", "/api/coupons/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/customers
   */
  getCustomers(options?: RequestOptions): Promise<ApiResult<{ "data": Array<{ "id": number; "uuid": string; "name"?: string; "email"?: string; "phone"?: string; "total_spent"?: number; "last_order"?: string; "status"?: "Active" | "Inactive"; "avatar"?: string; "user_id"?: number; "created_at"?: string; "updated_at"?: string }> }>> {
    return request(config, "GET", "/api/customers", {}, [], false, options)
  },

  /**
   * POST /api/customers
   */
  postCustomers(options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name"?: string; "email"?: string; "phone"?: string; "total_spent"?: number; "last_order"?: string; "status"?: "Active" | "Inactive"; "avatar"?: string; "user_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "POST", "/api/customers", {}, [], false, options)
  },

  /**
   * POST /api/customers/bulk-delete
   */
  postCustomersBulkDelete(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/customers/bulk-delete", {}, [], false, options)
  },

  /**
   * GET /api/customers/{id}
   */
  getCustomersId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name"?: string; "email"?: string; "phone"?: string; "total_spent"?: number; "last_order"?: string; "status"?: "Active" | "Inactive"; "avatar"?: string; "user_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "GET", "/api/customers/{id}", input ?? {}, [], false, options)
  },

  /**
   * PUT /api/customers/{id}
   */
  putCustomersId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name"?: string; "email"?: string; "phone"?: string; "total_spent"?: number; "last_order"?: string; "status"?: "Active" | "Inactive"; "avatar"?: string; "user_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PUT", "/api/customers/{id}", input ?? {}, [], false, options)
  },

  /**
   * DELETE /api/customers/{id}
   */
  deleteCustomersId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name"?: string; "email"?: string; "phone"?: string; "total_spent"?: number; "last_order"?: string; "status"?: "Active" | "Inactive"; "avatar"?: string; "user_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "DELETE", "/api/customers/{id}", input ?? {}, [], false, options)
  },

  /**
   * PATCH /api/customers/{id}
   */
  patchCustomersId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name"?: string; "email"?: string; "phone"?: string; "total_spent"?: number; "last_order"?: string; "status"?: "Active" | "Inactive"; "avatar"?: string; "user_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PATCH", "/api/customers/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/dashboard/analytics/events
   */
  getDashboardAnalyticsEvents(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/dashboard/analytics/events", {}, [], false, options)
  },

  /**
   * POST /api/dashboard/analytics/events
   */
  postDashboardAnalyticsEvents(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/dashboard/analytics/events", {}, [], false, options)
  },

  /**
   * GET /api/dashboard/analytics/marketing
   */
  getDashboardAnalyticsMarketing(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/dashboard/analytics/marketing", {}, [], false, options)
  },

  /**
   * GET /api/dashboard/analytics/sales
   */
  getDashboardAnalyticsSales(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/dashboard/analytics/sales", {}, [], false, options)
  },

  /**
   * GET /api/dashboard/analytics/web
   */
  getDashboardAnalyticsWeb(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/dashboard/analytics/web", {}, [], false, options)
  },

  /**
   * GET /api/dashboard/auth/me
   */
  getDashboardAuthMe(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/dashboard/auth/me", {}, [], false, options)
  },

  /**
   * GET /api/dashboard/authors
   */
  getDashboardAuthors(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/dashboard/authors", {}, [], false, options)
  },

  /**
   * POST /api/dashboard/authors
   */
  postDashboardAuthors(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/dashboard/authors", {}, [], false, options)
  },

  /**
   * DELETE /api/dashboard/authors/{id}
   */
  deleteDashboardAuthorsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "DELETE", "/api/dashboard/authors/{id}", input ?? {}, [], false, options)
  },

  /**
   * PATCH /api/dashboard/authors/{id}
   */
  patchDashboardAuthorsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "PATCH", "/api/dashboard/authors/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/dashboard/blog
   */
  getDashboardBlog(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/dashboard/blog", {}, [], false, options)
  },

  /**
   * POST /api/dashboard/blog
   */
  postDashboardBlog(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/dashboard/blog", {}, [], false, options)
  },

  /**
   * GET /api/dashboard/blog/{slug}
   */
  getDashboardBlogSlug(input: { "slug": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/dashboard/blog/{slug}", input ?? {}, [], false, options)
  },

  /**
   * DELETE /api/dashboard/blog/{slug}
   */
  deleteDashboardBlogSlug(input: { "slug": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "DELETE", "/api/dashboard/blog/{slug}", input ?? {}, [], false, options)
  },

  /**
   * PATCH /api/dashboard/blog/{slug}
   */
  patchDashboardBlogSlug(input: { "slug": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "PATCH", "/api/dashboard/blog/{slug}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/dashboard/buddy/chat
   */
  getDashboardBuddyChat(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/dashboard/buddy/chat", {}, [], false, options)
  },

  /**
   * POST /api/dashboard/buddy/chat
   */
  postDashboardBuddyChat(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/dashboard/buddy/chat", {}, [], false, options)
  },

  /**
   * POST /api/dashboard/buddy/chat/clear
   */
  postDashboardBuddyChatClear(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/dashboard/buddy/chat/clear", {}, [], false, options)
  },

  /**
   * GET /api/dashboard/categories
   */
  getDashboardCategories(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/dashboard/categories", {}, [], false, options)
  },

  /**
   * POST /api/dashboard/categories
   */
  postDashboardCategories(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/dashboard/categories", {}, [], false, options)
  },

  /**
   * DELETE /api/dashboard/categories/{id}
   */
  deleteDashboardCategoriesId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "DELETE", "/api/dashboard/categories/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/dashboard/ci/repos/{owner}/{name}/runs
   */
  getDashboardCiReposOwnerNameRuns(input: { "owner": string; "name": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/dashboard/ci/repos/{owner}/{name}/runs", input ?? {}, [], false, options)
  },

  /**
   * GET /api/dashboard/ci/repos/{owner}/{name}/runs/{runId}/jobs
   */
  getDashboardCiReposOwnerNameRunsRunIdJobs(input: { "owner": string; "name": string; "runId": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/dashboard/ci/repos/{owner}/{name}/runs/{runId}/jobs", input ?? {}, [], false, options)
  },

  /**
   * GET /api/dashboard/ci/runner-history
   */
  getDashboardCiRunnerHistory(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/dashboard/ci/runner-history", {}, [], false, options)
  },

  /**
   * GET /api/dashboard/ci/status
   */
  getDashboardCiStatus(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/dashboard/ci/status", {}, [], false, options)
  },

  /**
   * GET /api/dashboard/comments
   */
  getDashboardComments(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/dashboard/comments", {}, [], false, options)
  },

  /**
   * DELETE /api/dashboard/comments/{id}
   */
  deleteDashboardCommentsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "DELETE", "/api/dashboard/comments/{id}", input ?? {}, [], false, options)
  },

  /**
   * PATCH /api/dashboard/comments/{id}
   */
  patchDashboardCommentsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "PATCH", "/api/dashboard/comments/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/dashboard/commerce/categories
   */
  getDashboardCommerceCategories(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/dashboard/commerce/categories", {}, [], false, options)
  },

  /**
   * GET /api/dashboard/commerce/coupons
   */
  getDashboardCommerceCoupons(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/dashboard/commerce/coupons", {}, [], false, options)
  },

  /**
   * GET /api/dashboard/commerce/customers
   */
  getDashboardCommerceCustomers(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/dashboard/commerce/customers", {}, [], false, options)
  },

  /**
   * GET /api/dashboard/commerce/delivery
   */
  getDashboardCommerceDelivery(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/dashboard/commerce/delivery", {}, [], false, options)
  },

  /**
   * GET /api/dashboard/commerce/delivery-routes
   */
  getDashboardCommerceDeliveryRoutes(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/dashboard/commerce/delivery-routes", {}, [], false, options)
  },

  /**
   * POST /api/dashboard/commerce/delivery-routes
   */
  postDashboardCommerceDeliveryRoutes(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/dashboard/commerce/delivery-routes", {}, [], false, options)
  },

  /**
   * GET /api/dashboard/commerce/delivery-routes/{id}
   */
  getDashboardCommerceDeliveryRoutesId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/dashboard/commerce/delivery-routes/{id}", input ?? {}, [], false, options)
  },

  /**
   * DELETE /api/dashboard/commerce/delivery-routes/{id}
   */
  deleteDashboardCommerceDeliveryRoutesId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "DELETE", "/api/dashboard/commerce/delivery-routes/{id}", input ?? {}, [], false, options)
  },

  /**
   * PATCH /api/dashboard/commerce/delivery-routes/{id}
   */
  patchDashboardCommerceDeliveryRoutesId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "PATCH", "/api/dashboard/commerce/delivery-routes/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/dashboard/commerce/digital-deliveries
   */
  getDashboardCommerceDigitalDeliveries(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/dashboard/commerce/digital-deliveries", {}, [], false, options)
  },

  /**
   * POST /api/dashboard/commerce/digital-deliveries
   */
  postDashboardCommerceDigitalDeliveries(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/dashboard/commerce/digital-deliveries", {}, [], false, options)
  },

  /**
   * GET /api/dashboard/commerce/digital-deliveries/{id}
   */
  getDashboardCommerceDigitalDeliveriesId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/dashboard/commerce/digital-deliveries/{id}", input ?? {}, [], false, options)
  },

  /**
   * DELETE /api/dashboard/commerce/digital-deliveries/{id}
   */
  deleteDashboardCommerceDigitalDeliveriesId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "DELETE", "/api/dashboard/commerce/digital-deliveries/{id}", input ?? {}, [], false, options)
  },

  /**
   * PATCH /api/dashboard/commerce/digital-deliveries/{id}
   */
  patchDashboardCommerceDigitalDeliveriesId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "PATCH", "/api/dashboard/commerce/digital-deliveries/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/dashboard/commerce/drivers
   */
  getDashboardCommerceDrivers(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/dashboard/commerce/drivers", {}, [], false, options)
  },

  /**
   * POST /api/dashboard/commerce/drivers
   */
  postDashboardCommerceDrivers(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/dashboard/commerce/drivers", {}, [], false, options)
  },

  /**
   * GET /api/dashboard/commerce/drivers/{id}
   */
  getDashboardCommerceDriversId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/dashboard/commerce/drivers/{id}", input ?? {}, [], false, options)
  },

  /**
   * DELETE /api/dashboard/commerce/drivers/{id}
   */
  deleteDashboardCommerceDriversId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "DELETE", "/api/dashboard/commerce/drivers/{id}", input ?? {}, [], false, options)
  },

  /**
   * PATCH /api/dashboard/commerce/drivers/{id}
   */
  patchDashboardCommerceDriversId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "PATCH", "/api/dashboard/commerce/drivers/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/dashboard/commerce/gift-cards
   */
  getDashboardCommerceGiftCards(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/dashboard/commerce/gift-cards", {}, [], false, options)
  },

  /**
   * GET /api/dashboard/commerce/license-key-options
   */
  getDashboardCommerceLicenseKeyOptions(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/dashboard/commerce/license-key-options", {}, [], false, options)
  },

  /**
   * GET /api/dashboard/commerce/license-keys
   */
  getDashboardCommerceLicenseKeys(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/dashboard/commerce/license-keys", {}, [], false, options)
  },

  /**
   * POST /api/dashboard/commerce/license-keys
   */
  postDashboardCommerceLicenseKeys(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/dashboard/commerce/license-keys", {}, [], false, options)
  },

  /**
   * GET /api/dashboard/commerce/license-keys/{id}
   */
  getDashboardCommerceLicenseKeysId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/dashboard/commerce/license-keys/{id}", input ?? {}, [], false, options)
  },

  /**
   * DELETE /api/dashboard/commerce/license-keys/{id}
   */
  deleteDashboardCommerceLicenseKeysId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "DELETE", "/api/dashboard/commerce/license-keys/{id}", input ?? {}, [], false, options)
  },

  /**
   * PATCH /api/dashboard/commerce/license-keys/{id}
   */
  patchDashboardCommerceLicenseKeysId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "PATCH", "/api/dashboard/commerce/license-keys/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/dashboard/commerce/manufacturers
   */
  getDashboardCommerceManufacturers(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/dashboard/commerce/manufacturers", {}, [], false, options)
  },

  /**
   * GET /api/dashboard/commerce/orders
   */
  getDashboardCommerceOrders(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/dashboard/commerce/orders", {}, [], false, options)
  },

  /**
   * GET /api/dashboard/commerce/payments
   */
  getDashboardCommercePayments(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/dashboard/commerce/payments", {}, [], false, options)
  },

  /**
   * POST /api/dashboard/commerce/payments/{id}/refund
   */
  postDashboardCommercePaymentsIdRefund(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/dashboard/commerce/payments/{id}/refund", input ?? {}, [], false, options)
  },

  /**
   * GET /api/dashboard/commerce/pos
   */
  getDashboardCommercePos(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/dashboard/commerce/pos", {}, [], false, options)
  },

  /**
   * POST /api/dashboard/commerce/pos/checkout
   */
  postDashboardCommercePosCheckout(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/dashboard/commerce/pos/checkout", {}, [], false, options)
  },

  /**
   * GET /api/dashboard/commerce/print-devices
   */
  getDashboardCommercePrintDevices(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/dashboard/commerce/print-devices", {}, [], false, options)
  },

  /**
   * GET /api/dashboard/commerce/print-logs
   */
  getDashboardCommercePrintLogs(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/dashboard/commerce/print-logs", {}, [], false, options)
  },

  /**
   * GET /api/dashboard/commerce/products
   */
  getDashboardCommerceProducts(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/dashboard/commerce/products", {}, [], false, options)
  },

  /**
   * GET /api/dashboard/commerce/products/{id}
   */
  getDashboardCommerceProductsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/dashboard/commerce/products/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/dashboard/commerce/reviews
   */
  getDashboardCommerceReviews(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/dashboard/commerce/reviews", {}, [], false, options)
  },

  /**
   * GET /api/dashboard/commerce/shipping-methods
   */
  getDashboardCommerceShippingMethods(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/dashboard/commerce/shipping-methods", {}, [], false, options)
  },

  /**
   * POST /api/dashboard/commerce/shipping-methods
   */
  postDashboardCommerceShippingMethods(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/dashboard/commerce/shipping-methods", {}, [], false, options)
  },

  /**
   * GET /api/dashboard/commerce/shipping-methods/{id}
   */
  getDashboardCommerceShippingMethodsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/dashboard/commerce/shipping-methods/{id}", input ?? {}, [], false, options)
  },

  /**
   * DELETE /api/dashboard/commerce/shipping-methods/{id}
   */
  deleteDashboardCommerceShippingMethodsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "DELETE", "/api/dashboard/commerce/shipping-methods/{id}", input ?? {}, [], false, options)
  },

  /**
   * PATCH /api/dashboard/commerce/shipping-methods/{id}
   */
  patchDashboardCommerceShippingMethodsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "PATCH", "/api/dashboard/commerce/shipping-methods/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/dashboard/commerce/shipping-rates
   */
  getDashboardCommerceShippingRates(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/dashboard/commerce/shipping-rates", {}, [], false, options)
  },

  /**
   * POST /api/dashboard/commerce/shipping-rates
   */
  postDashboardCommerceShippingRates(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/dashboard/commerce/shipping-rates", {}, [], false, options)
  },

  /**
   * GET /api/dashboard/commerce/shipping-rates/{id}
   */
  getDashboardCommerceShippingRatesId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/dashboard/commerce/shipping-rates/{id}", input ?? {}, [], false, options)
  },

  /**
   * DELETE /api/dashboard/commerce/shipping-rates/{id}
   */
  deleteDashboardCommerceShippingRatesId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "DELETE", "/api/dashboard/commerce/shipping-rates/{id}", input ?? {}, [], false, options)
  },

  /**
   * PATCH /api/dashboard/commerce/shipping-rates/{id}
   */
  patchDashboardCommerceShippingRatesId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "PATCH", "/api/dashboard/commerce/shipping-rates/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/dashboard/commerce/shipping-zones
   */
  getDashboardCommerceShippingZones(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/dashboard/commerce/shipping-zones", {}, [], false, options)
  },

  /**
   * POST /api/dashboard/commerce/shipping-zones
   */
  postDashboardCommerceShippingZones(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/dashboard/commerce/shipping-zones", {}, [], false, options)
  },

  /**
   * GET /api/dashboard/commerce/shipping-zones/{id}
   */
  getDashboardCommerceShippingZonesId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/dashboard/commerce/shipping-zones/{id}", input ?? {}, [], false, options)
  },

  /**
   * DELETE /api/dashboard/commerce/shipping-zones/{id}
   */
  deleteDashboardCommerceShippingZonesId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "DELETE", "/api/dashboard/commerce/shipping-zones/{id}", input ?? {}, [], false, options)
  },

  /**
   * PATCH /api/dashboard/commerce/shipping-zones/{id}
   */
  patchDashboardCommerceShippingZonesId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "PATCH", "/api/dashboard/commerce/shipping-zones/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/dashboard/commerce/stats
   */
  getDashboardCommerceStats(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/dashboard/commerce/stats", {}, [], false, options)
  },

  /**
   * GET /api/dashboard/commerce/taxes
   */
  getDashboardCommerceTaxes(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/dashboard/commerce/taxes", {}, [], false, options)
  },

  /**
   * PATCH /api/dashboard/commerce/taxes/{id}/default
   */
  patchDashboardCommerceTaxesIdDefault(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "PATCH", "/api/dashboard/commerce/taxes/{id}/default", input ?? {}, [], false, options)
  },

  /**
   * GET /api/dashboard/commerce/units
   */
  getDashboardCommerceUnits(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/dashboard/commerce/units", {}, [], false, options)
  },

  /**
   * PATCH /api/dashboard/commerce/units/{id}/default
   */
  patchDashboardCommerceUnitsIdDefault(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "PATCH", "/api/dashboard/commerce/units/{id}/default", input ?? {}, [], false, options)
  },

  /**
   * GET /api/dashboard/commerce/variants
   */
  getDashboardCommerceVariants(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/dashboard/commerce/variants", {}, [], false, options)
  },

  /**
   * GET /api/dashboard/commerce/waitlist-products
   */
  getDashboardCommerceWaitlistProducts(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/dashboard/commerce/waitlist-products", {}, [], false, options)
  },

  /**
   * GET /api/dashboard/commerce/waitlist-restaurants
   */
  getDashboardCommerceWaitlistRestaurants(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/dashboard/commerce/waitlist-restaurants", {}, [], false, options)
  },

  /**
   * GET /api/dashboard/data/activity
   */
  getDashboardDataActivity(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/dashboard/data/activity", {}, [], false, options)
  },

  /**
   * GET /api/dashboard/data/subscribers
   */
  getDashboardDataSubscribers(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/dashboard/data/subscribers", {}, [], false, options)
  },

  /**
   * GET /api/dashboard/data/teams
   */
  getDashboardDataTeams(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/dashboard/data/teams", {}, [], false, options)
  },

  /**
   * GET /api/dashboard/data/users
   */
  getDashboardDataUsers(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/dashboard/data/users", {}, [], false, options)
  },

  /**
   * GET /api/dashboard/deployments
   */
  getDashboardDeployments(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/dashboard/deployments", {}, [], false, options)
  },

  /**
   * POST /api/dashboard/deployments
   */
  postDashboardDeployments(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/dashboard/deployments", {}, [], false, options)
  },

  /**
   * GET /api/dashboard/deployments/avg-time
   */
  getDashboardDeploymentsAvgTime(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/dashboard/deployments/avg-time", {}, [], false, options)
  },

  /**
   * GET /api/dashboard/deployments/count
   */
  getDashboardDeploymentsCount(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/dashboard/deployments/count", {}, [], false, options)
  },

  /**
   * GET /api/dashboard/deployments/recent
   */
  getDashboardDeploymentsRecent(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/dashboard/deployments/recent", {}, [], false, options)
  },

  /**
   * GET /api/dashboard/deployments/script
   */
  getDashboardDeploymentsScript(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/dashboard/deployments/script", {}, [], false, options)
  },

  /**
   * PUT /api/dashboard/deployments/script
   */
  putDashboardDeploymentsScript(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "PUT", "/api/dashboard/deployments/script", {}, [], false, options)
  },

  /**
   * GET /api/dashboard/deployments/terminal
   */
  getDashboardDeploymentsTerminal(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/dashboard/deployments/terminal", {}, [], false, options)
  },

  /**
   * GET /api/dashboard/deployments/{id}
   */
  getDashboardDeploymentsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/dashboard/deployments/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/dashboard/email/activity
   */
  getDashboardEmailActivity(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/dashboard/email/activity", {}, [], false, options)
  },

  /**
   * GET /api/dashboard/email/inbox
   */
  getDashboardEmailInbox(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/dashboard/email/inbox", {}, [], false, options)
  },

  /**
   * GET /api/dashboard/email/inbox/{id}
   */
  getDashboardEmailInboxId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/dashboard/email/inbox/{id}", input ?? {}, [], false, options)
  },

  /**
   * DELETE /api/dashboard/email/inbox/{id}
   */
  deleteDashboardEmailInboxId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "DELETE", "/api/dashboard/email/inbox/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/dashboard/email/preferences
   */
  getDashboardEmailPreferences(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/dashboard/email/preferences", {}, [], false, options)
  },

  /**
   * PUT /api/dashboard/email/preferences
   */
  putDashboardEmailPreferences(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "PUT", "/api/dashboard/email/preferences", {}, [], false, options)
  },

  /**
   * POST /api/dashboard/email/read
   */
  postDashboardEmailRead(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/dashboard/email/read", {}, [], false, options)
  },

  /**
   * POST /api/dashboard/email/send
   */
  postDashboardEmailSend(input: { body: { "to": string; "subject": string; "body": string } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/dashboard/email/send", input ?? {}, [], true, options)
  },

  /**
   * GET /api/dashboard/email/stats
   */
  getDashboardEmailStats(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/dashboard/email/stats", {}, [], false, options)
  },

  /**
   * POST /api/dashboard/email/unread
   */
  postDashboardEmailUnread(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/dashboard/email/unread", {}, [], false, options)
  },

  /**
   * GET /api/dashboard/home
   */
  getDashboardHome(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/dashboard/home", {}, [], false, options)
  },

  /**
   * GET /api/dashboard/jobs
   */
  getDashboardJobs(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/dashboard/jobs", {}, [], false, options)
  },

  /**
   * GET /api/dashboard/jobs/stats
   */
  getDashboardJobsStats(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/dashboard/jobs/stats", {}, [], false, options)
  },

  /**
   * GET /api/dashboard/jobs/{id}
   */
  getDashboardJobsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/dashboard/jobs/{id}", input ?? {}, [], false, options)
  },

  /**
   * POST /api/dashboard/jobs/{id}/retry
   */
  postDashboardJobsIdRetry(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/dashboard/jobs/{id}/retry", input ?? {}, [], false, options)
  },

  /**
   * GET /api/dashboard/kanban/boards
   */
  getDashboardKanbanBoards(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/dashboard/kanban/boards", {}, [], false, options)
  },

  /**
   * POST /api/dashboard/kanban/boards
   */
  postDashboardKanbanBoards(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/dashboard/kanban/boards", {}, [], false, options)
  },

  /**
   * POST /api/dashboard/kanban/boards/reorder
   */
  postDashboardKanbanBoardsReorder(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/dashboard/kanban/boards/reorder", {}, [], false, options)
  },

  /**
   * GET /api/dashboard/kanban/boards/{id}
   */
  getDashboardKanbanBoardsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/dashboard/kanban/boards/{id}", input ?? {}, [], false, options)
  },

  /**
   * DELETE /api/dashboard/kanban/boards/{id}
   */
  deleteDashboardKanbanBoardsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "DELETE", "/api/dashboard/kanban/boards/{id}", input ?? {}, [], false, options)
  },

  /**
   * PATCH /api/dashboard/kanban/boards/{id}
   */
  patchDashboardKanbanBoardsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "PATCH", "/api/dashboard/kanban/boards/{id}", input ?? {}, [], false, options)
  },

  /**
   * POST /api/dashboard/kanban/cards
   */
  postDashboardKanbanCards(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/dashboard/kanban/cards", {}, [], false, options)
  },

  /**
   * POST /api/dashboard/kanban/cards/reorder
   */
  postDashboardKanbanCardsReorder(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/dashboard/kanban/cards/reorder", {}, [], false, options)
  },

  /**
   * GET /api/dashboard/kanban/cards/{id}
   */
  getDashboardKanbanCardsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/dashboard/kanban/cards/{id}", input ?? {}, [], false, options)
  },

  /**
   * DELETE /api/dashboard/kanban/cards/{id}
   */
  deleteDashboardKanbanCardsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "DELETE", "/api/dashboard/kanban/cards/{id}", input ?? {}, [], false, options)
  },

  /**
   * PATCH /api/dashboard/kanban/cards/{id}
   */
  patchDashboardKanbanCardsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "PATCH", "/api/dashboard/kanban/cards/{id}", input ?? {}, [], false, options)
  },

  /**
   * POST /api/dashboard/kanban/cards/{id}/assignees
   */
  postDashboardKanbanCardsIdAssignees(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/dashboard/kanban/cards/{id}/assignees", input ?? {}, [], false, options)
  },

  /**
   * POST /api/dashboard/kanban/cards/{id}/comments
   */
  postDashboardKanbanCardsIdComments(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/dashboard/kanban/cards/{id}/comments", input ?? {}, [], false, options)
  },

  /**
   * POST /api/dashboard/kanban/cards/{id}/labels
   */
  postDashboardKanbanCardsIdLabels(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/dashboard/kanban/cards/{id}/labels", input ?? {}, [], false, options)
  },

  /**
   * POST /api/dashboard/kanban/columns
   */
  postDashboardKanbanColumns(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/dashboard/kanban/columns", {}, [], false, options)
  },

  /**
   * POST /api/dashboard/kanban/columns/reorder
   */
  postDashboardKanbanColumnsReorder(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/dashboard/kanban/columns/reorder", {}, [], false, options)
  },

  /**
   * DELETE /api/dashboard/kanban/columns/{id}
   */
  deleteDashboardKanbanColumnsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "DELETE", "/api/dashboard/kanban/columns/{id}", input ?? {}, [], false, options)
  },

  /**
   * PATCH /api/dashboard/kanban/columns/{id}
   */
  patchDashboardKanbanColumnsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "PATCH", "/api/dashboard/kanban/columns/{id}", input ?? {}, [], false, options)
  },

  /**
   * DELETE /api/dashboard/kanban/comments/{id}
   */
  deleteDashboardKanbanCommentsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "DELETE", "/api/dashboard/kanban/comments/{id}", input ?? {}, [], false, options)
  },

  /**
   * POST /api/dashboard/kanban/labels
   */
  postDashboardKanbanLabels(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/dashboard/kanban/labels", {}, [], false, options)
  },

  /**
   * DELETE /api/dashboard/kanban/labels/{id}
   */
  deleteDashboardKanbanLabelsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "DELETE", "/api/dashboard/kanban/labels/{id}", input ?? {}, [], false, options)
  },

  /**
   * PATCH /api/dashboard/kanban/labels/{id}
   */
  patchDashboardKanbanLabelsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "PATCH", "/api/dashboard/kanban/labels/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/dashboard/kanban/users
   */
  getDashboardKanbanUsers(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/dashboard/kanban/users", {}, [], false, options)
  },

  /**
   * GET /api/dashboard/library/components
   */
  getDashboardLibraryComponents(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/dashboard/library/components", {}, [], false, options)
  },

  /**
   * POST /api/dashboard/library/components
   */
  postDashboardLibraryComponents(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/dashboard/library/components", {}, [], false, options)
  },

  /**
   * GET /api/dashboard/library/dependencies
   */
  getDashboardLibraryDependencies(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/dashboard/library/dependencies", {}, [], false, options)
  },

  /**
   * GET /api/dashboard/library/functions
   */
  getDashboardLibraryFunctions(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/dashboard/library/functions", {}, [], false, options)
  },

  /**
   * POST /api/dashboard/library/functions
   */
  postDashboardLibraryFunctions(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/dashboard/library/functions", {}, [], false, options)
  },

  /**
   * GET /api/dashboard/library/packages
   */
  getDashboardLibraryPackages(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/dashboard/library/packages", {}, [], false, options)
  },

  /**
   * GET /api/dashboard/marketing/campaigns
   */
  getDashboardMarketingCampaigns(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/dashboard/marketing/campaigns", {}, [], false, options)
  },

  /**
   * POST /api/dashboard/marketing/campaigns
   */
  postDashboardMarketingCampaigns(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/dashboard/marketing/campaigns", {}, [], false, options)
  },

  /**
   * DELETE /api/dashboard/marketing/campaigns/{id}
   */
  deleteDashboardMarketingCampaignsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "DELETE", "/api/dashboard/marketing/campaigns/{id}", input ?? {}, [], false, options)
  },

  /**
   * PATCH /api/dashboard/marketing/campaigns/{id}
   */
  patchDashboardMarketingCampaignsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "PATCH", "/api/dashboard/marketing/campaigns/{id}", input ?? {}, [], false, options)
  },

  /**
   * POST /api/dashboard/marketing/campaigns/{id}/cancel
   */
  postDashboardMarketingCampaignsIdCancel(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/dashboard/marketing/campaigns/{id}/cancel", input ?? {}, [], false, options)
  },

  /**
   * POST /api/dashboard/marketing/campaigns/{id}/schedule
   */
  postDashboardMarketingCampaignsIdSchedule(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/dashboard/marketing/campaigns/{id}/schedule", input ?? {}, [], false, options)
  },

  /**
   * POST /api/dashboard/marketing/campaigns/{id}/send
   */
  postDashboardMarketingCampaignsIdSend(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/dashboard/marketing/campaigns/{id}/send", input ?? {}, [], false, options)
  },

  /**
   * GET /api/dashboard/marketing/lists
   */
  getDashboardMarketingLists(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/dashboard/marketing/lists", {}, [], false, options)
  },

  /**
   * POST /api/dashboard/marketing/lists
   */
  postDashboardMarketingLists(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/dashboard/marketing/lists", {}, [], false, options)
  },

  /**
   * DELETE /api/dashboard/marketing/lists/{id}
   */
  deleteDashboardMarketingListsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "DELETE", "/api/dashboard/marketing/lists/{id}", input ?? {}, [], false, options)
  },

  /**
   * PATCH /api/dashboard/marketing/lists/{id}
   */
  patchDashboardMarketingListsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "PATCH", "/api/dashboard/marketing/lists/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/dashboard/marketing/social-posts
   */
  getDashboardMarketingSocialPosts(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/dashboard/marketing/social-posts", {}, [], false, options)
  },

  /**
   * POST /api/dashboard/marketing/social-posts
   */
  postDashboardMarketingSocialPosts(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/dashboard/marketing/social-posts", {}, [], false, options)
  },

  /**
   * DELETE /api/dashboard/marketing/social-posts/{id}
   */
  deleteDashboardMarketingSocialPostsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "DELETE", "/api/dashboard/marketing/social-posts/{id}", input ?? {}, [], false, options)
  },

  /**
   * PATCH /api/dashboard/marketing/social-posts/{id}
   */
  patchDashboardMarketingSocialPostsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "PATCH", "/api/dashboard/marketing/social-posts/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/dashboard/models
   */
  getDashboardModels(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/dashboard/models", {}, [], false, options)
  },

  /**
   * GET /api/dashboard/models/{slug}
   */
  getDashboardModelsSlug(input: { "slug": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/dashboard/models/{slug}", input ?? {}, [], false, options)
  },

  /**
   * DELETE /api/dashboard/models/{slug}/{id}
   */
  deleteDashboardModelsSlugId(input: { "slug": string; "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "DELETE", "/api/dashboard/models/{slug}/{id}", input ?? {}, [], false, options)
  },

  /**
   * PATCH /api/dashboard/models/{slug}/{id}
   */
  patchDashboardModelsSlugId(input: { "slug": string; "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "PATCH", "/api/dashboard/models/{slug}/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/dashboard/monitoring/errors
   */
  getDashboardMonitoringErrors(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/dashboard/monitoring/errors", {}, [], false, options)
  },

  /**
   * DELETE /api/dashboard/monitoring/errors
   */
  deleteDashboardMonitoringErrors(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "DELETE", "/api/dashboard/monitoring/errors", {}, [], false, options)
  },

  /**
   * GET /api/dashboard/monitoring/errors/group
   */
  getDashboardMonitoringErrorsGroup(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/dashboard/monitoring/errors/group", {}, [], false, options)
  },

  /**
   * PATCH /api/dashboard/monitoring/errors/ignore
   */
  patchDashboardMonitoringErrorsIgnore(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "PATCH", "/api/dashboard/monitoring/errors/ignore", {}, [], false, options)
  },

  /**
   * PATCH /api/dashboard/monitoring/errors/resolve
   */
  patchDashboardMonitoringErrorsResolve(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "PATCH", "/api/dashboard/monitoring/errors/resolve", {}, [], false, options)
  },

  /**
   * GET /api/dashboard/monitoring/errors/stats
   */
  getDashboardMonitoringErrorsStats(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/dashboard/monitoring/errors/stats", {}, [], false, options)
  },

  /**
   * GET /api/dashboard/monitoring/errors/timeline
   */
  getDashboardMonitoringErrorsTimeline(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/dashboard/monitoring/errors/timeline", {}, [], false, options)
  },

  /**
   * PATCH /api/dashboard/monitoring/errors/unresolve
   */
  patchDashboardMonitoringErrorsUnresolve(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "PATCH", "/api/dashboard/monitoring/errors/unresolve", {}, [], false, options)
  },

  /**
   * GET /api/dashboard/monitoring/errors/{id}
   */
  getDashboardMonitoringErrorsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/dashboard/monitoring/errors/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/dashboard/notification-deliveries
   */
  getDashboardNotificationDeliveries(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/dashboard/notification-deliveries", {}, [], false, options)
  },

  /**
   * GET /api/dashboard/notification-deliveries/history
   */
  getDashboardNotificationDeliveriesHistory(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/dashboard/notification-deliveries/history", {}, [], false, options)
  },

  /**
   * GET /api/dashboard/notification-deliveries/overview
   */
  getDashboardNotificationDeliveriesOverview(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/dashboard/notification-deliveries/overview", {}, [], false, options)
  },

  /**
   * POST /api/dashboard/notification-deliveries/{id}/retry
   */
  postDashboardNotificationDeliveriesIdRetry(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/dashboard/notification-deliveries/{id}/retry", input ?? {}, [], false, options)
  },

  /**
   * GET /api/dashboard/pages
   */
  getDashboardPages(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/dashboard/pages", {}, [], false, options)
  },

  /**
   * POST /api/dashboard/pages
   */
  postDashboardPages(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/dashboard/pages", {}, [], false, options)
  },

  /**
   * DELETE /api/dashboard/pages/{id}
   */
  deleteDashboardPagesId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "DELETE", "/api/dashboard/pages/{id}", input ?? {}, [], false, options)
  },

  /**
   * PATCH /api/dashboard/pages/{id}
   */
  patchDashboardPagesId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "PATCH", "/api/dashboard/pages/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/dashboard/posts
   */
  getDashboardPosts(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/dashboard/posts", {}, [], false, options)
  },

  /**
   * POST /api/dashboard/posts
   */
  postDashboardPosts(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/dashboard/posts", {}, [], false, options)
  },

  /**
   * DELETE /api/dashboard/posts/{id}
   */
  deleteDashboardPostsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "DELETE", "/api/dashboard/posts/{id}", input ?? {}, [], false, options)
  },

  /**
   * PATCH /api/dashboard/posts/{id}
   */
  patchDashboardPostsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "PATCH", "/api/dashboard/posts/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/dashboard/queries
   */
  getDashboardQueries(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/dashboard/queries", {}, [], false, options)
  },

  /**
   * GET /api/dashboard/queries/{id}
   */
  getDashboardQueriesId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/dashboard/queries/{id}", input ?? {}, [], false, options)
  },

  /**
   * POST /api/dashboard/queue/retry-failed
   */
  postDashboardQueueRetryFailed(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/dashboard/queue/retry-failed", {}, [], false, options)
  },

  /**
   * GET /api/dashboard/queue/stats
   */
  getDashboardQueueStats(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/dashboard/queue/stats", {}, [], false, options)
  },

  /**
   * GET /api/dashboard/queue/workers
   */
  getDashboardQueueWorkers(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/dashboard/queue/workers", {}, [], false, options)
  },

  /**
   * GET /api/dashboard/rbac/permissions
   */
  getDashboardRbacPermissions(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/dashboard/rbac/permissions", {}, [], false, options)
  },

  /**
   * POST /api/dashboard/rbac/permissions
   */
  postDashboardRbacPermissions(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/dashboard/rbac/permissions", {}, [], false, options)
  },

  /**
   * DELETE /api/dashboard/rbac/permissions/{name}
   */
  deleteDashboardRbacPermissionsName(input: { "name": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "DELETE", "/api/dashboard/rbac/permissions/{name}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/dashboard/rbac/roles
   */
  getDashboardRbacRoles(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/dashboard/rbac/roles", {}, [], false, options)
  },

  /**
   * POST /api/dashboard/rbac/roles
   */
  postDashboardRbacRoles(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/dashboard/rbac/roles", {}, [], false, options)
  },

  /**
   * DELETE /api/dashboard/rbac/roles/{name}
   */
  deleteDashboardRbacRolesName(input: { "name": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "DELETE", "/api/dashboard/rbac/roles/{name}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/dashboard/rbac/roles/{name}/permissions
   */
  getDashboardRbacRolesNamePermissions(input: { "name": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/dashboard/rbac/roles/{name}/permissions", input ?? {}, [], false, options)
  },

  /**
   * POST /api/dashboard/rbac/roles/{name}/permissions
   */
  postDashboardRbacRolesNamePermissions(input: { "name": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/dashboard/rbac/roles/{name}/permissions", input ?? {}, [], false, options)
  },

  /**
   * GET /api/dashboard/rbac/users
   */
  getDashboardRbacUsers(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/dashboard/rbac/users", {}, [], false, options)
  },

  /**
   * GET /api/dashboard/rbac/users/{id}/roles
   */
  getDashboardRbacUsersIdRoles(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/dashboard/rbac/users/{id}/roles", input ?? {}, [], false, options)
  },

  /**
   * POST /api/dashboard/rbac/users/{id}/roles
   */
  postDashboardRbacUsersIdRoles(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/dashboard/rbac/users/{id}/roles", input ?? {}, [], false, options)
  },

  /**
   * GET /api/dashboard/realtime
   */
  getDashboardRealtime(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/dashboard/realtime", {}, [], false, options)
  },

  /**
   * GET /api/dashboard/releases
   */
  getDashboardReleases(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/dashboard/releases", {}, [], false, options)
  },

  /**
   * GET /api/dashboard/requests
   */
  getDashboardRequests(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/dashboard/requests", {}, [], false, options)
  },

  /**
   * GET /api/dashboard/source/actions
   */
  getDashboardSourceActions(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/dashboard/source/actions", {}, [], false, options)
  },

  /**
   * GET /api/dashboard/source/commands
   */
  getDashboardSourceCommands(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/dashboard/source/commands", {}, [], false, options)
  },

  /**
   * GET /api/dashboard/tags
   */
  getDashboardTags(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/dashboard/tags", {}, [], false, options)
  },

  /**
   * POST /api/dashboard/tags
   */
  postDashboardTags(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/dashboard/tags", {}, [], false, options)
  },

  /**
   * DELETE /api/dashboard/tags/{id}
   */
  deleteDashboardTagsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "DELETE", "/api/dashboard/tags/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/data/activity
   */
  getDataActivity(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/data/activity", {}, [], false, options)
  },

  /**
   * GET /api/data/subscribers
   */
  getDataSubscribers(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/data/subscribers", {}, [], false, options)
  },

  /**
   * GET /api/data/teams
   */
  getDataTeams(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/data/teams", {}, [], false, options)
  },

  /**
   * GET /api/data/users
   */
  getDataUsers(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/data/users", {}, [], false, options)
  },

  /**
   * GET /api/delivery-routes
   */
  getDeliveryRoutes(options?: RequestOptions): Promise<ApiResult<{ "data": Array<{ "id": number; "uuid": string; "driver"?: string; "vehicle"?: string; "stops"?: number; "delivery_time"?: number; "total_distance"?: number; "last_active"?: unknown; "driver_id"?: number; "created_at"?: string; "updated_at"?: string }> }>> {
    return request(config, "GET", "/api/delivery-routes", {}, [], false, options)
  },

  /**
   * POST /api/delivery-routes
   */
  postDeliveryRoutes(options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "driver"?: string; "vehicle"?: string; "stops"?: number; "delivery_time"?: number; "total_distance"?: number; "last_active"?: unknown; "driver_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "POST", "/api/delivery-routes", {}, [], false, options)
  },

  /**
   * POST /api/delivery-routes/bulk-delete
   */
  postDeliveryRoutesBulkDelete(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/delivery-routes/bulk-delete", {}, [], false, options)
  },

  /**
   * GET /api/delivery-routes/{id}
   */
  getDeliveryRoutesId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "driver"?: string; "vehicle"?: string; "stops"?: number; "delivery_time"?: number; "total_distance"?: number; "last_active"?: unknown; "driver_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "GET", "/api/delivery-routes/{id}", input ?? {}, [], false, options)
  },

  /**
   * PUT /api/delivery-routes/{id}
   */
  putDeliveryRoutesId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "driver"?: string; "vehicle"?: string; "stops"?: number; "delivery_time"?: number; "total_distance"?: number; "last_active"?: unknown; "driver_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PUT", "/api/delivery-routes/{id}", input ?? {}, [], false, options)
  },

  /**
   * DELETE /api/delivery-routes/{id}
   */
  deleteDeliveryRoutesId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "driver"?: string; "vehicle"?: string; "stops"?: number; "delivery_time"?: number; "total_distance"?: number; "last_active"?: unknown; "driver_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "DELETE", "/api/delivery-routes/{id}", input ?? {}, [], false, options)
  },

  /**
   * PATCH /api/delivery-routes/{id}
   */
  patchDeliveryRoutesId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "driver"?: string; "vehicle"?: string; "stops"?: number; "delivery_time"?: number; "total_distance"?: number; "last_active"?: unknown; "driver_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PATCH", "/api/delivery-routes/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/deployments
   */
  getDeployments(options?: RequestOptions): Promise<ApiResult<{ "data": Array<{ "id": number; "uuid": string; "commit_hash"?: string; "commit_message"?: string; "branch"?: string; "status"?: string; "environment"?: string; "duration"?: number; "author"?: string; "url"?: string; "error_log"?: string; "created_at"?: string; "updated_at"?: string }> }>> {
    return request(config, "GET", "/api/deployments", {}, [], false, options)
  },

  /**
   * GET /api/deployments/{id}
   */
  getDeploymentsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "commit_hash"?: string; "commit_message"?: string; "branch"?: string; "status"?: string; "environment"?: string; "duration"?: number; "author"?: string; "url"?: string; "error_log"?: string; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "GET", "/api/deployments/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/digital-deliveries
   */
  getDigitalDeliveries(options?: RequestOptions): Promise<ApiResult<{ "data": Array<{ "id": number; "uuid": string; "name"?: string; "description"?: string; "download_limit"?: number; "expiry_days"?: number; "requires_login"?: boolean; "automatic_delivery"?: boolean; "status"?: "active" | "inactive"; "created_at"?: string; "updated_at"?: string }> }>> {
    return request(config, "GET", "/api/digital-deliveries", {}, [], false, options)
  },

  /**
   * POST /api/digital-deliveries
   */
  postDigitalDeliveries(options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name"?: string; "description"?: string; "download_limit"?: number; "expiry_days"?: number; "requires_login"?: boolean; "automatic_delivery"?: boolean; "status"?: "active" | "inactive"; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "POST", "/api/digital-deliveries", {}, [], false, options)
  },

  /**
   * POST /api/digital-deliveries/bulk-delete
   */
  postDigitalDeliveriesBulkDelete(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/digital-deliveries/bulk-delete", {}, [], false, options)
  },

  /**
   * GET /api/digital-deliveries/{id}
   */
  getDigitalDeliveriesId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name"?: string; "description"?: string; "download_limit"?: number; "expiry_days"?: number; "requires_login"?: boolean; "automatic_delivery"?: boolean; "status"?: "active" | "inactive"; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "GET", "/api/digital-deliveries/{id}", input ?? {}, [], false, options)
  },

  /**
   * PUT /api/digital-deliveries/{id}
   */
  putDigitalDeliveriesId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name"?: string; "description"?: string; "download_limit"?: number; "expiry_days"?: number; "requires_login"?: boolean; "automatic_delivery"?: boolean; "status"?: "active" | "inactive"; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PUT", "/api/digital-deliveries/{id}", input ?? {}, [], false, options)
  },

  /**
   * DELETE /api/digital-deliveries/{id}
   */
  deleteDigitalDeliveriesId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name"?: string; "description"?: string; "download_limit"?: number; "expiry_days"?: number; "requires_login"?: boolean; "automatic_delivery"?: boolean; "status"?: "active" | "inactive"; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "DELETE", "/api/digital-deliveries/{id}", input ?? {}, [], false, options)
  },

  /**
   * PATCH /api/digital-deliveries/{id}
   */
  patchDigitalDeliveriesId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name"?: string; "description"?: string; "download_limit"?: number; "expiry_days"?: number; "requires_login"?: boolean; "automatic_delivery"?: boolean; "status"?: "active" | "inactive"; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PATCH", "/api/digital-deliveries/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/discover
   */
  getDiscover(input?: { "before"?: number }, options?: RequestOptions): Promise<ApiResult<{ "entries"?: Array<Record<string, unknown>>; "cursor"?: number }>> {
    return request(config, "GET", "/api/discover", input ?? {}, ["before"], false, options)
  },

  /**
   * GET /api/drivers
   */
  getDrivers(options?: RequestOptions): Promise<ApiResult<{ "data": Array<{ "id": number; "uuid": string; "name"?: string; "phone"?: string; "vehicle_number"?: string; "license"?: string; "status"?: "active" | "on_delivery" | "on_break"; "user_id"?: number; "created_at"?: string; "updated_at"?: string }> }>> {
    return request(config, "GET", "/api/drivers", {}, [], false, options)
  },

  /**
   * POST /api/drivers
   */
  postDrivers(options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name"?: string; "phone"?: string; "vehicle_number"?: string; "license"?: string; "status"?: "active" | "on_delivery" | "on_break"; "user_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "POST", "/api/drivers", {}, [], false, options)
  },

  /**
   * POST /api/drivers/bulk-delete
   */
  postDriversBulkDelete(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/drivers/bulk-delete", {}, [], false, options)
  },

  /**
   * GET /api/drivers/{id}
   */
  getDriversId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name"?: string; "phone"?: string; "vehicle_number"?: string; "license"?: string; "status"?: "active" | "on_delivery" | "on_break"; "user_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "GET", "/api/drivers/{id}", input ?? {}, [], false, options)
  },

  /**
   * PUT /api/drivers/{id}
   */
  putDriversId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name"?: string; "phone"?: string; "vehicle_number"?: string; "license"?: string; "status"?: "active" | "on_delivery" | "on_break"; "user_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PUT", "/api/drivers/{id}", input ?? {}, [], false, options)
  },

  /**
   * DELETE /api/drivers/{id}
   */
  deleteDriversId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name"?: string; "phone"?: string; "vehicle_number"?: string; "license"?: string; "status"?: "active" | "on_delivery" | "on_break"; "user_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "DELETE", "/api/drivers/{id}", input ?? {}, [], false, options)
  },

  /**
   * PATCH /api/drivers/{id}
   */
  patchDriversId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name"?: string; "phone"?: string; "vehicle_number"?: string; "license"?: string; "status"?: "active" | "on_delivery" | "on_break"; "user_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PATCH", "/api/drivers/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/email-list-subscribers
   */
  getEmailListSubscribers(options?: RequestOptions): Promise<ApiResult<{ "data": Array<{ "id": number; "uuid": string; "email_list_id": number; "subscriber_id": number; "status": "subscribed" | "unsubscribed" | "pending" | "bounced"; "source"?: string; "subscribed_at"?: unknown; "unsubscribed_at"?: unknown; "created_at"?: string; "updated_at"?: string }> }>> {
    return request(config, "GET", "/api/email-list-subscribers", {}, [], false, options)
  },

  /**
   * GET /api/email-list-subscribers/{id}
   */
  getEmailListSubscribersId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "email_list_id": number; "subscriber_id": number; "status": "subscribed" | "unsubscribed" | "pending" | "bounced"; "source"?: string; "subscribed_at"?: unknown; "unsubscribed_at"?: unknown; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "GET", "/api/email-list-subscribers/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/email-lists
   */
  getEmailLists(options?: RequestOptions): Promise<ApiResult<{ "data": Array<{ "id": number; "uuid": string; "name": string; "slug"?: string; "description"?: string; "subscriber_count"?: number; "active_count"?: number; "unsubscribed_count"?: number; "bounced_count"?: number; "status": "active" | "inactive" | "archived"; "is_public"?: number; "double_opt_in"?: number; "created_at"?: string; "updated_at"?: string }> }>> {
    return request(config, "GET", "/api/email-lists", {}, [], false, options)
  },

  /**
   * POST /api/email-lists
   */
  postEmailLists(options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name": string; "slug"?: string; "description"?: string; "subscriber_count"?: number; "active_count"?: number; "unsubscribed_count"?: number; "bounced_count"?: number; "status": "active" | "inactive" | "archived"; "is_public"?: number; "double_opt_in"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "POST", "/api/email-lists", {}, [], false, options)
  },

  /**
   * POST /api/email-lists/bulk-delete
   */
  postEmailListsBulkDelete(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/email-lists/bulk-delete", {}, [], false, options)
  },

  /**
   * GET /api/email-lists/{id}
   */
  getEmailListsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name": string; "slug"?: string; "description"?: string; "subscriber_count"?: number; "active_count"?: number; "unsubscribed_count"?: number; "bounced_count"?: number; "status": "active" | "inactive" | "archived"; "is_public"?: number; "double_opt_in"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "GET", "/api/email-lists/{id}", input ?? {}, [], false, options)
  },

  /**
   * PUT /api/email-lists/{id}
   */
  putEmailListsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name": string; "slug"?: string; "description"?: string; "subscriber_count"?: number; "active_count"?: number; "unsubscribed_count"?: number; "bounced_count"?: number; "status": "active" | "inactive" | "archived"; "is_public"?: number; "double_opt_in"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PUT", "/api/email-lists/{id}", input ?? {}, [], false, options)
  },

  /**
   * DELETE /api/email-lists/{id}
   */
  deleteEmailListsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name": string; "slug"?: string; "description"?: string; "subscriber_count"?: number; "active_count"?: number; "unsubscribed_count"?: number; "bounced_count"?: number; "status": "active" | "inactive" | "archived"; "is_public"?: number; "double_opt_in"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "DELETE", "/api/email-lists/{id}", input ?? {}, [], false, options)
  },

  /**
   * PATCH /api/email-lists/{id}
   */
  patchEmailListsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name": string; "slug"?: string; "description"?: string; "subscriber_count"?: number; "active_count"?: number; "unsubscribed_count"?: number; "bounced_count"?: number; "status": "active" | "inactive" | "archived"; "is_public"?: number; "double_opt_in"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PATCH", "/api/email-lists/{id}", input ?? {}, [], false, options)
  },

  /**
   * email.subscribe
   */
  emailSubscribe(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/email/subscribe", {}, [], false, options)
  },

  /**
   * email.unsubscribe
   */
  emailUnsubscribe(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/email/unsubscribe", {}, [], false, options)
  },

  /**
   * email.unsubscribe
   */
  emailUnsubscribePost(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/email/unsubscribe", {}, [], false, options)
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
  getFeed(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/feed", {}, [], false, options)
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
   * GET /api/gift-cards
   */
  getGiftCards(options?: RequestOptions): Promise<ApiResult<{ "data": Array<{ "id": number; "uuid": string; "code"?: string; "initial_balance"?: number; "current_balance"?: number; "currency"?: string; "status"?: string; "purchaser_id"?: string; "recipient_email"?: string; "recipient_name"?: string; "personal_message"?: string; "is_digital"?: boolean; "is_reloadable"?: boolean; "is_active"?: boolean; "expiry_date"?: unknown; "last_used_date"?: unknown; "template_id"?: string; "customer_id"?: number; "created_at"?: string; "updated_at"?: string }> }>> {
    return request(config, "GET", "/api/gift-cards", {}, [], false, options)
  },

  /**
   * POST /api/gift-cards
   */
  postGiftCards(options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "code"?: string; "initial_balance"?: number; "current_balance"?: number; "currency"?: string; "status"?: string; "purchaser_id"?: string; "recipient_email"?: string; "recipient_name"?: string; "personal_message"?: string; "is_digital"?: boolean; "is_reloadable"?: boolean; "is_active"?: boolean; "expiry_date"?: unknown; "last_used_date"?: unknown; "template_id"?: string; "customer_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "POST", "/api/gift-cards", {}, [], false, options)
  },

  /**
   * POST /api/gift-cards/bulk-delete
   */
  postGiftCardsBulkDelete(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/gift-cards/bulk-delete", {}, [], false, options)
  },

  /**
   * GET /api/gift-cards/{id}
   */
  getGiftCardsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "code"?: string; "initial_balance"?: number; "current_balance"?: number; "currency"?: string; "status"?: string; "purchaser_id"?: string; "recipient_email"?: string; "recipient_name"?: string; "personal_message"?: string; "is_digital"?: boolean; "is_reloadable"?: boolean; "is_active"?: boolean; "expiry_date"?: unknown; "last_used_date"?: unknown; "template_id"?: string; "customer_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "GET", "/api/gift-cards/{id}", input ?? {}, [], false, options)
  },

  /**
   * PUT /api/gift-cards/{id}
   */
  putGiftCardsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "code"?: string; "initial_balance"?: number; "current_balance"?: number; "currency"?: string; "status"?: string; "purchaser_id"?: string; "recipient_email"?: string; "recipient_name"?: string; "personal_message"?: string; "is_digital"?: boolean; "is_reloadable"?: boolean; "is_active"?: boolean; "expiry_date"?: unknown; "last_used_date"?: unknown; "template_id"?: string; "customer_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PUT", "/api/gift-cards/{id}", input ?? {}, [], false, options)
  },

  /**
   * DELETE /api/gift-cards/{id}
   */
  deleteGiftCardsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "code"?: string; "initial_balance"?: number; "current_balance"?: number; "currency"?: string; "status"?: string; "purchaser_id"?: string; "recipient_email"?: string; "recipient_name"?: string; "personal_message"?: string; "is_digital"?: boolean; "is_reloadable"?: boolean; "is_active"?: boolean; "expiry_date"?: unknown; "last_used_date"?: unknown; "template_id"?: string; "customer_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "DELETE", "/api/gift-cards/{id}", input ?? {}, [], false, options)
  },

  /**
   * PATCH /api/gift-cards/{id}
   */
  patchGiftCardsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "code"?: string; "initial_balance"?: number; "current_balance"?: number; "currency"?: string; "status"?: string; "purchaser_id"?: string; "recipient_email"?: string; "recipient_name"?: string; "personal_message"?: string; "is_digital"?: boolean; "is_reloadable"?: boolean; "is_active"?: boolean; "expiry_date"?: unknown; "last_used_date"?: unknown; "template_id"?: string; "customer_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PATCH", "/api/gift-cards/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/health
   */
  getHealth(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/health", {}, [], false, options)
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
   * GET /api/labels
   */
  getLabels(options?: RequestOptions): Promise<ApiResult<{ "data": Array<{ "id": number; "uuid": string; "board_id"?: number; "name"?: string; "color"?: string; "created_at"?: string; "updated_at"?: string }> }>> {
    return request(config, "GET", "/api/labels", {}, [], false, options)
  },

  /**
   * POST /api/labels
   */
  postLabels(options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "board_id"?: number; "name"?: string; "color"?: string; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "POST", "/api/labels", {}, [], false, options)
  },

  /**
   * POST /api/labels/bulk-delete
   */
  postLabelsBulkDelete(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/labels/bulk-delete", {}, [], false, options)
  },

  /**
   * GET /api/labels/{id}
   */
  getLabelsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "board_id"?: number; "name"?: string; "color"?: string; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "GET", "/api/labels/{id}", input ?? {}, [], false, options)
  },

  /**
   * PUT /api/labels/{id}
   */
  putLabelsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "board_id"?: number; "name"?: string; "color"?: string; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PUT", "/api/labels/{id}", input ?? {}, [], false, options)
  },

  /**
   * DELETE /api/labels/{id}
   */
  deleteLabelsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "board_id"?: number; "name"?: string; "color"?: string; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "DELETE", "/api/labels/{id}", input ?? {}, [], false, options)
  },

  /**
   * PATCH /api/labels/{id}
   */
  patchLabelsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "board_id"?: number; "name"?: string; "color"?: string; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PATCH", "/api/labels/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/license-keys
   */
  getLicenseKeys(options?: RequestOptions): Promise<ApiResult<{ "data": Array<{ "id": number; "uuid": string; "key"?: string; "template"?: "Standard License" | "Premium License" | "Enterprise License"; "expiry_date"?: unknown; "status"?: "active" | "inactive" | "unassigned"; "customer_id"?: number; "product_id"?: number; "order_id"?: number; "created_at"?: string; "updated_at"?: string }> }>> {
    return request(config, "GET", "/api/license-keys", {}, [], false, options)
  },

  /**
   * POST /api/license-keys
   */
  postLicenseKeys(options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "key"?: string; "template"?: "Standard License" | "Premium License" | "Enterprise License"; "expiry_date"?: unknown; "status"?: "active" | "inactive" | "unassigned"; "customer_id"?: number; "product_id"?: number; "order_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "POST", "/api/license-keys", {}, [], false, options)
  },

  /**
   * POST /api/license-keys/bulk-delete
   */
  postLicenseKeysBulkDelete(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/license-keys/bulk-delete", {}, [], false, options)
  },

  /**
   * GET /api/license-keys/{id}
   */
  getLicenseKeysId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "key"?: string; "template"?: "Standard License" | "Premium License" | "Enterprise License"; "expiry_date"?: unknown; "status"?: "active" | "inactive" | "unassigned"; "customer_id"?: number; "product_id"?: number; "order_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "GET", "/api/license-keys/{id}", input ?? {}, [], false, options)
  },

  /**
   * PUT /api/license-keys/{id}
   */
  putLicenseKeysId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "key"?: string; "template"?: "Standard License" | "Premium License" | "Enterprise License"; "expiry_date"?: unknown; "status"?: "active" | "inactive" | "unassigned"; "customer_id"?: number; "product_id"?: number; "order_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PUT", "/api/license-keys/{id}", input ?? {}, [], false, options)
  },

  /**
   * DELETE /api/license-keys/{id}
   */
  deleteLicenseKeysId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "key"?: string; "template"?: "Standard License" | "Premium License" | "Enterprise License"; "expiry_date"?: unknown; "status"?: "active" | "inactive" | "unassigned"; "customer_id"?: number; "product_id"?: number; "order_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "DELETE", "/api/license-keys/{id}", input ?? {}, [], false, options)
  },

  /**
   * PATCH /api/license-keys/{id}
   */
  patchLicenseKeysId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "key"?: string; "template"?: "Standard License" | "Premium License" | "Enterprise License"; "expiry_date"?: unknown; "status"?: "active" | "inactive" | "unassigned"; "customer_id"?: number; "product_id"?: number; "order_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PATCH", "/api/license-keys/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/loyalty-points
   */
  getLoyaltyPoints(options?: RequestOptions): Promise<ApiResult<{ "data": Array<{ "id": number; "uuid": string; "wallet_id"?: string; "points"?: number; "source"?: string; "source_reference_id"?: string; "description"?: string; "expiry_date"?: unknown; "is_used"?: boolean; "created_at"?: string; "updated_at"?: string }> }>> {
    return request(config, "GET", "/api/loyalty-points", {}, [], false, options)
  },

  /**
   * POST /api/loyalty-points
   */
  postLoyaltyPoints(options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "wallet_id"?: string; "points"?: number; "source"?: string; "source_reference_id"?: string; "description"?: string; "expiry_date"?: unknown; "is_used"?: boolean; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "POST", "/api/loyalty-points", {}, [], false, options)
  },

  /**
   * POST /api/loyalty-points/bulk-delete
   */
  postLoyaltyPointsBulkDelete(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/loyalty-points/bulk-delete", {}, [], false, options)
  },

  /**
   * GET /api/loyalty-points/{id}
   */
  getLoyaltyPointsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "wallet_id"?: string; "points"?: number; "source"?: string; "source_reference_id"?: string; "description"?: string; "expiry_date"?: unknown; "is_used"?: boolean; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "GET", "/api/loyalty-points/{id}", input ?? {}, [], false, options)
  },

  /**
   * PUT /api/loyalty-points/{id}
   */
  putLoyaltyPointsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "wallet_id"?: string; "points"?: number; "source"?: string; "source_reference_id"?: string; "description"?: string; "expiry_date"?: unknown; "is_used"?: boolean; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PUT", "/api/loyalty-points/{id}", input ?? {}, [], false, options)
  },

  /**
   * DELETE /api/loyalty-points/{id}
   */
  deleteLoyaltyPointsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "wallet_id"?: string; "points"?: number; "source"?: string; "source_reference_id"?: string; "description"?: string; "expiry_date"?: unknown; "is_used"?: boolean; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "DELETE", "/api/loyalty-points/{id}", input ?? {}, [], false, options)
  },

  /**
   * PATCH /api/loyalty-points/{id}
   */
  patchLoyaltyPointsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "wallet_id"?: string; "points"?: number; "source"?: string; "source_reference_id"?: string; "description"?: string; "expiry_date"?: unknown; "is_used"?: boolean; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PATCH", "/api/loyalty-points/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/loyalty-rewards
   */
  getLoyaltyRewards(options?: RequestOptions): Promise<ApiResult<{ "data": Array<{ "id": number; "uuid": string; "name"?: string; "description"?: string; "points_required"?: number; "reward_type"?: string; "discount_percentage"?: number; "free_product_id"?: string; "is_active"?: boolean; "expiry_days"?: number; "image_url"?: string; "product_id"?: number; "created_at"?: string; "updated_at"?: string }> }>> {
    return request(config, "GET", "/api/loyalty-rewards", {}, [], false, options)
  },

  /**
   * POST /api/loyalty-rewards
   */
  postLoyaltyRewards(options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name"?: string; "description"?: string; "points_required"?: number; "reward_type"?: string; "discount_percentage"?: number; "free_product_id"?: string; "is_active"?: boolean; "expiry_days"?: number; "image_url"?: string; "product_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "POST", "/api/loyalty-rewards", {}, [], false, options)
  },

  /**
   * POST /api/loyalty-rewards/bulk-delete
   */
  postLoyaltyRewardsBulkDelete(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/loyalty-rewards/bulk-delete", {}, [], false, options)
  },

  /**
   * GET /api/loyalty-rewards/{id}
   */
  getLoyaltyRewardsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name"?: string; "description"?: string; "points_required"?: number; "reward_type"?: string; "discount_percentage"?: number; "free_product_id"?: string; "is_active"?: boolean; "expiry_days"?: number; "image_url"?: string; "product_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "GET", "/api/loyalty-rewards/{id}", input ?? {}, [], false, options)
  },

  /**
   * PUT /api/loyalty-rewards/{id}
   */
  putLoyaltyRewardsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name"?: string; "description"?: string; "points_required"?: number; "reward_type"?: string; "discount_percentage"?: number; "free_product_id"?: string; "is_active"?: boolean; "expiry_days"?: number; "image_url"?: string; "product_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PUT", "/api/loyalty-rewards/{id}", input ?? {}, [], false, options)
  },

  /**
   * DELETE /api/loyalty-rewards/{id}
   */
  deleteLoyaltyRewardsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name"?: string; "description"?: string; "points_required"?: number; "reward_type"?: string; "discount_percentage"?: number; "free_product_id"?: string; "is_active"?: boolean; "expiry_days"?: number; "image_url"?: string; "product_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "DELETE", "/api/loyalty-rewards/{id}", input ?? {}, [], false, options)
  },

  /**
   * PATCH /api/loyalty-rewards/{id}
   */
  patchLoyaltyRewardsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name"?: string; "description"?: string; "points_required"?: number; "reward_type"?: string; "discount_percentage"?: number; "free_product_id"?: string; "is_active"?: boolean; "expiry_days"?: number; "image_url"?: string; "product_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PATCH", "/api/loyalty-rewards/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/mail-preferences
   */
  getMailPreferences(options?: RequestOptions): Promise<ApiResult<{ "data": Array<{ "id": number; "mailbox": string; "account_name": string; "signature"?: string; "display_density": "comfortable" | "default" | "compact"; "theme": "light" | "dark" | "system"; "language": "en" | "fr" | "de" | "es" | "ja"; "default_reply_behavior": "reply" | "replyAll"; "send_and_archive": boolean; "auto_advance": "newer" | "older" | "back"; "desktop_notifications": boolean; "notification_sound": "default" | "subtle" | "none"; "notification_preview": boolean; "filters": string; "blocked_senders": string; "labels": string; "load_remote_images": boolean; "show_external_content": boolean; "vacation_enabled": boolean; "vacation_start_date"?: string; "vacation_end_date"?: string; "vacation_subject"?: string; "vacation_message"?: string; "created_at"?: string; "updated_at"?: string }> }>> {
    return request(config, "GET", "/api/mail-preferences", {}, [], false, options)
  },

  /**
   * POST /api/mail-preferences
   */
  postMailPreferences(options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "mailbox": string; "account_name": string; "signature"?: string; "display_density": "comfortable" | "default" | "compact"; "theme": "light" | "dark" | "system"; "language": "en" | "fr" | "de" | "es" | "ja"; "default_reply_behavior": "reply" | "replyAll"; "send_and_archive": boolean; "auto_advance": "newer" | "older" | "back"; "desktop_notifications": boolean; "notification_sound": "default" | "subtle" | "none"; "notification_preview": boolean; "filters": string; "blocked_senders": string; "labels": string; "load_remote_images": boolean; "show_external_content": boolean; "vacation_enabled": boolean; "vacation_start_date"?: string; "vacation_end_date"?: string; "vacation_subject"?: string; "vacation_message"?: string; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "POST", "/api/mail-preferences", {}, [], false, options)
  },

  /**
   * POST /api/mail-preferences/bulk-delete
   */
  postMailPreferencesBulkDelete(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/mail-preferences/bulk-delete", {}, [], false, options)
  },

  /**
   * GET /api/mail-preferences/{id}
   */
  getMailPreferencesId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "mailbox": string; "account_name": string; "signature"?: string; "display_density": "comfortable" | "default" | "compact"; "theme": "light" | "dark" | "system"; "language": "en" | "fr" | "de" | "es" | "ja"; "default_reply_behavior": "reply" | "replyAll"; "send_and_archive": boolean; "auto_advance": "newer" | "older" | "back"; "desktop_notifications": boolean; "notification_sound": "default" | "subtle" | "none"; "notification_preview": boolean; "filters": string; "blocked_senders": string; "labels": string; "load_remote_images": boolean; "show_external_content": boolean; "vacation_enabled": boolean; "vacation_start_date"?: string; "vacation_end_date"?: string; "vacation_subject"?: string; "vacation_message"?: string; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "GET", "/api/mail-preferences/{id}", input ?? {}, [], false, options)
  },

  /**
   * PUT /api/mail-preferences/{id}
   */
  putMailPreferencesId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "mailbox": string; "account_name": string; "signature"?: string; "display_density": "comfortable" | "default" | "compact"; "theme": "light" | "dark" | "system"; "language": "en" | "fr" | "de" | "es" | "ja"; "default_reply_behavior": "reply" | "replyAll"; "send_and_archive": boolean; "auto_advance": "newer" | "older" | "back"; "desktop_notifications": boolean; "notification_sound": "default" | "subtle" | "none"; "notification_preview": boolean; "filters": string; "blocked_senders": string; "labels": string; "load_remote_images": boolean; "show_external_content": boolean; "vacation_enabled": boolean; "vacation_start_date"?: string; "vacation_end_date"?: string; "vacation_subject"?: string; "vacation_message"?: string; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PUT", "/api/mail-preferences/{id}", input ?? {}, [], false, options)
  },

  /**
   * DELETE /api/mail-preferences/{id}
   */
  deleteMailPreferencesId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "mailbox": string; "account_name": string; "signature"?: string; "display_density": "comfortable" | "default" | "compact"; "theme": "light" | "dark" | "system"; "language": "en" | "fr" | "de" | "es" | "ja"; "default_reply_behavior": "reply" | "replyAll"; "send_and_archive": boolean; "auto_advance": "newer" | "older" | "back"; "desktop_notifications": boolean; "notification_sound": "default" | "subtle" | "none"; "notification_preview": boolean; "filters": string; "blocked_senders": string; "labels": string; "load_remote_images": boolean; "show_external_content": boolean; "vacation_enabled": boolean; "vacation_start_date"?: string; "vacation_end_date"?: string; "vacation_subject"?: string; "vacation_message"?: string; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "DELETE", "/api/mail-preferences/{id}", input ?? {}, [], false, options)
  },

  /**
   * PATCH /api/mail-preferences/{id}
   */
  patchMailPreferencesId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "mailbox": string; "account_name": string; "signature"?: string; "display_density": "comfortable" | "default" | "compact"; "theme": "light" | "dark" | "system"; "language": "en" | "fr" | "de" | "es" | "ja"; "default_reply_behavior": "reply" | "replyAll"; "send_and_archive": boolean; "auto_advance": "newer" | "older" | "back"; "desktop_notifications": boolean; "notification_sound": "default" | "subtle" | "none"; "notification_preview": boolean; "filters": string; "blocked_senders": string; "labels": string; "load_remote_images": boolean; "show_external_content": boolean; "vacation_enabled": boolean; "vacation_start_date"?: string; "vacation_end_date"?: string; "vacation_subject"?: string; "vacation_message"?: string; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PATCH", "/api/mail-preferences/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/marketing/campaigns
   */
  getMarketingCampaigns(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/marketing/campaigns", {}, [], false, options)
  },

  /**
   * GET /api/marketing/lists
   */
  getMarketingLists(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/marketing/lists", {}, [], false, options)
  },

  /**
   * GET /api/marketing/social-posts
   */
  getMarketingSocialPosts(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/marketing/social-posts", {}, [], false, options)
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
  postMirrorsSync(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/mirrors/sync", {}, [], false, options)
  },

  /**
   * POST /api/mirrors/webhook
   */
  postMirrorsWebhook(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/mirrors/webhook", {}, [], false, options)
  },

  /**
   * GET /api/monitoring/errors
   */
  getMonitoringErrors(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/monitoring/errors", {}, [], false, options)
  },

  /**
   * DELETE /api/monitoring/errors
   */
  deleteMonitoringErrors(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "DELETE", "/api/monitoring/errors", {}, [], false, options)
  },

  /**
   * GET /api/monitoring/errors/group
   */
  getMonitoringErrorsGroup(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/monitoring/errors/group", {}, [], false, options)
  },

  /**
   * PATCH /api/monitoring/errors/ignore
   */
  patchMonitoringErrorsIgnore(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "PATCH", "/api/monitoring/errors/ignore", {}, [], false, options)
  },

  /**
   * PATCH /api/monitoring/errors/resolve
   */
  patchMonitoringErrorsResolve(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "PATCH", "/api/monitoring/errors/resolve", {}, [], false, options)
  },

  /**
   * GET /api/monitoring/errors/stats
   */
  getMonitoringErrorsStats(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/monitoring/errors/stats", {}, [], false, options)
  },

  /**
   * GET /api/monitoring/errors/timeline
   */
  getMonitoringErrorsTimeline(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/monitoring/errors/timeline", {}, [], false, options)
  },

  /**
   * PATCH /api/monitoring/errors/unresolve
   */
  patchMonitoringErrorsUnresolve(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "PATCH", "/api/monitoring/errors/unresolve", {}, [], false, options)
  },

  /**
   * GET /api/monitoring/errors/{id}
   */
  getMonitoringErrorsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/monitoring/errors/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/notification-deliveries
   */
  getNotificationDeliveries(options?: RequestOptions): Promise<ApiResult<{ "data": Array<{ "id": number; "channel": "email" | "sms" | "chat" | "database" | "push" | "broadcast"; "recipient": string; "subject"?: string; "body": string; "status": "pending" | "sent" | "delivered" | "failed" | "skipped"; "error"?: string; "metadata"?: string; "sent_at"?: unknown; "created_at"?: string; "updated_at"?: string }> }>> {
    return request(config, "GET", "/api/notification-deliveries", {}, [], false, options)
  },

  /**
   * POST /api/notification-deliveries/bulk-delete
   */
  postNotificationDeliveriesBulkDelete(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/notification-deliveries/bulk-delete", {}, [], false, options)
  },

  /**
   * GET /api/notification-deliveries/{id}
   */
  getNotificationDeliveriesId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "channel": "email" | "sms" | "chat" | "database" | "push" | "broadcast"; "recipient": string; "subject"?: string; "body": string; "status": "pending" | "sent" | "delivered" | "failed" | "skipped"; "error"?: string; "metadata"?: string; "sent_at"?: unknown; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "GET", "/api/notification-deliveries/{id}", input ?? {}, [], false, options)
  },

  /**
   * DELETE /api/notification-deliveries/{id}
   */
  deleteNotificationDeliveriesId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "channel": "email" | "sms" | "chat" | "database" | "push" | "broadcast"; "recipient": string; "subject"?: string; "body": string; "status": "pending" | "sent" | "delivered" | "failed" | "skipped"; "error"?: string; "metadata"?: string; "sent_at"?: unknown; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "DELETE", "/api/notification-deliveries/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/notifications
   */
  getNotifications(options?: RequestOptions): Promise<ApiResult<{ "data": Array<{ "id": number; "uuid": string; "type": string; "data": string; "read_at"?: unknown; "created_at"?: string; "updated_at"?: string }> }>> {
    return request(config, "GET", "/api/notifications", {}, [], false, options)
  },

  /**
   * POST /api/notifications
   */
  postNotifications(options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "type": string; "data": string; "read_at"?: unknown; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "POST", "/api/notifications", {}, [], false, options)
  },

  /**
   * POST /api/notifications/bulk-delete
   */
  postNotificationsBulkDelete(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/notifications/bulk-delete", {}, [], false, options)
  },

  /**
   * GET /api/notifications/dashboard
   */
  getNotificationsDashboard(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/notifications/dashboard", {}, [], false, options)
  },

  /**
   * GET /api/notifications/email
   */
  getNotificationsEmail(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/notifications/email", {}, [], false, options)
  },

  /**
   * GET /api/notifications/history
   */
  getNotificationsHistory(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/notifications/history", {}, [], false, options)
  },

  /**
   * GET /api/notifications/sms
   */
  getNotificationsSms(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/notifications/sms", {}, [], false, options)
  },

  /**
   * GET /api/notifications/{id}
   */
  getNotificationsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "type": string; "data": string; "read_at"?: unknown; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "GET", "/api/notifications/{id}", input ?? {}, [], false, options)
  },

  /**
   * PUT /api/notifications/{id}
   */
  putNotificationsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "type": string; "data": string; "read_at"?: unknown; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PUT", "/api/notifications/{id}", input ?? {}, [], false, options)
  },

  /**
   * DELETE /api/notifications/{id}
   */
  deleteNotificationsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "type": string; "data": string; "read_at"?: unknown; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "DELETE", "/api/notifications/{id}", input ?? {}, [], false, options)
  },

  /**
   * PATCH /api/notifications/{id}
   */
  patchNotificationsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "type": string; "data": string; "read_at"?: unknown; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PATCH", "/api/notifications/{id}", input ?? {}, [], false, options)
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
  postOperationsIdCancel(input: { "id": string; body?: { "id"?: string } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/operations/{id}/cancel", input ?? {}, [], true, options)
  },

  /**
   * GET /api/orders
   */
  getOrders(options?: RequestOptions): Promise<ApiResult<{ "data": Array<{ "id": number; "uuid": string; "status"?: string; "total_amount"?: number; "currency"?: string; "tax_amount"?: number; "discount_amount"?: number; "delivery_fee"?: number; "tip_amount"?: number; "order_type"?: string; "delivery_address"?: string; "special_instructions"?: string; "estimated_delivery_time"?: string; "applied_coupon_id"?: string; "customer_id"?: number; "coupon_id"?: number; "created_at"?: string; "updated_at"?: string }> }>> {
    return request(config, "GET", "/api/orders", {}, [], false, options)
  },

  /**
   * POST /api/orders
   */
  postOrders(options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "status"?: string; "total_amount"?: number; "currency"?: string; "tax_amount"?: number; "discount_amount"?: number; "delivery_fee"?: number; "tip_amount"?: number; "order_type"?: string; "delivery_address"?: string; "special_instructions"?: string; "estimated_delivery_time"?: string; "applied_coupon_id"?: string; "customer_id"?: number; "coupon_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "POST", "/api/orders", {}, [], false, options)
  },

  /**
   * POST /api/orders/bulk-delete
   */
  postOrdersBulkDelete(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/orders/bulk-delete", {}, [], false, options)
  },

  /**
   * GET /api/orders/{id}
   */
  getOrdersId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "status"?: string; "total_amount"?: number; "currency"?: string; "tax_amount"?: number; "discount_amount"?: number; "delivery_fee"?: number; "tip_amount"?: number; "order_type"?: string; "delivery_address"?: string; "special_instructions"?: string; "estimated_delivery_time"?: string; "applied_coupon_id"?: string; "customer_id"?: number; "coupon_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "GET", "/api/orders/{id}", input ?? {}, [], false, options)
  },

  /**
   * PUT /api/orders/{id}
   */
  putOrdersId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "status"?: string; "total_amount"?: number; "currency"?: string; "tax_amount"?: number; "discount_amount"?: number; "delivery_fee"?: number; "tip_amount"?: number; "order_type"?: string; "delivery_address"?: string; "special_instructions"?: string; "estimated_delivery_time"?: string; "applied_coupon_id"?: string; "customer_id"?: number; "coupon_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PUT", "/api/orders/{id}", input ?? {}, [], false, options)
  },

  /**
   * DELETE /api/orders/{id}
   */
  deleteOrdersId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "status"?: string; "total_amount"?: number; "currency"?: string; "tax_amount"?: number; "discount_amount"?: number; "delivery_fee"?: number; "tip_amount"?: number; "order_type"?: string; "delivery_address"?: string; "special_instructions"?: string; "estimated_delivery_time"?: string; "applied_coupon_id"?: string; "customer_id"?: number; "coupon_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "DELETE", "/api/orders/{id}", input ?? {}, [], false, options)
  },

  /**
   * PATCH /api/orders/{id}
   */
  patchOrdersId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "status"?: string; "total_amount"?: number; "currency"?: string; "tax_amount"?: number; "discount_amount"?: number; "delivery_fee"?: number; "tip_amount"?: number; "order_type"?: string; "delivery_address"?: string; "special_instructions"?: string; "estimated_delivery_time"?: string; "applied_coupon_id"?: string; "customer_id"?: number; "coupon_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PATCH", "/api/orders/{id}", input ?? {}, [], false, options)
  },

  /**
   * PUT /api/orgs
   */
  putOrgs(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "PUT", "/api/orgs", {}, [], false, options)
  },

  /**
   * POST /api/orgs
   */
  postOrgs(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/orgs", {}, [], false, options)
  },

  /**
   * DELETE /api/orgs
   */
  deleteOrgs(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "DELETE", "/api/orgs", {}, [], false, options)
  },

  /**
   * POST /api/orgs/delete
   */
  postOrgsDelete(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/orgs/delete", {}, [], false, options)
  },

  /**
   * POST /api/orgs/machine-accounts
   */
  postOrgsMachineAccounts(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/orgs/machine-accounts", {}, [], false, options)
  },

  /**
   * POST /api/orgs/members
   */
  postOrgsMembers(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/orgs/members", {}, [], false, options)
  },

  /**
   * DELETE /api/orgs/members
   */
  deleteOrgsMembers(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "DELETE", "/api/orgs/members", {}, [], false, options)
  },

  /**
   * POST /api/orgs/members/accept
   */
  postOrgsMembersAccept(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/orgs/members/accept", {}, [], false, options)
  },

  /**
   * POST /api/orgs/members/remove
   */
  postOrgsMembersRemove(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/orgs/members/remove", {}, [], false, options)
  },

  /**
   * PUT /api/orgs/members/role
   */
  putOrgsMembersRole(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "PUT", "/api/orgs/members/role", {}, [], false, options)
  },

  /**
   * POST /api/orgs/members/role
   */
  postOrgsMembersRole(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/orgs/members/role", {}, [], false, options)
  },

  /**
   * POST /api/orgs/teams
   */
  postOrgsTeams(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/orgs/teams", {}, [], false, options)
  },

  /**
   * POST /api/orgs/teams/members
   */
  postOrgsTeamsMembers(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/orgs/teams/members", {}, [], false, options)
  },

  /**
   * GET /api/orgs/tokens
   */
  getOrgsTokens(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/orgs/tokens", {}, [], false, options)
  },

  /**
   * POST /api/orgs/update
   */
  postOrgsUpdate(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/orgs/update", {}, [], false, options)
  },

  /**
   * GET /api/owners
   */
  getOwners(input: { "owner": string; "q"?: string; "page"?: number; "per_page"?: number }, options?: RequestOptions): Promise<ApiResult<unknown>> {
    return request(config, "GET", "/api/owners", input ?? {}, ["owner", "q", "page", "per_page"], false, options)
  },

  /**
   * GET /api/pages
   */
  getPages(options?: RequestOptions): Promise<ApiResult<{ "data": Array<{ "id": number; "uuid": string; "title": string; "template": string; "views"?: number; "published_at"?: unknown; "conversions"?: number; "author_id"?: number; "created_at"?: string; "updated_at"?: string }> }>> {
    return request(config, "GET", "/api/pages", {}, [], false, options)
  },

  /**
   * POST /api/pages
   */
  postPages(options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "title": string; "template": string; "views"?: number; "published_at"?: unknown; "conversions"?: number; "author_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "POST", "/api/pages", {}, [], false, options)
  },

  /**
   * POST /api/pages/bulk-delete
   */
  postPagesBulkDelete(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/pages/bulk-delete", {}, [], false, options)
  },

  /**
   * GET /api/pages/{id}
   */
  getPagesId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "title": string; "template": string; "views"?: number; "published_at"?: unknown; "conversions"?: number; "author_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "GET", "/api/pages/{id}", input ?? {}, [], false, options)
  },

  /**
   * PUT /api/pages/{id}
   */
  putPagesId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "title": string; "template": string; "views"?: number; "published_at"?: unknown; "conversions"?: number; "author_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PUT", "/api/pages/{id}", input ?? {}, [], false, options)
  },

  /**
   * DELETE /api/pages/{id}
   */
  deletePagesId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "title": string; "template": string; "views"?: number; "published_at"?: unknown; "conversions"?: number; "author_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "DELETE", "/api/pages/{id}", input ?? {}, [], false, options)
  },

  /**
   * PATCH /api/pages/{id}
   */
  patchPagesId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "title": string; "template": string; "views"?: number; "published_at"?: unknown; "conversions"?: number; "author_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PATCH", "/api/pages/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/payments
   */
  getPayments(options?: RequestOptions): Promise<ApiResult<{ "data": Array<{ "id": number; "uuid": string; "amount"?: number; "method"?: "cash" | "creditCard" | "debitCard" | "paypal" | "applePay" | "googlePay" | "bankTransfer" | "giftCard"; "status"?: "pending" | "processing" | "completed" | "failed" | "refunded" | "partiallyRefunded" | "succeeded"; "currency"?: string; "reference_number"?: string; "card_last_four"?: string; "card_brand"?: string; "billing_email"?: string; "transaction_id"?: string; "payment_provider"?: string; "refund_amount"?: number; "notes"?: string; "order_id"?: number; "customer_id"?: number; "created_at"?: string; "updated_at"?: string }> }>> {
    return request(config, "GET", "/api/payments", {}, [], false, options)
  },

  /**
   * POST /api/payments
   */
  postPayments(options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "amount"?: number; "method"?: "cash" | "creditCard" | "debitCard" | "paypal" | "applePay" | "googlePay" | "bankTransfer" | "giftCard"; "status"?: "pending" | "processing" | "completed" | "failed" | "refunded" | "partiallyRefunded" | "succeeded"; "currency"?: string; "reference_number"?: string; "card_last_four"?: string; "card_brand"?: string; "billing_email"?: string; "transaction_id"?: string; "payment_provider"?: string; "refund_amount"?: number; "notes"?: string; "order_id"?: number; "customer_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "POST", "/api/payments", {}, [], false, options)
  },

  /**
   * POST /api/payments/bulk-delete
   */
  postPaymentsBulkDelete(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/payments/bulk-delete", {}, [], false, options)
  },

  /**
   * GET /api/payments/{id}
   */
  getPaymentsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "amount"?: number; "method"?: "cash" | "creditCard" | "debitCard" | "paypal" | "applePay" | "googlePay" | "bankTransfer" | "giftCard"; "status"?: "pending" | "processing" | "completed" | "failed" | "refunded" | "partiallyRefunded" | "succeeded"; "currency"?: string; "reference_number"?: string; "card_last_four"?: string; "card_brand"?: string; "billing_email"?: string; "transaction_id"?: string; "payment_provider"?: string; "refund_amount"?: number; "notes"?: string; "order_id"?: number; "customer_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "GET", "/api/payments/{id}", input ?? {}, [], false, options)
  },

  /**
   * PUT /api/payments/{id}
   */
  putPaymentsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "amount"?: number; "method"?: "cash" | "creditCard" | "debitCard" | "paypal" | "applePay" | "googlePay" | "bankTransfer" | "giftCard"; "status"?: "pending" | "processing" | "completed" | "failed" | "refunded" | "partiallyRefunded" | "succeeded"; "currency"?: string; "reference_number"?: string; "card_last_four"?: string; "card_brand"?: string; "billing_email"?: string; "transaction_id"?: string; "payment_provider"?: string; "refund_amount"?: number; "notes"?: string; "order_id"?: number; "customer_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PUT", "/api/payments/{id}", input ?? {}, [], false, options)
  },

  /**
   * DELETE /api/payments/{id}
   */
  deletePaymentsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "amount"?: number; "method"?: "cash" | "creditCard" | "debitCard" | "paypal" | "applePay" | "googlePay" | "bankTransfer" | "giftCard"; "status"?: "pending" | "processing" | "completed" | "failed" | "refunded" | "partiallyRefunded" | "succeeded"; "currency"?: string; "reference_number"?: string; "card_last_four"?: string; "card_brand"?: string; "billing_email"?: string; "transaction_id"?: string; "payment_provider"?: string; "refund_amount"?: number; "notes"?: string; "order_id"?: number; "customer_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "DELETE", "/api/payments/{id}", input ?? {}, [], false, options)
  },

  /**
   * PATCH /api/payments/{id}
   */
  patchPaymentsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "amount"?: number; "method"?: "cash" | "creditCard" | "debitCard" | "paypal" | "applePay" | "googlePay" | "bankTransfer" | "giftCard"; "status"?: "pending" | "processing" | "completed" | "failed" | "refunded" | "partiallyRefunded" | "succeeded"; "currency"?: string; "reference_number"?: string; "card_last_four"?: string; "card_brand"?: string; "billing_email"?: string; "transaction_id"?: string; "payment_provider"?: string; "refund_amount"?: number; "notes"?: string; "order_id"?: number; "customer_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PATCH", "/api/payments/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/posts
   */
  getPosts(options?: RequestOptions): Promise<ApiResult<{ "data": Array<{ "id": number; "uuid": string; "title": string; "poster"?: string; "content": string; "excerpt"?: string; "views"?: number; "published_at"?: unknown; "status": "published" | "draft" | "archived"; "is_featured"?: number; "author_id"?: number; "created_at"?: string; "updated_at"?: string }> }>> {
    return request(config, "GET", "/api/posts", {}, [], false, options)
  },

  /**
   * POST /api/posts
   */
  postPosts(options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "title": string; "poster"?: string; "content": string; "excerpt"?: string; "views"?: number; "published_at"?: unknown; "status": "published" | "draft" | "archived"; "is_featured"?: number; "author_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "POST", "/api/posts", {}, [], false, options)
  },

  /**
   * POST /api/posts/bulk-delete
   */
  postPostsBulkDelete(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/posts/bulk-delete", {}, [], false, options)
  },

  /**
   * GET /api/posts/{id}
   */
  getPostsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "title": string; "poster"?: string; "content": string; "excerpt"?: string; "views"?: number; "published_at"?: unknown; "status": "published" | "draft" | "archived"; "is_featured"?: number; "author_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "GET", "/api/posts/{id}", input ?? {}, [], false, options)
  },

  /**
   * PUT /api/posts/{id}
   */
  putPostsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "title": string; "poster"?: string; "content": string; "excerpt"?: string; "views"?: number; "published_at"?: unknown; "status": "published" | "draft" | "archived"; "is_featured"?: number; "author_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PUT", "/api/posts/{id}", input ?? {}, [], false, options)
  },

  /**
   * DELETE /api/posts/{id}
   */
  deletePostsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "title": string; "poster"?: string; "content": string; "excerpt"?: string; "views"?: number; "published_at"?: unknown; "status": "published" | "draft" | "archived"; "is_featured"?: number; "author_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "DELETE", "/api/posts/{id}", input ?? {}, [], false, options)
  },

  /**
   * PATCH /api/posts/{id}
   */
  patchPostsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "title": string; "poster"?: string; "content": string; "excerpt"?: string; "views"?: number; "published_at"?: unknown; "status": "published" | "draft" | "archived"; "is_featured"?: number; "author_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PATCH", "/api/posts/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/print-devices
   */
  getPrintDevices(options?: RequestOptions): Promise<ApiResult<{ "data": Array<{ "id": number; "uuid": string; "name"?: string; "mac_address"?: string; "location"?: string; "terminal"?: string; "status"?: "online" | "offline" | "warning"; "last_ping"?: unknown; "print_count"?: number; "created_at"?: string; "updated_at"?: string }> }>> {
    return request(config, "GET", "/api/print-devices", {}, [], false, options)
  },

  /**
   * POST /api/print-devices
   */
  postPrintDevices(options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name"?: string; "mac_address"?: string; "location"?: string; "terminal"?: string; "status"?: "online" | "offline" | "warning"; "last_ping"?: unknown; "print_count"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "POST", "/api/print-devices", {}, [], false, options)
  },

  /**
   * POST /api/print-devices/bulk-delete
   */
  postPrintDevicesBulkDelete(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/print-devices/bulk-delete", {}, [], false, options)
  },

  /**
   * GET /api/print-devices/{id}
   */
  getPrintDevicesId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name"?: string; "mac_address"?: string; "location"?: string; "terminal"?: string; "status"?: "online" | "offline" | "warning"; "last_ping"?: unknown; "print_count"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "GET", "/api/print-devices/{id}", input ?? {}, [], false, options)
  },

  /**
   * PUT /api/print-devices/{id}
   */
  putPrintDevicesId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name"?: string; "mac_address"?: string; "location"?: string; "terminal"?: string; "status"?: "online" | "offline" | "warning"; "last_ping"?: unknown; "print_count"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PUT", "/api/print-devices/{id}", input ?? {}, [], false, options)
  },

  /**
   * DELETE /api/print-devices/{id}
   */
  deletePrintDevicesId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name"?: string; "mac_address"?: string; "location"?: string; "terminal"?: string; "status"?: "online" | "offline" | "warning"; "last_ping"?: unknown; "print_count"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "DELETE", "/api/print-devices/{id}", input ?? {}, [], false, options)
  },

  /**
   * PATCH /api/print-devices/{id}
   */
  patchPrintDevicesId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name"?: string; "mac_address"?: string; "location"?: string; "terminal"?: string; "status"?: "online" | "offline" | "warning"; "last_ping"?: unknown; "print_count"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PATCH", "/api/print-devices/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/print-logs
   */
  getPrintLogs(options?: RequestOptions): Promise<ApiResult<{ "data": Array<{ "id": number; "uuid": string; "printer"?: string; "document"?: string; "timestamp"?: unknown; "status"?: "success" | "failed" | "warning"; "size"?: number; "pages"?: number; "duration"?: number; "metadata"?: string; "print_device_id"?: number; "created_at"?: string; "updated_at"?: string }> }>> {
    return request(config, "GET", "/api/print-logs", {}, [], false, options)
  },

  /**
   * POST /api/print-logs
   */
  postPrintLogs(options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "printer"?: string; "document"?: string; "timestamp"?: unknown; "status"?: "success" | "failed" | "warning"; "size"?: number; "pages"?: number; "duration"?: number; "metadata"?: string; "print_device_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "POST", "/api/print-logs", {}, [], false, options)
  },

  /**
   * POST /api/print-logs/bulk-delete
   */
  postPrintLogsBulkDelete(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/print-logs/bulk-delete", {}, [], false, options)
  },

  /**
   * GET /api/print-logs/{id}
   */
  getPrintLogsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "printer"?: string; "document"?: string; "timestamp"?: unknown; "status"?: "success" | "failed" | "warning"; "size"?: number; "pages"?: number; "duration"?: number; "metadata"?: string; "print_device_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "GET", "/api/print-logs/{id}", input ?? {}, [], false, options)
  },

  /**
   * PUT /api/print-logs/{id}
   */
  putPrintLogsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "printer"?: string; "document"?: string; "timestamp"?: unknown; "status"?: "success" | "failed" | "warning"; "size"?: number; "pages"?: number; "duration"?: number; "metadata"?: string; "print_device_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PUT", "/api/print-logs/{id}", input ?? {}, [], false, options)
  },

  /**
   * DELETE /api/print-logs/{id}
   */
  deletePrintLogsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "printer"?: string; "document"?: string; "timestamp"?: unknown; "status"?: "success" | "failed" | "warning"; "size"?: number; "pages"?: number; "duration"?: number; "metadata"?: string; "print_device_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "DELETE", "/api/print-logs/{id}", input ?? {}, [], false, options)
  },

  /**
   * PATCH /api/print-logs/{id}
   */
  patchPrintLogsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "printer"?: string; "document"?: string; "timestamp"?: unknown; "status"?: "success" | "failed" | "warning"; "size"?: number; "pages"?: number; "duration"?: number; "metadata"?: string; "print_device_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PATCH", "/api/print-logs/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/product-categories
   */
  getProductCategories(options?: RequestOptions): Promise<ApiResult<{ "data": Array<{ "id": number; "uuid": string; "name"?: string; "description"?: string; "slug"?: string; "image_url"?: string; "is_active"?: boolean; "parent_category_id"?: string; "display_order"?: number; "created_at"?: string; "updated_at"?: string }> }>> {
    return request(config, "GET", "/api/product-categories", {}, [], false, options)
  },

  /**
   * POST /api/product-categories
   */
  postProductCategories(options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name"?: string; "description"?: string; "slug"?: string; "image_url"?: string; "is_active"?: boolean; "parent_category_id"?: string; "display_order"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "POST", "/api/product-categories", {}, [], false, options)
  },

  /**
   * POST /api/product-categories/bulk-delete
   */
  postProductCategoriesBulkDelete(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/product-categories/bulk-delete", {}, [], false, options)
  },

  /**
   * GET /api/product-categories/{id}
   */
  getProductCategoriesId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name"?: string; "description"?: string; "slug"?: string; "image_url"?: string; "is_active"?: boolean; "parent_category_id"?: string; "display_order"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "GET", "/api/product-categories/{id}", input ?? {}, [], false, options)
  },

  /**
   * PUT /api/product-categories/{id}
   */
  putProductCategoriesId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name"?: string; "description"?: string; "slug"?: string; "image_url"?: string; "is_active"?: boolean; "parent_category_id"?: string; "display_order"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PUT", "/api/product-categories/{id}", input ?? {}, [], false, options)
  },

  /**
   * DELETE /api/product-categories/{id}
   */
  deleteProductCategoriesId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name"?: string; "description"?: string; "slug"?: string; "image_url"?: string; "is_active"?: boolean; "parent_category_id"?: string; "display_order"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "DELETE", "/api/product-categories/{id}", input ?? {}, [], false, options)
  },

  /**
   * PATCH /api/product-categories/{id}
   */
  patchProductCategoriesId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name"?: string; "description"?: string; "slug"?: string; "image_url"?: string; "is_active"?: boolean; "parent_category_id"?: string; "display_order"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PATCH", "/api/product-categories/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/product-manufacturers
   */
  getProductManufacturers(options?: RequestOptions): Promise<ApiResult<{ "data": Array<{ "id": number; "uuid": string; "manufacturer"?: string; "description"?: string; "country"?: string; "featured"?: boolean; "created_at"?: string; "updated_at"?: string }> }>> {
    return request(config, "GET", "/api/product-manufacturers", {}, [], false, options)
  },

  /**
   * POST /api/product-manufacturers
   */
  postProductManufacturers(options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "manufacturer"?: string; "description"?: string; "country"?: string; "featured"?: boolean; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "POST", "/api/product-manufacturers", {}, [], false, options)
  },

  /**
   * POST /api/product-manufacturers/bulk-delete
   */
  postProductManufacturersBulkDelete(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/product-manufacturers/bulk-delete", {}, [], false, options)
  },

  /**
   * GET /api/product-manufacturers/{id}
   */
  getProductManufacturersId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "manufacturer"?: string; "description"?: string; "country"?: string; "featured"?: boolean; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "GET", "/api/product-manufacturers/{id}", input ?? {}, [], false, options)
  },

  /**
   * PUT /api/product-manufacturers/{id}
   */
  putProductManufacturersId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "manufacturer"?: string; "description"?: string; "country"?: string; "featured"?: boolean; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PUT", "/api/product-manufacturers/{id}", input ?? {}, [], false, options)
  },

  /**
   * DELETE /api/product-manufacturers/{id}
   */
  deleteProductManufacturersId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "manufacturer"?: string; "description"?: string; "country"?: string; "featured"?: boolean; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "DELETE", "/api/product-manufacturers/{id}", input ?? {}, [], false, options)
  },

  /**
   * PATCH /api/product-manufacturers/{id}
   */
  patchProductManufacturersId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "manufacturer"?: string; "description"?: string; "country"?: string; "featured"?: boolean; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PATCH", "/api/product-manufacturers/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/product-reviews
   */
  getProductReviews(options?: RequestOptions): Promise<ApiResult<{ "data": Array<{ "id": number; "uuid": string; "rating"?: number; "title"?: string; "content"?: string; "is_verified_purchase"?: boolean; "is_approved"?: boolean; "is_featured"?: boolean; "helpful_votes"?: number; "unhelpful_votes"?: number; "purchase_date"?: string; "images"?: string; "product_id"?: number; "customer_id"?: number; "created_at"?: string; "updated_at"?: string }> }>> {
    return request(config, "GET", "/api/product-reviews", {}, [], false, options)
  },

  /**
   * POST /api/product-reviews
   */
  postProductReviews(options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "rating"?: number; "title"?: string; "content"?: string; "is_verified_purchase"?: boolean; "is_approved"?: boolean; "is_featured"?: boolean; "helpful_votes"?: number; "unhelpful_votes"?: number; "purchase_date"?: string; "images"?: string; "product_id"?: number; "customer_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "POST", "/api/product-reviews", {}, [], false, options)
  },

  /**
   * POST /api/product-reviews/bulk-delete
   */
  postProductReviewsBulkDelete(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/product-reviews/bulk-delete", {}, [], false, options)
  },

  /**
   * GET /api/product-reviews/{id}
   */
  getProductReviewsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "rating"?: number; "title"?: string; "content"?: string; "is_verified_purchase"?: boolean; "is_approved"?: boolean; "is_featured"?: boolean; "helpful_votes"?: number; "unhelpful_votes"?: number; "purchase_date"?: string; "images"?: string; "product_id"?: number; "customer_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "GET", "/api/product-reviews/{id}", input ?? {}, [], false, options)
  },

  /**
   * PUT /api/product-reviews/{id}
   */
  putProductReviewsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "rating"?: number; "title"?: string; "content"?: string; "is_verified_purchase"?: boolean; "is_approved"?: boolean; "is_featured"?: boolean; "helpful_votes"?: number; "unhelpful_votes"?: number; "purchase_date"?: string; "images"?: string; "product_id"?: number; "customer_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PUT", "/api/product-reviews/{id}", input ?? {}, [], false, options)
  },

  /**
   * DELETE /api/product-reviews/{id}
   */
  deleteProductReviewsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "rating"?: number; "title"?: string; "content"?: string; "is_verified_purchase"?: boolean; "is_approved"?: boolean; "is_featured"?: boolean; "helpful_votes"?: number; "unhelpful_votes"?: number; "purchase_date"?: string; "images"?: string; "product_id"?: number; "customer_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "DELETE", "/api/product-reviews/{id}", input ?? {}, [], false, options)
  },

  /**
   * PATCH /api/product-reviews/{id}
   */
  patchProductReviewsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "rating"?: number; "title"?: string; "content"?: string; "is_verified_purchase"?: boolean; "is_approved"?: boolean; "is_featured"?: boolean; "helpful_votes"?: number; "unhelpful_votes"?: number; "purchase_date"?: string; "images"?: string; "product_id"?: number; "customer_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PATCH", "/api/product-reviews/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/product-units
   */
  getProductUnits(options?: RequestOptions): Promise<ApiResult<{ "data": Array<{ "id": number; "uuid": string; "name"?: string; "abbreviation"?: string; "type"?: string; "description"?: string; "is_default"?: boolean; "product_id"?: number; "created_at"?: string; "updated_at"?: string }> }>> {
    return request(config, "GET", "/api/product-units", {}, [], false, options)
  },

  /**
   * POST /api/product-units
   */
  postProductUnits(options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name"?: string; "abbreviation"?: string; "type"?: string; "description"?: string; "is_default"?: boolean; "product_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "POST", "/api/product-units", {}, [], false, options)
  },

  /**
   * POST /api/product-units/bulk-delete
   */
  postProductUnitsBulkDelete(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/product-units/bulk-delete", {}, [], false, options)
  },

  /**
   * GET /api/product-units/{id}
   */
  getProductUnitsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name"?: string; "abbreviation"?: string; "type"?: string; "description"?: string; "is_default"?: boolean; "product_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "GET", "/api/product-units/{id}", input ?? {}, [], false, options)
  },

  /**
   * PUT /api/product-units/{id}
   */
  putProductUnitsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name"?: string; "abbreviation"?: string; "type"?: string; "description"?: string; "is_default"?: boolean; "product_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PUT", "/api/product-units/{id}", input ?? {}, [], false, options)
  },

  /**
   * DELETE /api/product-units/{id}
   */
  deleteProductUnitsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name"?: string; "abbreviation"?: string; "type"?: string; "description"?: string; "is_default"?: boolean; "product_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "DELETE", "/api/product-units/{id}", input ?? {}, [], false, options)
  },

  /**
   * PATCH /api/product-units/{id}
   */
  patchProductUnitsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name"?: string; "abbreviation"?: string; "type"?: string; "description"?: string; "is_default"?: boolean; "product_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PATCH", "/api/product-units/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/product-variants
   */
  getProductVariants(options?: RequestOptions): Promise<ApiResult<{ "data": Array<{ "id": number; "uuid": string; "variant"?: string; "type"?: string; "description"?: string; "options"?: string; "status"?: "active" | "inactive" | "draft"; "product_id"?: number; "created_at"?: string; "updated_at"?: string }> }>> {
    return request(config, "GET", "/api/product-variants", {}, [], false, options)
  },

  /**
   * POST /api/product-variants
   */
  postProductVariants(options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "variant"?: string; "type"?: string; "description"?: string; "options"?: string; "status"?: "active" | "inactive" | "draft"; "product_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "POST", "/api/product-variants", {}, [], false, options)
  },

  /**
   * POST /api/product-variants/bulk-delete
   */
  postProductVariantsBulkDelete(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/product-variants/bulk-delete", {}, [], false, options)
  },

  /**
   * GET /api/product-variants/{id}
   */
  getProductVariantsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "variant"?: string; "type"?: string; "description"?: string; "options"?: string; "status"?: "active" | "inactive" | "draft"; "product_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "GET", "/api/product-variants/{id}", input ?? {}, [], false, options)
  },

  /**
   * PUT /api/product-variants/{id}
   */
  putProductVariantsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "variant"?: string; "type"?: string; "description"?: string; "options"?: string; "status"?: "active" | "inactive" | "draft"; "product_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PUT", "/api/product-variants/{id}", input ?? {}, [], false, options)
  },

  /**
   * DELETE /api/product-variants/{id}
   */
  deleteProductVariantsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "variant"?: string; "type"?: string; "description"?: string; "options"?: string; "status"?: "active" | "inactive" | "draft"; "product_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "DELETE", "/api/product-variants/{id}", input ?? {}, [], false, options)
  },

  /**
   * PATCH /api/product-variants/{id}
   */
  patchProductVariantsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "variant"?: string; "type"?: string; "description"?: string; "options"?: string; "status"?: "active" | "inactive" | "draft"; "product_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PATCH", "/api/product-variants/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/products
   */
  getProducts(options?: RequestOptions): Promise<ApiResult<{ "data": Array<{ "id": number; "uuid": string; "name"?: string; "description"?: string; "price"?: number; "image_url"?: string; "is_available"?: boolean; "inventory_count"?: number; "preparation_time"?: number; "allergens"?: string; "nutritional_info"?: string; "category_id"?: number; "manufacturer_id"?: number; "created_at"?: string; "updated_at"?: string }> }>> {
    return request(config, "GET", "/api/products", {}, [], false, options)
  },

  /**
   * POST /api/products
   */
  postProducts(options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name"?: string; "description"?: string; "price"?: number; "image_url"?: string; "is_available"?: boolean; "inventory_count"?: number; "preparation_time"?: number; "allergens"?: string; "nutritional_info"?: string; "category_id"?: number; "manufacturer_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "POST", "/api/products", {}, [], false, options)
  },

  /**
   * POST /api/products/bulk-delete
   */
  postProductsBulkDelete(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/products/bulk-delete", {}, [], false, options)
  },

  /**
   * GET /api/products/{id}
   */
  getProductsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name"?: string; "description"?: string; "price"?: number; "image_url"?: string; "is_available"?: boolean; "inventory_count"?: number; "preparation_time"?: number; "allergens"?: string; "nutritional_info"?: string; "category_id"?: number; "manufacturer_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "GET", "/api/products/{id}", input ?? {}, [], false, options)
  },

  /**
   * PUT /api/products/{id}
   */
  putProductsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name"?: string; "description"?: string; "price"?: number; "image_url"?: string; "is_available"?: boolean; "inventory_count"?: number; "preparation_time"?: number; "allergens"?: string; "nutritional_info"?: string; "category_id"?: number; "manufacturer_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PUT", "/api/products/{id}", input ?? {}, [], false, options)
  },

  /**
   * DELETE /api/products/{id}
   */
  deleteProductsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name"?: string; "description"?: string; "price"?: number; "image_url"?: string; "is_available"?: boolean; "inventory_count"?: number; "preparation_time"?: number; "allergens"?: string; "nutritional_info"?: string; "category_id"?: number; "manufacturer_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "DELETE", "/api/products/{id}", input ?? {}, [], false, options)
  },

  /**
   * PATCH /api/products/{id}
   */
  patchProductsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name"?: string; "description"?: string; "price"?: number; "image_url"?: string; "is_available"?: boolean; "inventory_count"?: number; "preparation_time"?: number; "allergens"?: string; "nutritional_info"?: string; "category_id"?: number; "manufacturer_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PATCH", "/api/products/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/queries/dashboard
   */
  getQueriesDashboard(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/queries/dashboard", {}, [], false, options)
  },

  /**
   * GET /api/queries/frequent
   */
  getQueriesFrequent(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/queries/frequent", {}, [], false, options)
  },

  /**
   * POST /api/queries/prune
   */
  postQueriesPrune(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/queries/prune", {}, [], false, options)
  },

  /**
   * GET /api/queries/recent
   */
  getQueriesRecent(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/queries/recent", {}, [], false, options)
  },

  /**
   * GET /api/queries/slow
   */
  getQueriesSlow(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/queries/slow", {}, [], false, options)
  },

  /**
   * GET /api/queries/stats
   */
  getQueriesStats(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/queries/stats", {}, [], false, options)
  },

  /**
   * GET /api/queries/timeline
   */
  getQueriesTimeline(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/queries/timeline", {}, [], false, options)
  },

  /**
   * /api/queries/:id
   */
  getQueriesId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/queries/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/query-logs
   */
  getQueryLogs(options?: RequestOptions): Promise<ApiResult<{ "data": Array<{ "id": number; "query": string; "normalized_query"?: string; "duration"?: number; "connection"?: string; "status"?: "completed" | "failed" | "slow"; "error"?: string; "executed_at": string; "model"?: string; "method"?: string; "line"?: number; "memory_usage"?: number; "rows_affected"?: number; "transaction_id"?: string; "tags"?: string; "affected_tables"?: string; "indexes_used"?: string; "missing_indexes"?: string; "explain_plan"?: string; "optimization_suggestions"?: string; "created_at"?: string; "updated_at"?: string }> }>> {
    return request(config, "GET", "/api/query-logs", {}, [], false, options)
  },

  /**
   * GET /api/query-logs/{id}
   */
  getQueryLogsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "query": string; "normalized_query"?: string; "duration"?: number; "connection"?: string; "status"?: "completed" | "failed" | "slow"; "error"?: string; "executed_at": string; "model"?: string; "method"?: string; "line"?: number; "memory_usage"?: number; "rows_affected"?: number; "transaction_id"?: string; "tags"?: string; "affected_tables"?: string; "indexes_used"?: string; "missing_indexes"?: string; "explain_plan"?: string; "optimization_suggestions"?: string; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "GET", "/api/query-logs/{id}", input ?? {}, [], false, options)
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
  putRepos(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "PUT", "/api/repos", {}, [], false, options)
  },

  /**
   * POST /api/repos
   */
  postRepos(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/repos", {}, [], false, options)
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
  getReposArchive(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/repos/archive", {}, [], false, options)
  },

  /**
   * POST /api/repos/attachments
   */
  postReposAttachments(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/repos/attachments", {}, [], false, options)
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
  getReposBlame(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/repos/blame", {}, [], false, options)
  },

  /**
   * GET /api/repos/blob
   */
  getReposBlob(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/repos/blob", {}, [], false, options)
  },

  /**
   * GET /api/repos/blob/rows
   */
  getReposBlobRows(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/repos/blob/rows", {}, [], false, options)
  },

  /**
   * GET /api/repos/branches
   */
  getReposBranches(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/repos/branches", {}, [], false, options)
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
  postReposCollaborators(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/repos/collaborators", {}, [], false, options)
  },

  /**
   * GET /api/repos/commit
   */
  getReposCommit(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/repos/commit", {}, [], false, options)
  },

  /**
   * GET /api/repos/commits
   */
  getReposCommits(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/repos/commits", {}, [], false, options)
  },

  /**
   * GET /api/repos/compare
   */
  getReposCompare(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/repos/compare", {}, [], false, options)
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
  postReposDeployKeys(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/repos/deploy-keys", {}, [], false, options)
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
  postReposEnvironments(input?: { body?: { "owner"?: string; "repo"?: string; "operation"?: "list" | "create" | "update" | "delete" | "add-reviewer" | "remove-reviewer"; "name"?: string; "wait_minutes"?: number; "branches"?: string; "description"?: string; "reviewer"?: string } }, options?: RequestOptions): Promise<ApiResult<unknown>> {
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
  putReposIssues(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "PUT", "/api/repos/issues", {}, [], false, options)
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
  postReposIssuesBulk(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/repos/issues/bulk", {}, [], false, options)
  },

  /**
   * PUT /api/repos/issues/comments
   */
  putReposIssuesComments(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "PUT", "/api/repos/issues/comments", {}, [], false, options)
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
  deleteReposIssuesComments(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "DELETE", "/api/repos/issues/comments", {}, [], false, options)
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
  putReposIssuesMilestone(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "PUT", "/api/repos/issues/milestone", {}, [], false, options)
  },

  /**
   * POST /api/repos/issues/reactions
   */
  postReposIssuesReactions(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/repos/issues/reactions", {}, [], false, options)
  },

  /**
   * PUT /api/repos/issues/state
   */
  putReposIssuesState(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "PUT", "/api/repos/issues/state", {}, [], false, options)
  },

  /**
   * PUT /api/repos/issues/tasks
   */
  putReposIssuesTasks(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "PUT", "/api/repos/issues/tasks", {}, [], false, options)
  },

  /**
   * POST /api/repos/labels
   */
  postReposLabels(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/repos/labels", {}, [], false, options)
  },

  /**
   * POST /api/repos/milestones
   */
  postReposMilestones(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/repos/milestones", {}, [], false, options)
  },

  /**
   * POST /api/repos/protected-branches
   */
  postReposProtectedBranches(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/repos/protected-branches", {}, [], false, options)
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
  putReposPulls(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "PUT", "/api/repos/pulls", {}, [], false, options)
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
  postReposPullsAutoMerge(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/repos/pulls/auto-merge", {}, [], false, options)
  },

  /**
   * POST /api/repos/pulls/auto-merge/disarm
   */
  postReposPullsAutoMergeDisarm(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/repos/pulls/auto-merge/disarm", {}, [], false, options)
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
  getReposPullsDiffBlame(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/repos/pulls/diff/blame", {}, [], false, options)
  },

  /**
   * GET /api/repos/pulls/diff/conflicts
   */
  getReposPullsDiffConflicts(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/repos/pulls/diff/conflicts", {}, [], false, options)
  },

  /**
   * GET /api/repos/pulls/diff/context
   */
  getReposPullsDiffContext(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/repos/pulls/diff/context", {}, [], false, options)
  },

  /**
   * GET /api/repos/pulls/diff/interdiff
   */
  getReposPullsDiffInterdiff(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/repos/pulls/diff/interdiff", {}, [], false, options)
  },

  /**
   * GET /api/repos/pulls/diff/manifest
   */
  getReposPullsDiffManifest(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/repos/pulls/diff/manifest", {}, [], false, options)
  },

  /**
   * GET /api/repos/pulls/diff/rows
   */
  getReposPullsDiffRows(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/repos/pulls/diff/rows", {}, [], false, options)
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
  postReposPullsLastLook(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/repos/pulls/last-look", {}, [], false, options)
  },

  /**
   * POST /api/repos/pulls/live
   */
  postReposPullsLive(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/repos/pulls/live", {}, [], false, options)
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
  postReposPullsMergeStack(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/repos/pulls/merge-stack", {}, [], false, options)
  },

  /**
   * POST /api/repos/pulls/mergeability
   */
  postReposPullsMergeability(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/repos/pulls/mergeability", {}, [], false, options)
  },

  /**
   * POST /api/repos/pulls/restore-branch
   */
  postReposPullsRestoreBranch(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/repos/pulls/restore-branch", {}, [], false, options)
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
  getReposPullsReviewState(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/repos/pulls/review-state", {}, [], false, options)
  },

  /**
   * PUT /api/repos/pulls/review-state/draft
   */
  putReposPullsReviewStateDraft(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "PUT", "/api/repos/pulls/review-state/draft", {}, [], false, options)
  },

  /**
   * GET /api/repos/pulls/review-state/since
   */
  getReposPullsReviewStateSince(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/repos/pulls/review-state/since", {}, [], false, options)
  },

  /**
   * GET /api/repos/pulls/review-state/stale
   */
  getReposPullsReviewStateStale(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/repos/pulls/review-state/stale", {}, [], false, options)
  },

  /**
   * PUT /api/repos/pulls/review-state/viewed
   */
  putReposPullsReviewStateViewed(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "PUT", "/api/repos/pulls/review-state/viewed", {}, [], false, options)
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
  putReposPullsReviewsDismiss(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "PUT", "/api/repos/pulls/reviews/dismiss", {}, [], false, options)
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
  putReposPullsState(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "PUT", "/api/repos/pulls/state", {}, [], false, options)
  },

  /**
   * GET /api/repos/pulls/suggested-reviewers
   */
  getReposPullsSuggestedReviewers(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/repos/pulls/suggested-reviewers", {}, [], false, options)
  },

  /**
   * PUT /api/repos/pulls/threads
   */
  putReposPullsThreads(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "PUT", "/api/repos/pulls/threads", {}, [], false, options)
  },

  /**
   * GET /api/repos/raw
   */
  getReposRaw(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/repos/raw", {}, [], false, options)
  },

  /**
   * GET /api/repos/releases
   */
  getReposReleases(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/repos/releases", {}, [], false, options)
  },

  /**
   * POST /api/repos/releases
   */
  postReposReleases(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/repos/releases", {}, [], false, options)
  },

  /**
   * GET /api/repos/releases/assets
   */
  getReposReleasesAssets(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/repos/releases/assets", {}, [], false, options)
  },

  /**
   * POST /api/repos/releases/assets
   */
  postReposReleasesAssets(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/repos/releases/assets", {}, [], false, options)
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
  postReposSettings(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/repos/settings", {}, [], false, options)
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
  getReposTags(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/repos/tags", {}, [], false, options)
  },

  /**
   * POST /api/repos/teams
   */
  postReposTeams(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/repos/teams", {}, [], false, options)
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
  putReposTopics(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "PUT", "/api/repos/topics", {}, [], false, options)
  },

  /**
   * POST /api/repos/topics
   */
  postReposTopics(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/repos/topics", {}, [], false, options)
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
  getReposTree(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/repos/tree", {}, [], false, options)
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
  putReposWatches(input: { body: { "owner": string; "repo"?: string; "repository"?: string; "subscription"?: "all" | "participating" | "ignore" } }, options?: RequestOptions): Promise<ApiResult<unknown>> {
    return request(config, "PUT", "/api/repos/watches", input ?? {}, [], true, options)
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
  postReposWebhooksRedeliver(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/repos/webhooks/redeliver", {}, [], false, options)
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
  postReposWorkflowRunsApprove(input?: { body?: { "owner"?: string; "repo"?: string; "number"?: number; "job"?: string } }, options?: RequestOptions): Promise<ApiResult<{ "job"?: { "job_id"?: string; "state"?: string }; "run"?: { "number"?: number; "state"?: string }; "outputs"?: Record<string, unknown> }>> {
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
   * GET /api/repos/workflow-runs/log
   */
  getReposWorkflowRunsLog(input: { "owner"?: string; "repo"?: string; "job": number; "after"?: number }, options?: RequestOptions): Promise<ApiResult<{ "chunks"?: Array<Record<string, unknown>>; "cursor"?: number; "state"?: string }>> {
    return request(config, "GET", "/api/repos/workflow-runs/log", input ?? {}, ["owner", "repo", "job", "after"], false, options)
  },

  /**
   * GET /api/repos/workflow-runs/log-image
   */
  getReposWorkflowRunsLogImage(input?: { "owner"?: string; "repo"?: string; "number"?: number; "artifact"?: string }, options?: RequestOptions): Promise<ApiResult<unknown>> {
    return request(config, "GET", "/api/repos/workflow-runs/log-image", input ?? {}, ["owner", "repo", "number", "artifact"], false, options)
  },

  /**
   * POST /api/repos/workflow-runs/rerun
   */
  postReposWorkflowRunsRerun(input?: { body?: { "owner"?: string; "repo"?: string; "number"?: number; "scope"?: string; "job"?: string } }, options?: RequestOptions): Promise<ApiResult<{ "workflow_run"?: { "number"?: number; "state"?: string; "attempt"?: number }; "jobs"?: number }>> {
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
   * POST /api/repos/workflows/dispatch
   */
  postReposWorkflowsDispatch(input?: { body?: { "owner"?: string; "repo"?: string; "workflow"?: string; "ref"?: string } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/repos/workflows/dispatch", input ?? {}, [], true, options)
  },

  /**
   * POST /api/repos/workflows/manage
   */
  postReposWorkflowsManage(input?: { body?: { "owner"?: string; "repo"?: string; "workflow"?: string; "operation"?: "enable" | "disable"; "reason"?: string } }, options?: RequestOptions): Promise<ApiResult<unknown>> {
    return request(config, "POST", "/api/repos/workflows/manage", input ?? {}, [], true, options)
  },

  /**
   * GET /api/requests
   */
  getRequests(options?: RequestOptions): Promise<ApiResult<{ "data": Array<{ "id": number; "method"?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" | "HEAD"; "path"?: string; "status_code"?: number; "duration_ms"?: number; "ip_address"?: string; "memory_usage"?: number; "user_agent"?: string; "error_message"?: string; "created_at"?: string; "updated_at"?: string; "deleted_at"?: string }> }>> {
    return request(config, "GET", "/api/requests", {}, [], false, options)
  },

  /**
   * POST /api/requests
   */
  postRequests(options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "method"?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" | "HEAD"; "path"?: string; "status_code"?: number; "duration_ms"?: number; "ip_address"?: string; "memory_usage"?: number; "user_agent"?: string; "error_message"?: string; "created_at"?: string; "updated_at"?: string; "deleted_at"?: string } }>> {
    return request(config, "POST", "/api/requests", {}, [], false, options)
  },

  /**
   * POST /api/requests/bulk-delete
   */
  postRequestsBulkDelete(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/requests/bulk-delete", {}, [], false, options)
  },

  /**
   * GET /api/requests/{id}
   */
  getRequestsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "method"?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" | "HEAD"; "path"?: string; "status_code"?: number; "duration_ms"?: number; "ip_address"?: string; "memory_usage"?: number; "user_agent"?: string; "error_message"?: string; "created_at"?: string; "updated_at"?: string; "deleted_at"?: string } }>> {
    return request(config, "GET", "/api/requests/{id}", input ?? {}, [], false, options)
  },

  /**
   * PUT /api/requests/{id}
   */
  putRequestsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "method"?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" | "HEAD"; "path"?: string; "status_code"?: number; "duration_ms"?: number; "ip_address"?: string; "memory_usage"?: number; "user_agent"?: string; "error_message"?: string; "created_at"?: string; "updated_at"?: string; "deleted_at"?: string } }>> {
    return request(config, "PUT", "/api/requests/{id}", input ?? {}, [], false, options)
  },

  /**
   * DELETE /api/requests/{id}
   */
  deleteRequestsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "method"?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" | "HEAD"; "path"?: string; "status_code"?: number; "duration_ms"?: number; "ip_address"?: string; "memory_usage"?: number; "user_agent"?: string; "error_message"?: string; "created_at"?: string; "updated_at"?: string; "deleted_at"?: string } }>> {
    return request(config, "DELETE", "/api/requests/{id}", input ?? {}, [], false, options)
  },

  /**
   * PATCH /api/requests/{id}
   */
  patchRequestsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "method"?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" | "HEAD"; "path"?: string; "status_code"?: number; "duration_ms"?: number; "ip_address"?: string; "memory_usage"?: number; "user_agent"?: string; "error_message"?: string; "created_at"?: string; "updated_at"?: string; "deleted_at"?: string } }>> {
    return request(config, "PATCH", "/api/requests/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/reviews/queue
   */
  getReviewsQueue(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/reviews/queue", {}, [], false, options)
  },

  /**
   * POST /api/reviews/submit
   */
  postReviewsSubmit(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/reviews/submit", {}, [], false, options)
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
  postRunnerHeartbeat(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/runner/heartbeat", {}, [], false, options)
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
  getSearch(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/search", {}, [], false, options)
  },

  /**
   * GET /api/serverless
   */
  getServerless(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/serverless", {}, [], false, options)
  },

  /**
   * GET /api/settings/mail
   */
  getSettingsMail(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/settings/mail", {}, [], false, options)
  },

  /**
   * PUT /api/settings/mail
   */
  putSettingsMail(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "PUT", "/api/settings/mail", {}, [], false, options)
  },

  /**
   * GET /api/shipping-methods
   */
  getShippingMethods(options?: RequestOptions): Promise<ApiResult<{ "data": Array<{ "id": number; "uuid": string; "name"?: string; "description"?: string; "base_rate"?: number; "free_shipping"?: number; "status"?: "active" | "inactive" | "draft"; "created_at"?: string; "updated_at"?: string }> }>> {
    return request(config, "GET", "/api/shipping-methods", {}, [], false, options)
  },

  /**
   * POST /api/shipping-methods
   */
  postShippingMethods(options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name"?: string; "description"?: string; "base_rate"?: number; "free_shipping"?: number; "status"?: "active" | "inactive" | "draft"; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "POST", "/api/shipping-methods", {}, [], false, options)
  },

  /**
   * POST /api/shipping-methods/bulk-delete
   */
  postShippingMethodsBulkDelete(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/shipping-methods/bulk-delete", {}, [], false, options)
  },

  /**
   * GET /api/shipping-methods/{id}
   */
  getShippingMethodsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name"?: string; "description"?: string; "base_rate"?: number; "free_shipping"?: number; "status"?: "active" | "inactive" | "draft"; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "GET", "/api/shipping-methods/{id}", input ?? {}, [], false, options)
  },

  /**
   * PUT /api/shipping-methods/{id}
   */
  putShippingMethodsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name"?: string; "description"?: string; "base_rate"?: number; "free_shipping"?: number; "status"?: "active" | "inactive" | "draft"; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PUT", "/api/shipping-methods/{id}", input ?? {}, [], false, options)
  },

  /**
   * DELETE /api/shipping-methods/{id}
   */
  deleteShippingMethodsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name"?: string; "description"?: string; "base_rate"?: number; "free_shipping"?: number; "status"?: "active" | "inactive" | "draft"; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "DELETE", "/api/shipping-methods/{id}", input ?? {}, [], false, options)
  },

  /**
   * PATCH /api/shipping-methods/{id}
   */
  patchShippingMethodsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name"?: string; "description"?: string; "base_rate"?: number; "free_shipping"?: number; "status"?: "active" | "inactive" | "draft"; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PATCH", "/api/shipping-methods/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/shipping-rates
   */
  getShippingRates(options?: RequestOptions): Promise<ApiResult<{ "data": Array<{ "id": number; "uuid": string; "weight_from"?: unknown; "weight_to"?: unknown; "rate"?: number; "shipping_method_id"?: number; "shipping_zone_id"?: number; "created_at"?: string; "updated_at"?: string }> }>> {
    return request(config, "GET", "/api/shipping-rates", {}, [], false, options)
  },

  /**
   * POST /api/shipping-rates
   */
  postShippingRates(options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "weight_from"?: unknown; "weight_to"?: unknown; "rate"?: number; "shipping_method_id"?: number; "shipping_zone_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "POST", "/api/shipping-rates", {}, [], false, options)
  },

  /**
   * POST /api/shipping-rates/bulk-delete
   */
  postShippingRatesBulkDelete(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/shipping-rates/bulk-delete", {}, [], false, options)
  },

  /**
   * GET /api/shipping-rates/{id}
   */
  getShippingRatesId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "weight_from"?: unknown; "weight_to"?: unknown; "rate"?: number; "shipping_method_id"?: number; "shipping_zone_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "GET", "/api/shipping-rates/{id}", input ?? {}, [], false, options)
  },

  /**
   * PUT /api/shipping-rates/{id}
   */
  putShippingRatesId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "weight_from"?: unknown; "weight_to"?: unknown; "rate"?: number; "shipping_method_id"?: number; "shipping_zone_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PUT", "/api/shipping-rates/{id}", input ?? {}, [], false, options)
  },

  /**
   * DELETE /api/shipping-rates/{id}
   */
  deleteShippingRatesId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "weight_from"?: unknown; "weight_to"?: unknown; "rate"?: number; "shipping_method_id"?: number; "shipping_zone_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "DELETE", "/api/shipping-rates/{id}", input ?? {}, [], false, options)
  },

  /**
   * PATCH /api/shipping-rates/{id}
   */
  patchShippingRatesId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "weight_from"?: unknown; "weight_to"?: unknown; "rate"?: number; "shipping_method_id"?: number; "shipping_zone_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PATCH", "/api/shipping-rates/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/shipping-zones
   */
  getShippingZones(options?: RequestOptions): Promise<ApiResult<{ "data": Array<{ "id": number; "uuid": string; "name"?: string; "countries"?: string; "regions"?: string; "postal_codes"?: string; "status"?: "active" | "inactive" | "draft"; "shipping_method_id"?: number; "created_at"?: string; "updated_at"?: string }> }>> {
    return request(config, "GET", "/api/shipping-zones", {}, [], false, options)
  },

  /**
   * POST /api/shipping-zones
   */
  postShippingZones(options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name"?: string; "countries"?: string; "regions"?: string; "postal_codes"?: string; "status"?: "active" | "inactive" | "draft"; "shipping_method_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "POST", "/api/shipping-zones", {}, [], false, options)
  },

  /**
   * POST /api/shipping-zones/bulk-delete
   */
  postShippingZonesBulkDelete(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/shipping-zones/bulk-delete", {}, [], false, options)
  },

  /**
   * GET /api/shipping-zones/{id}
   */
  getShippingZonesId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name"?: string; "countries"?: string; "regions"?: string; "postal_codes"?: string; "status"?: "active" | "inactive" | "draft"; "shipping_method_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "GET", "/api/shipping-zones/{id}", input ?? {}, [], false, options)
  },

  /**
   * PUT /api/shipping-zones/{id}
   */
  putShippingZonesId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name"?: string; "countries"?: string; "regions"?: string; "postal_codes"?: string; "status"?: "active" | "inactive" | "draft"; "shipping_method_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PUT", "/api/shipping-zones/{id}", input ?? {}, [], false, options)
  },

  /**
   * DELETE /api/shipping-zones/{id}
   */
  deleteShippingZonesId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name"?: string; "countries"?: string; "regions"?: string; "postal_codes"?: string; "status"?: "active" | "inactive" | "draft"; "shipping_method_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "DELETE", "/api/shipping-zones/{id}", input ?? {}, [], false, options)
  },

  /**
   * PATCH /api/shipping-zones/{id}
   */
  patchShippingZonesId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name"?: string; "countries"?: string; "regions"?: string; "postal_codes"?: string; "status"?: "active" | "inactive" | "draft"; "shipping_method_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PATCH", "/api/shipping-zones/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/social-posts
   */
  getSocialPosts(options?: RequestOptions): Promise<ApiResult<{ "data": Array<{ "id": number; "uuid": string; "content": string; "platform": "twitter" | "facebook" | "instagram" | "linkedin" | "tiktok" | "youtube"; "status": "draft" | "scheduled" | "published" | "failed"; "scheduled_at"?: unknown; "published_at"?: unknown; "likes"?: number; "shares"?: number; "comments"?: number; "reach"?: number; "image_url"?: string; "external_id"?: string; "user_id"?: number; "created_at"?: string; "updated_at"?: string }> }>> {
    return request(config, "GET", "/api/social-posts", {}, [], false, options)
  },

  /**
   * POST /api/social-posts
   */
  postSocialPosts(options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "content": string; "platform": "twitter" | "facebook" | "instagram" | "linkedin" | "tiktok" | "youtube"; "status": "draft" | "scheduled" | "published" | "failed"; "scheduled_at"?: unknown; "published_at"?: unknown; "likes"?: number; "shares"?: number; "comments"?: number; "reach"?: number; "image_url"?: string; "external_id"?: string; "user_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "POST", "/api/social-posts", {}, [], false, options)
  },

  /**
   * POST /api/social-posts/bulk-delete
   */
  postSocialPostsBulkDelete(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/social-posts/bulk-delete", {}, [], false, options)
  },

  /**
   * GET /api/social-posts/{id}
   */
  getSocialPostsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "content": string; "platform": "twitter" | "facebook" | "instagram" | "linkedin" | "tiktok" | "youtube"; "status": "draft" | "scheduled" | "published" | "failed"; "scheduled_at"?: unknown; "published_at"?: unknown; "likes"?: number; "shares"?: number; "comments"?: number; "reach"?: number; "image_url"?: string; "external_id"?: string; "user_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "GET", "/api/social-posts/{id}", input ?? {}, [], false, options)
  },

  /**
   * PUT /api/social-posts/{id}
   */
  putSocialPostsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "content": string; "platform": "twitter" | "facebook" | "instagram" | "linkedin" | "tiktok" | "youtube"; "status": "draft" | "scheduled" | "published" | "failed"; "scheduled_at"?: unknown; "published_at"?: unknown; "likes"?: number; "shares"?: number; "comments"?: number; "reach"?: number; "image_url"?: string; "external_id"?: string; "user_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PUT", "/api/social-posts/{id}", input ?? {}, [], false, options)
  },

  /**
   * DELETE /api/social-posts/{id}
   */
  deleteSocialPostsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "content": string; "platform": "twitter" | "facebook" | "instagram" | "linkedin" | "tiktok" | "youtube"; "status": "draft" | "scheduled" | "published" | "failed"; "scheduled_at"?: unknown; "published_at"?: unknown; "likes"?: number; "shares"?: number; "comments"?: number; "reach"?: number; "image_url"?: string; "external_id"?: string; "user_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "DELETE", "/api/social-posts/{id}", input ?? {}, [], false, options)
  },

  /**
   * PATCH /api/social-posts/{id}
   */
  patchSocialPostsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "content": string; "platform": "twitter" | "facebook" | "instagram" | "linkedin" | "tiktok" | "youtube"; "status": "draft" | "scheduled" | "published" | "failed"; "scheduled_at"?: unknown; "published_at"?: unknown; "likes"?: number; "shares"?: number; "comments"?: number; "reach"?: number; "image_url"?: string; "external_id"?: string; "user_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PATCH", "/api/social-posts/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/subscriber-emails
   */
  getSubscriberEmails(options?: RequestOptions): Promise<ApiResult<{ "data": Array<{ "id": number; "uuid": string; "email": string; "source"?: string; "subscriber_id"?: number; "created_at"?: string; "updated_at"?: string }> }>> {
    return request(config, "GET", "/api/subscriber-emails", {}, [], false, options)
  },

  /**
   * GET /api/subscriber-emails/{id}
   */
  getSubscriberEmailsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "email": string; "source"?: string; "subscriber_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "GET", "/api/subscriber-emails/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/subscribers
   */
  getSubscribers(options?: RequestOptions): Promise<ApiResult<{ "data": Array<{ "id": number; "uuid": string; "email": string; "status": "subscribed" | "unsubscribed" | "pending" | "bounced"; "source"?: string; "unsubscribed_at"?: unknown; "user_id"?: number; "created_at"?: string; "updated_at"?: string }> }>> {
    return request(config, "GET", "/api/subscribers", {}, [], false, options)
  },

  /**
   * POST /api/subscribers
   */
  postSubscribers(options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "email": string; "status": "subscribed" | "unsubscribed" | "pending" | "bounced"; "source"?: string; "unsubscribed_at"?: unknown; "user_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "POST", "/api/subscribers", {}, [], false, options)
  },

  /**
   * POST /api/subscribers/bulk-delete
   */
  postSubscribersBulkDelete(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/subscribers/bulk-delete", {}, [], false, options)
  },

  /**
   * GET /api/subscribers/{id}
   */
  getSubscribersId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "email": string; "status": "subscribed" | "unsubscribed" | "pending" | "bounced"; "source"?: string; "unsubscribed_at"?: unknown; "user_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "GET", "/api/subscribers/{id}", input ?? {}, [], false, options)
  },

  /**
   * PUT /api/subscribers/{id}
   */
  putSubscribersId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "email": string; "status": "subscribed" | "unsubscribed" | "pending" | "bounced"; "source"?: string; "unsubscribed_at"?: unknown; "user_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PUT", "/api/subscribers/{id}", input ?? {}, [], false, options)
  },

  /**
   * DELETE /api/subscribers/{id}
   */
  deleteSubscribersId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "email": string; "status": "subscribed" | "unsubscribed" | "pending" | "bounced"; "source"?: string; "unsubscribed_at"?: unknown; "user_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "DELETE", "/api/subscribers/{id}", input ?? {}, [], false, options)
  },

  /**
   * PATCH /api/subscribers/{id}
   */
  patchSubscribersId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "email": string; "status": "subscribed" | "unsubscribed" | "pending" | "bounced"; "source"?: string; "unsubscribed_at"?: unknown; "user_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PATCH", "/api/subscribers/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/tags
   */
  getTags(options?: RequestOptions): Promise<ApiResult<{ "data": Array<{ "id": number; "uuid": string; "name": string; "slug": string; "description"?: string; "color"?: string; "created_at"?: string; "updated_at"?: string }> }>> {
    return request(config, "GET", "/api/tags", {}, [], false, options)
  },

  /**
   * POST /api/tags
   */
  postTags(options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name": string; "slug": string; "description"?: string; "color"?: string; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "POST", "/api/tags", {}, [], false, options)
  },

  /**
   * POST /api/tags/bulk-delete
   */
  postTagsBulkDelete(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/tags/bulk-delete", {}, [], false, options)
  },

  /**
   * GET /api/tags/{id}
   */
  getTagsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name": string; "slug": string; "description"?: string; "color"?: string; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "GET", "/api/tags/{id}", input ?? {}, [], false, options)
  },

  /**
   * PUT /api/tags/{id}
   */
  putTagsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name": string; "slug": string; "description"?: string; "color"?: string; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PUT", "/api/tags/{id}", input ?? {}, [], false, options)
  },

  /**
   * DELETE /api/tags/{id}
   */
  deleteTagsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name": string; "slug": string; "description"?: string; "color"?: string; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "DELETE", "/api/tags/{id}", input ?? {}, [], false, options)
  },

  /**
   * PATCH /api/tags/{id}
   */
  patchTagsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name": string; "slug": string; "description"?: string; "color"?: string; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PATCH", "/api/tags/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/tax-rates
   */
  getTaxRates(options?: RequestOptions): Promise<ApiResult<{ "data": Array<{ "id": number; "uuid": string; "name"?: string; "rate"?: number; "type"?: string; "country"?: string; "region"?: "North America" | "South America" | "Europe" | "Asia" | "Africa" | "Oceania" | "Antarctica"; "status"?: "active" | "inactive"; "is_default"?: boolean; "created_at"?: string; "updated_at"?: string }> }>> {
    return request(config, "GET", "/api/tax-rates", {}, [], false, options)
  },

  /**
   * POST /api/tax-rates
   */
  postTaxRates(options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name"?: string; "rate"?: number; "type"?: string; "country"?: string; "region"?: "North America" | "South America" | "Europe" | "Asia" | "Africa" | "Oceania" | "Antarctica"; "status"?: "active" | "inactive"; "is_default"?: boolean; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "POST", "/api/tax-rates", {}, [], false, options)
  },

  /**
   * POST /api/tax-rates/bulk-delete
   */
  postTaxRatesBulkDelete(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/tax-rates/bulk-delete", {}, [], false, options)
  },

  /**
   * GET /api/tax-rates/{id}
   */
  getTaxRatesId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name"?: string; "rate"?: number; "type"?: string; "country"?: string; "region"?: "North America" | "South America" | "Europe" | "Asia" | "Africa" | "Oceania" | "Antarctica"; "status"?: "active" | "inactive"; "is_default"?: boolean; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "GET", "/api/tax-rates/{id}", input ?? {}, [], false, options)
  },

  /**
   * PUT /api/tax-rates/{id}
   */
  putTaxRatesId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name"?: string; "rate"?: number; "type"?: string; "country"?: string; "region"?: "North America" | "South America" | "Europe" | "Asia" | "Africa" | "Oceania" | "Antarctica"; "status"?: "active" | "inactive"; "is_default"?: boolean; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PUT", "/api/tax-rates/{id}", input ?? {}, [], false, options)
  },

  /**
   * DELETE /api/tax-rates/{id}
   */
  deleteTaxRatesId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name"?: string; "rate"?: number; "type"?: string; "country"?: string; "region"?: "North America" | "South America" | "Europe" | "Asia" | "Africa" | "Oceania" | "Antarctica"; "status"?: "active" | "inactive"; "is_default"?: boolean; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "DELETE", "/api/tax-rates/{id}", input ?? {}, [], false, options)
  },

  /**
   * PATCH /api/tax-rates/{id}
   */
  patchTaxRatesId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name"?: string; "rate"?: number; "type"?: string; "country"?: string; "region"?: "North America" | "South America" | "Europe" | "Asia" | "Africa" | "Oceania" | "Antarctica"; "status"?: "active" | "inactive"; "is_default"?: boolean; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PATCH", "/api/tax-rates/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/transactions
   */
  getTransactions(options?: RequestOptions): Promise<ApiResult<{ "data": Array<{ "id": number; "uuid": string; "amount"?: number; "status"?: string; "payment_method"?: string; "transaction_reference"?: string; "loyalty_points_earned"?: number; "loyalty_points_redeemed"?: number; "order_id"?: number; "created_at"?: string; "updated_at"?: string }> }>> {
    return request(config, "GET", "/api/transactions", {}, [], false, options)
  },

  /**
   * POST /api/transactions
   */
  postTransactions(options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "amount"?: number; "status"?: string; "payment_method"?: string; "transaction_reference"?: string; "loyalty_points_earned"?: number; "loyalty_points_redeemed"?: number; "order_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "POST", "/api/transactions", {}, [], false, options)
  },

  /**
   * POST /api/transactions/bulk-delete
   */
  postTransactionsBulkDelete(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/transactions/bulk-delete", {}, [], false, options)
  },

  /**
   * GET /api/transactions/{id}
   */
  getTransactionsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "amount"?: number; "status"?: string; "payment_method"?: string; "transaction_reference"?: string; "loyalty_points_earned"?: number; "loyalty_points_redeemed"?: number; "order_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "GET", "/api/transactions/{id}", input ?? {}, [], false, options)
  },

  /**
   * PUT /api/transactions/{id}
   */
  putTransactionsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "amount"?: number; "status"?: string; "payment_method"?: string; "transaction_reference"?: string; "loyalty_points_earned"?: number; "loyalty_points_redeemed"?: number; "order_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PUT", "/api/transactions/{id}", input ?? {}, [], false, options)
  },

  /**
   * DELETE /api/transactions/{id}
   */
  deleteTransactionsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "amount"?: number; "status"?: string; "payment_method"?: string; "transaction_reference"?: string; "loyalty_points_earned"?: number; "loyalty_points_redeemed"?: number; "order_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "DELETE", "/api/transactions/{id}", input ?? {}, [], false, options)
  },

  /**
   * PATCH /api/transactions/{id}
   */
  patchTransactionsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "amount"?: number; "status"?: string; "payment_method"?: string; "transaction_reference"?: string; "loyalty_points_earned"?: number; "loyalty_points_redeemed"?: number; "order_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PATCH", "/api/transactions/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/user
   */
  getUser(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/user", {}, [], false, options)
  },

  /**
   * POST /api/user/gpg-keys
   */
  postUserGpgKeys(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/user/gpg-keys", {}, [], false, options)
  },

  /**
   * DELETE /api/user/gpg-keys
   */
  deleteUserGpgKeys(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "DELETE", "/api/user/gpg-keys", {}, [], false, options)
  },

  /**
   * POST /api/user/gpg-keys/delete
   */
  postUserGpgKeysDelete(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/user/gpg-keys/delete", {}, [], false, options)
  },

  /**
   * POST /api/user/keys
   */
  postUserKeys(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/user/keys", {}, [], false, options)
  },

  /**
   * DELETE /api/user/keys
   */
  deleteUserKeys(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "DELETE", "/api/user/keys", {}, [], false, options)
  },

  /**
   * POST /api/user/keys/delete
   */
  postUserKeysDelete(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/user/keys/delete", {}, [], false, options)
  },

  /**
   * GET /api/user/notifications
   */
  getUserNotifications(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/user/notifications", {}, [], false, options)
  },

  /**
   * POST /api/user/notifications/mutes
   */
  postUserNotificationsMutes(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/user/notifications/mutes", {}, [], false, options)
  },

  /**
   * POST /api/user/notifications/preferences
   */
  postUserNotificationsPreferences(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/user/notifications/preferences", {}, [], false, options)
  },

  /**
   * POST /api/user/notifications/push
   */
  postUserNotificationsPush(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/user/notifications/push", {}, [], false, options)
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
  postUserNotificationsRead(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/user/notifications/read", {}, [], false, options)
  },

  /**
   * PUT /api/user/notifications/schedule
   */
  putUserNotificationsSchedule(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "PUT", "/api/user/notifications/schedule", {}, [], false, options)
  },

  /**
   * POST /api/user/passkeys
   */
  postUserPasskeys(input?: { body?: { "operation"?: "list" | "options" | "register" | "remove"; "id"?: string; "credential"?: string } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/user/passkeys", input ?? {}, [], true, options)
  },

  /**
   * POST /api/user/profile
   */
  postUserProfile(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/user/profile", {}, [], false, options)
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
   * GET /api/waitlist-products
   */
  getWaitlistProducts(options?: RequestOptions): Promise<ApiResult<{ "data": Array<{ "id": number; "uuid": string; "name"?: string; "email"?: string; "phone"?: string; "quantity"?: number; "notification_preference"?: "sms" | "email" | "both"; "source"?: string; "notes"?: string; "status"?: "waiting" | "purchased" | "notified" | "cancelled"; "notified_at"?: unknown; "purchased_at"?: unknown; "cancelled_at"?: unknown; "product_id"?: number; "customer_id"?: number; "created_at"?: string; "updated_at"?: string }> }>> {
    return request(config, "GET", "/api/waitlist-products", {}, [], false, options)
  },

  /**
   * POST /api/waitlist-products
   */
  postWaitlistProducts(options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name"?: string; "email"?: string; "phone"?: string; "quantity"?: number; "notification_preference"?: "sms" | "email" | "both"; "source"?: string; "notes"?: string; "status"?: "waiting" | "purchased" | "notified" | "cancelled"; "notified_at"?: unknown; "purchased_at"?: unknown; "cancelled_at"?: unknown; "product_id"?: number; "customer_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "POST", "/api/waitlist-products", {}, [], false, options)
  },

  /**
   * POST /api/waitlist-products/bulk-delete
   */
  postWaitlistProductsBulkDelete(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/waitlist-products/bulk-delete", {}, [], false, options)
  },

  /**
   * GET /api/waitlist-products/{id}
   */
  getWaitlistProductsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name"?: string; "email"?: string; "phone"?: string; "quantity"?: number; "notification_preference"?: "sms" | "email" | "both"; "source"?: string; "notes"?: string; "status"?: "waiting" | "purchased" | "notified" | "cancelled"; "notified_at"?: unknown; "purchased_at"?: unknown; "cancelled_at"?: unknown; "product_id"?: number; "customer_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "GET", "/api/waitlist-products/{id}", input ?? {}, [], false, options)
  },

  /**
   * PUT /api/waitlist-products/{id}
   */
  putWaitlistProductsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name"?: string; "email"?: string; "phone"?: string; "quantity"?: number; "notification_preference"?: "sms" | "email" | "both"; "source"?: string; "notes"?: string; "status"?: "waiting" | "purchased" | "notified" | "cancelled"; "notified_at"?: unknown; "purchased_at"?: unknown; "cancelled_at"?: unknown; "product_id"?: number; "customer_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PUT", "/api/waitlist-products/{id}", input ?? {}, [], false, options)
  },

  /**
   * DELETE /api/waitlist-products/{id}
   */
  deleteWaitlistProductsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name"?: string; "email"?: string; "phone"?: string; "quantity"?: number; "notification_preference"?: "sms" | "email" | "both"; "source"?: string; "notes"?: string; "status"?: "waiting" | "purchased" | "notified" | "cancelled"; "notified_at"?: unknown; "purchased_at"?: unknown; "cancelled_at"?: unknown; "product_id"?: number; "customer_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "DELETE", "/api/waitlist-products/{id}", input ?? {}, [], false, options)
  },

  /**
   * PATCH /api/waitlist-products/{id}
   */
  patchWaitlistProductsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name"?: string; "email"?: string; "phone"?: string; "quantity"?: number; "notification_preference"?: "sms" | "email" | "both"; "source"?: string; "notes"?: string; "status"?: "waiting" | "purchased" | "notified" | "cancelled"; "notified_at"?: unknown; "purchased_at"?: unknown; "cancelled_at"?: unknown; "product_id"?: number; "customer_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PATCH", "/api/waitlist-products/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/waitlist-restaurants
   */
  getWaitlistRestaurants(options?: RequestOptions): Promise<ApiResult<{ "data": Array<{ "id": number; "uuid": string; "name"?: string; "email"?: string; "phone"?: string; "party_size"?: number; "check_in_time"?: unknown; "table_preference"?: "indoor" | "bar" | "booth" | "no_preference"; "status"?: "waiting" | "seated" | "cancelled" | "no_show"; "quoted_wait_time"?: number; "actual_wait_time"?: number; "queue_position"?: number; "seated_at"?: unknown; "no_show_at"?: unknown; "cancelled_at"?: unknown; "customer_id"?: number; "created_at"?: string; "updated_at"?: string }> }>> {
    return request(config, "GET", "/api/waitlist-restaurants", {}, [], false, options)
  },

  /**
   * POST /api/waitlist-restaurants
   */
  postWaitlistRestaurants(options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name"?: string; "email"?: string; "phone"?: string; "party_size"?: number; "check_in_time"?: unknown; "table_preference"?: "indoor" | "bar" | "booth" | "no_preference"; "status"?: "waiting" | "seated" | "cancelled" | "no_show"; "quoted_wait_time"?: number; "actual_wait_time"?: number; "queue_position"?: number; "seated_at"?: unknown; "no_show_at"?: unknown; "cancelled_at"?: unknown; "customer_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "POST", "/api/waitlist-restaurants", {}, [], false, options)
  },

  /**
   * POST /api/waitlist-restaurants/bulk-delete
   */
  postWaitlistRestaurantsBulkDelete(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/waitlist-restaurants/bulk-delete", {}, [], false, options)
  },

  /**
   * GET /api/waitlist-restaurants/{id}
   */
  getWaitlistRestaurantsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name"?: string; "email"?: string; "phone"?: string; "party_size"?: number; "check_in_time"?: unknown; "table_preference"?: "indoor" | "bar" | "booth" | "no_preference"; "status"?: "waiting" | "seated" | "cancelled" | "no_show"; "quoted_wait_time"?: number; "actual_wait_time"?: number; "queue_position"?: number; "seated_at"?: unknown; "no_show_at"?: unknown; "cancelled_at"?: unknown; "customer_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "GET", "/api/waitlist-restaurants/{id}", input ?? {}, [], false, options)
  },

  /**
   * PUT /api/waitlist-restaurants/{id}
   */
  putWaitlistRestaurantsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name"?: string; "email"?: string; "phone"?: string; "party_size"?: number; "check_in_time"?: unknown; "table_preference"?: "indoor" | "bar" | "booth" | "no_preference"; "status"?: "waiting" | "seated" | "cancelled" | "no_show"; "quoted_wait_time"?: number; "actual_wait_time"?: number; "queue_position"?: number; "seated_at"?: unknown; "no_show_at"?: unknown; "cancelled_at"?: unknown; "customer_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PUT", "/api/waitlist-restaurants/{id}", input ?? {}, [], false, options)
  },

  /**
   * DELETE /api/waitlist-restaurants/{id}
   */
  deleteWaitlistRestaurantsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name"?: string; "email"?: string; "phone"?: string; "party_size"?: number; "check_in_time"?: unknown; "table_preference"?: "indoor" | "bar" | "booth" | "no_preference"; "status"?: "waiting" | "seated" | "cancelled" | "no_show"; "quoted_wait_time"?: number; "actual_wait_time"?: number; "queue_position"?: number; "seated_at"?: unknown; "no_show_at"?: unknown; "cancelled_at"?: unknown; "customer_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "DELETE", "/api/waitlist-restaurants/{id}", input ?? {}, [], false, options)
  },

  /**
   * PATCH /api/waitlist-restaurants/{id}
   */
  patchWaitlistRestaurantsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "name"?: string; "email"?: string; "phone"?: string; "party_size"?: number; "check_in_time"?: unknown; "table_preference"?: "indoor" | "bar" | "booth" | "no_preference"; "status"?: "waiting" | "seated" | "cancelled" | "no_show"; "quoted_wait_time"?: number; "actual_wait_time"?: number; "queue_position"?: number; "seated_at"?: unknown; "no_show_at"?: unknown; "cancelled_at"?: unknown; "customer_id"?: number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "PATCH", "/api/waitlist-restaurants/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /api/websockets
   */
  getWebsockets(options?: RequestOptions): Promise<ApiResult<{ "data": Array<{ "id": number; "type": "disconnection" | "error" | "success"; "socket": string; "details": string; "time": number; "created_at"?: string; "updated_at"?: string }> }>> {
    return request(config, "GET", "/api/websockets", {}, [], false, options)
  },

  /**
   * POST /api/websockets
   */
  postWebsockets(options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "type": "disconnection" | "error" | "success"; "socket": string; "details": string; "time": number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "POST", "/api/websockets", {}, [], false, options)
  },

  /**
   * GET /api/websockets/{id}
   */
  getWebsocketsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "type": "disconnection" | "error" | "success"; "socket": string; "details": string; "time": number; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "GET", "/api/websockets/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /attachments/{key}
   */
  getAttachmentsKey(input: { "key": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/attachments/{key}", input ?? {}, [], false, options)
  },

  /**
   * GET /auth/abilities
   */
  getAuthAbilities(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/auth/abilities", {}, [], false, options)
  },

  /**
   * POST /auth/refresh
   */
  postAuthRefresh(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/auth/refresh", {}, [], false, options)
  },

  /**
   * POST /auth/token
   */
  postAuthToken(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/auth/token", {}, [], false, options)
  },

  /**
   * GET /auth/tokens
   */
  getAuthTokens(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/auth/tokens", {}, [], false, options)
  },

  /**
   * DELETE /auth/tokens/{id}
   */
  deleteAuthTokensId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "DELETE", "/auth/tokens/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /cms/authors
   */
  getCmsAuthors(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/cms/authors", {}, [], false, options)
  },

  /**
   * POST /cms/authors
   */
  postCmsAuthors(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/cms/authors", {}, [], false, options)
  },

  /**
   * GET /cms/authors/{id}
   */
  getCmsAuthorsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/cms/authors/{id}", input ?? {}, [], false, options)
  },

  /**
   * DELETE /cms/authors/{id}
   */
  deleteCmsAuthorsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "DELETE", "/cms/authors/{id}", input ?? {}, [], false, options)
  },

  /**
   * PATCH /cms/authors/{id}
   */
  patchCmsAuthorsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "PATCH", "/cms/authors/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /cms/categories
   */
  getCmsCategories(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/cms/categories", {}, [], false, options)
  },

  /**
   * POST /cms/categories
   */
  postCmsCategories(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/cms/categories", {}, [], false, options)
  },

  /**
   * GET /cms/categories/{id}
   */
  getCmsCategoriesId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/cms/categories/{id}", input ?? {}, [], false, options)
  },

  /**
   * DELETE /cms/categories/{id}
   */
  deleteCmsCategoriesId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "DELETE", "/cms/categories/{id}", input ?? {}, [], false, options)
  },

  /**
   * PATCH /cms/categories/{id}
   */
  patchCmsCategoriesId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "PATCH", "/cms/categories/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /cms/comments
   */
  getCmsComments(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/cms/comments", {}, [], false, options)
  },

  /**
   * POST /cms/comments
   */
  postCmsComments(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/cms/comments", {}, [], false, options)
  },

  /**
   * GET /cms/comments/{id}
   */
  getCmsCommentsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/cms/comments/{id}", input ?? {}, [], false, options)
  },

  /**
   * DELETE /cms/comments/{id}
   */
  deleteCmsCommentsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "DELETE", "/cms/comments/{id}", input ?? {}, [], false, options)
  },

  /**
   * PATCH /cms/comments/{id}
   */
  patchCmsCommentsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "PATCH", "/cms/comments/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /cms/dashboard
   */
  getCmsDashboard(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/cms/dashboard", {}, [], false, options)
  },

  /**
   * GET /cms/files
   */
  getCmsFiles(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/cms/files", {}, [], false, options)
  },

  /**
   * GET /cms/pages
   */
  getCmsPages(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/cms/pages", {}, [], false, options)
  },

  /**
   * POST /cms/pages
   */
  postCmsPages(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/cms/pages", {}, [], false, options)
  },

  /**
   * DELETE /cms/pages/{id}
   */
  deleteCmsPagesId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "DELETE", "/cms/pages/{id}", input ?? {}, [], false, options)
  },

  /**
   * PATCH /cms/pages/{id}
   */
  patchCmsPagesId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "PATCH", "/cms/pages/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /cms/posts
   */
  getCmsPosts(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/cms/posts", {}, [], false, options)
  },

  /**
   * POST /cms/posts
   */
  postCmsPosts(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/cms/posts", {}, [], false, options)
  },

  /**
   * GET /cms/posts/{id}
   */
  getCmsPostsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/cms/posts/{id}", input ?? {}, [], false, options)
  },

  /**
   * DELETE /cms/posts/{id}
   */
  deleteCmsPostsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "DELETE", "/cms/posts/{id}", input ?? {}, [], false, options)
  },

  /**
   * PATCH /cms/posts/{id}
   */
  patchCmsPostsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "PATCH", "/cms/posts/{id}", input ?? {}, [], false, options)
  },

  /**
   * PATCH /cms/posts/{id}/views
   */
  patchCmsPostsIdViews(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "PATCH", "/cms/posts/{id}/views", input ?? {}, [], false, options)
  },

  /**
   * GET /cms/seo
   */
  getCmsSeo(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/cms/seo", {}, [], false, options)
  },

  /**
   * GET /cms/tags
   */
  getCmsTags(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/cms/tags", {}, [], false, options)
  },

  /**
   * POST /cms/tags
   */
  postCmsTags(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/cms/tags", {}, [], false, options)
  },

  /**
   * GET /cms/tags/{id}
   */
  getCmsTagsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/cms/tags/{id}", input ?? {}, [], false, options)
  },

  /**
   * DELETE /cms/tags/{id}
   */
  deleteCmsTagsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "DELETE", "/cms/tags/{id}", input ?? {}, [], false, options)
  },

  /**
   * PATCH /cms/tags/{id}
   */
  patchCmsTagsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "PATCH", "/cms/tags/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /dashboard/activity
   */
  getDashboardActivity(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/dashboard/activity", {}, [], false, options)
  },

  /**
   * GET /dashboard/buddy
   */
  getDashboardBuddy(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/dashboard/buddy", {}, [], false, options)
  },

  /**
   * GET /dashboard/cms/authors
   */
  getDashboardCmsAuthors(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/dashboard/cms/authors", {}, [], false, options)
  },

  /**
   * GET /dashboard/cms/categories
   */
  getDashboardCmsCategories(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/dashboard/cms/categories", {}, [], false, options)
  },

  /**
   * GET /dashboard/cms/comments
   */
  getDashboardCmsComments(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/dashboard/cms/comments", {}, [], false, options)
  },

  /**
   * GET /dashboard/cms/pages
   */
  getDashboardCmsPages(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/dashboard/cms/pages", {}, [], false, options)
  },

  /**
   * GET /dashboard/cms/posts
   */
  getDashboardCmsPosts(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/dashboard/cms/posts", {}, [], false, options)
  },

  /**
   * GET /dashboard/cms/tags
   */
  getDashboardCmsTags(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/dashboard/cms/tags", {}, [], false, options)
  },

  /**
   * GET /dashboard/commerce/coupons
   */
  getDashboardCommerceCoupons2(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/dashboard/commerce/coupons", {}, [], false, options)
  },

  /**
   * GET /dashboard/commerce/customers
   */
  getDashboardCommerceCustomers2(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/dashboard/commerce/customers", {}, [], false, options)
  },

  /**
   * GET /dashboard/commerce/delivery
   */
  getDashboardCommerceDelivery2(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/dashboard/commerce/delivery", {}, [], false, options)
  },

  /**
   * GET /dashboard/commerce/gift-cards
   */
  getDashboardCommerceGiftCards2(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/dashboard/commerce/gift-cards", {}, [], false, options)
  },

  /**
   * GET /dashboard/commerce/orders
   */
  getDashboardCommerceOrders2(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/dashboard/commerce/orders", {}, [], false, options)
  },

  /**
   * GET /dashboard/commerce/payments
   */
  getDashboardCommercePayments2(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/dashboard/commerce/payments", {}, [], false, options)
  },

  /**
   * GET /dashboard/commerce/products
   */
  getDashboardCommerceProducts2(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/dashboard/commerce/products", {}, [], false, options)
  },

  /**
   * GET /dashboard/commerce/reviews
   */
  getDashboardCommerceReviews2(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/dashboard/commerce/reviews", {}, [], false, options)
  },

  /**
   * GET /dashboard/commerce/taxes
   */
  getDashboardCommerceTaxes2(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/dashboard/commerce/taxes", {}, [], false, options)
  },

  /**
   * GET /dashboard/health
   */
  getDashboardHealth(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/dashboard/health", {}, [], false, options)
  },

  /**
   * GET /dashboard/home
   */
  getDashboardHome2(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/dashboard/home", {}, [], false, options)
  },

  /**
   * GET /dashboard/search
   */
  getDashboardSearch(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/dashboard/search", {}, [], false, options)
  },

  /**
   * GET /dashboard/services
   */
  getDashboardServices(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/dashboard/services", {}, [], false, options)
  },

  /**
   * GET /dashboard/settings
   */
  getDashboardSettings(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/dashboard/settings", {}, [], false, options)
  },

  /**
   * GET /dashboard/stats
   */
  getDashboardStats(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/dashboard/stats", {}, [], false, options)
  },

  /**
   * GET /deployments/
   */
  getDeployments2(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/deployments/", {}, [], false, options)
  },

  /**
   * POST /deployments/
   */
  postDeployments(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/deployments/", {}, [], false, options)
  },

  /**
   * GET /deployments/avg-time
   */
  getDeploymentsAvgTime(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/deployments/avg-time", {}, [], false, options)
  },

  /**
   * GET /deployments/count
   */
  getDeploymentsCount(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/deployments/count", {}, [], false, options)
  },

  /**
   * GET /deployments/recent
   */
  getDeploymentsRecent(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/deployments/recent", {}, [], false, options)
  },

  /**
   * GET /deployments/script
   */
  getDeploymentsScript(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/deployments/script", {}, [], false, options)
  },

  /**
   * PUT /deployments/script
   */
  putDeploymentsScript(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "PUT", "/deployments/script", {}, [], false, options)
  },

  /**
   * GET /deployments/terminal
   */
  getDeploymentsTerminal(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/deployments/terminal", {}, [], false, options)
  },

  /**
   * POST /disable-two-factor
   */
  postDisableTwoFactor(input?: { body?: { "password"?: string } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/disable-two-factor", input ?? {}, [], true, options)
  },

  /**
   * POST /enable-two-factor
   */
  postEnableTwoFactor(input?: { body?: { "code"?: string } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/enable-two-factor", input ?? {}, [], true, options)
  },

  /**
   * GET /generate-authentication-options
   */
  getGenerateAuthenticationOptions(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/generate-authentication-options", {}, [], false, options)
  },

  /**
   * GET /generate-registration-options
   */
  getGenerateRegistrationOptions(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/generate-registration-options", {}, [], false, options)
  },

  /**
   * POST /generate-two-factor-secret
   */
  postGenerateTwoFactorSecret(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/generate-two-factor-secret", {}, [], false, options)
  },

  /**
   * GET /inbox/
   */
  getInbox(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/inbox/", {}, [], false, options)
  },

  /**
   * GET /inbox/{id}
   */
  getInboxId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/inbox/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /infrastructure/cloud
   */
  getInfrastructureCloud(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/infrastructure/cloud", {}, [], false, options)
  },

  /**
   * GET /infrastructure/dns
   */
  getInfrastructureDns(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/infrastructure/dns", {}, [], false, options)
  },

  /**
   * GET /infrastructure/environment
   */
  getInfrastructureEnvironment(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/infrastructure/environment", {}, [], false, options)
  },

  /**
   * GET /infrastructure/insights
   */
  getInfrastructureInsights(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/infrastructure/insights", {}, [], false, options)
  },

  /**
   * GET /infrastructure/logs
   */
  getInfrastructureLogs(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/infrastructure/logs", {}, [], false, options)
  },

  /**
   * GET /infrastructure/mailboxes
   */
  getInfrastructureMailboxes(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/infrastructure/mailboxes", {}, [], false, options)
  },

  /**
   * GET /infrastructure/permissions
   */
  getInfrastructurePermissions(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/infrastructure/permissions", {}, [], false, options)
  },

  /**
   * GET /infrastructure/servers
   */
  getInfrastructureServers(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/infrastructure/servers", {}, [], false, options)
  },

  /**
   * GET /install
   */
  getInstall(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/install", {}, [], false, options)
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
   * GET /jobs/
   */
  getJobs(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/jobs/", {}, [], false, options)
  },

  /**
   * GET /jobs/stats
   */
  getJobsStats(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/jobs/stats", {}, [], false, options)
  },

  /**
   * POST /jobs/{id}/retry
   */
  postJobsIdRetry(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/jobs/{id}/retry", input ?? {}, [], false, options)
  },

  /**
   * GET /library/components
   */
  getLibraryComponents(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/library/components", {}, [], false, options)
  },

  /**
   * POST /library/components
   */
  postLibraryComponents(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/library/components", {}, [], false, options)
  },

  /**
   * GET /library/components/downloads
   */
  getLibraryComponentsDownloads(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/library/components/downloads", {}, [], false, options)
  },

  /**
   * GET /library/dependencies
   */
  getLibraryDependencies(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/library/dependencies", {}, [], false, options)
  },

  /**
   * GET /library/downloads
   */
  getLibraryDownloads(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/library/downloads", {}, [], false, options)
  },

  /**
   * GET /library/functions
   */
  getLibraryFunctions(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/library/functions", {}, [], false, options)
  },

  /**
   * POST /library/functions
   */
  postLibraryFunctions(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/library/functions", {}, [], false, options)
  },

  /**
   * GET /library/functions/downloads
   */
  getLibraryFunctionsDownloads(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/library/functions/downloads", {}, [], false, options)
  },

  /**
   * GET /library/packages
   */
  getLibraryPackages(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/library/packages", {}, [], false, options)
  },

  /**
   * GET /library/releases
   */
  getLibraryReleases(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/library/releases", {}, [], false, options)
  },

  /**
   * GET /library/releases/avg-time
   */
  getLibraryReleasesAvgTime(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/library/releases/avg-time", {}, [], false, options)
  },

  /**
   * GET /library/releases/count
   */
  getLibraryReleasesCount(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/library/releases/count", {}, [], false, options)
  },

  /**
   * GET /locale/{locale}
   */
  getLocaleLocale(input: { "locale": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/locale/{locale}", input ?? {}, [], false, options)
  },

  /**
   * POST /login
   */
  postLogin(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/login", {}, [], false, options)
  },

  /**
   * POST /logout
   */
  postLogout(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/logout", {}, [], false, options)
  },

  /**
   * POST /logout-all
   */
  postLogoutAll(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/logout-all", {}, [], false, options)
  },

  /**
   * GET /me
   */
  getMe(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/me", {}, [], false, options)
  },

  /**
   * GET /models/
   */
  getModels(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/models/", {}, [], false, options)
  },

  /**
   * GET /models/subscriber-count
   */
  getModelsSubscriberCount(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/models/subscriber-count", {}, [], false, options)
  },

  /**
   * GET /models/user-count
   */
  getModelsUserCount(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/models/user-count", {}, [], false, options)
  },

  /**
   * POST /password/forgot
   */
  postPasswordForgot(input: { body: { "email": string } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/password/forgot", input ?? {}, [], true, options)
  },

  /**
   * POST /password/reset
   */
  postPasswordReset(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/password/reset", {}, [], false, options)
  },

  /**
   * POST /password/verify-token
   */
  postPasswordVerifyToken(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/password/verify-token", {}, [], false, options)
  },

  /**
   * POST /payments/cancel-subscription/{id}
   */
  postPaymentsCancelSubscriptionId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/payments/cancel-subscription/{id}", input ?? {}, [], false, options)
  },

  /**
   * POST /payments/checkout/{id}
   */
  postPaymentsCheckoutId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/payments/checkout/{id}", input ?? {}, [], false, options)
  },

  /**
   * POST /payments/create-invoice-subscription/{id}
   */
  postPaymentsCreateInvoiceSubscriptionId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/payments/create-invoice-subscription/{id}", input ?? {}, [], false, options)
  },

  /**
   * POST /payments/create-payment-intent/{id}
   */
  postPaymentsCreatePaymentIntentId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/payments/create-payment-intent/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /payments/create-setup-intent/{id}
   */
  getPaymentsCreateSetupIntentId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/payments/create-setup-intent/{id}", input ?? {}, [], false, options)
  },

  /**
   * POST /payments/create-subscription/{id}
   */
  postPaymentsCreateSubscriptionId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/payments/create-subscription/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /payments/default-payment-method/{id}
   */
  getPaymentsDefaultPaymentMethodId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/payments/default-payment-method/{id}", input ?? {}, [], false, options)
  },

  /**
   * DELETE /payments/delete-payment-method/{id}
   */
  deletePaymentsDeletePaymentMethodId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "DELETE", "/payments/delete-payment-method/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /payments/fetch-active-subscription/{id}
   */
  getPaymentsFetchActiveSubscriptionId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/payments/fetch-active-subscription/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /payments/fetch-customer/{id}
   */
  getPaymentsFetchCustomerId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/payments/fetch-customer/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /payments/fetch-product/{id}
   */
  getPaymentsFetchProductId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/payments/fetch-product/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /payments/fetch-transaction-history/{id}
   */
  getPaymentsFetchTransactionHistoryId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/payments/fetch-transaction-history/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /payments/fetch-user-subscriptions/{id}
   */
  getPaymentsFetchUserSubscriptionsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/payments/fetch-user-subscriptions/{id}", input ?? {}, [], false, options)
  },

  /**
   * POST /payments/payment-method/{id}
   */
  postPaymentsPaymentMethodId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/payments/payment-method/{id}", input ?? {}, [], false, options)
  },

  /**
   * GET /payments/payment-methods/{id}
   */
  getPaymentsPaymentMethodsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/payments/payment-methods/{id}", input ?? {}, [], false, options)
  },

  /**
   * POST /payments/set-default-payment-method/{id}
   */
  postPaymentsSetDefaultPaymentMethodId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/payments/set-default-payment-method/{id}", input ?? {}, [], false, options)
  },

  /**
   * POST /payments/store-transaction/{id}
   */
  postPaymentsStoreTransactionId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/payments/store-transaction/{id}", input ?? {}, [], false, options)
  },

  /**
   * PATCH /payments/update-customer/{id}
   */
  patchPaymentsUpdateCustomerId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "PATCH", "/payments/update-customer/{id}", input ?? {}, [], false, options)
  },

  /**
   * PUT /payments/update-default-payment-method/{id}
   */
  putPaymentsUpdateDefaultPaymentMethodId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "PUT", "/payments/update-default-payment-method/{id}", input ?? {}, [], false, options)
  },

  /**
   * POST /payments/update-subscription/{id}
   */
  postPaymentsUpdateSubscriptionId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/payments/update-subscription/{id}", input ?? {}, [], false, options)
  },

  /**
   * POST /payments/user-default-payment-method/{id}
   */
  postPaymentsUserDefaultPaymentMethodId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/payments/user-default-payment-method/{id}", input ?? {}, [], false, options)
  },

  /**
   * POST /queue/retry-failed
   */
  postQueueRetryFailed(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/queue/retry-failed", {}, [], false, options)
  },

  /**
   * GET /queue/stats
   */
  getQueueStats(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/queue/stats", {}, [], false, options)
  },

  /**
   * GET /queue/workers
   */
  getQueueWorkers(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/queue/workers", {}, [], false, options)
  },

  /**
   * GET /queues/
   */
  getQueues(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/queues/", {}, [], false, options)
  },

  /**
   * GET /realtime/stats
   */
  getRealtimeStats(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/realtime/stats", {}, [], false, options)
  },

  /**
   * GET /realtime/websockets
   */
  getRealtimeWebsockets(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/realtime/websockets", {}, [], false, options)
  },

  /**
   * POST /register
   */
  postRegister(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/register", {}, [], false, options)
  },

  /**
   * GET /releases/
   */
  getReleases2(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/releases/", {}, [], false, options)
  },

  /**
   * GET /releases/stats
   */
  getReleasesStats(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/releases/stats", {}, [], false, options)
  },

  /**
   * GET /robots.txt
   */
  getRobotsTxt(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/robots.txt", {}, [], false, options)
  },

  /**
   * GET /sitemap.xml
   */
  getSitemapXml(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/sitemap.xml", {}, [], false, options)
  },

  /**
   * GET /test-error
   */
  getTestError(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/test-error", {}, [], false, options)
  },

  /**
   * POST /unsubscribe/{token}
   */
  postUnsubscribeToken(input: { "token": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/unsubscribe/{token}", input ?? {}, [], false, options)
  },

  /**
   * GET /verify-authentication
   */
  getVerifyAuthentication(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/verify-authentication", {}, [], false, options)
  },

  /**
   * POST /verify-registration
   */
  postVerifyRegistration(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/verify-registration", {}, [], false, options)
  },

  /**
   * POST /verify-two-factor-login
   */
  postVerifyTwoFactorLogin(input?: { body?: { "challenge_token"?: string; "code"?: string } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/verify-two-factor-login", input ?? {}, [], true, options)
  },

  /**
   * POST /voide/browse
   */
  postVoideBrowse(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/voide/browse", {}, [], false, options)
  },

  /**
   * POST /voide/cancel
   */
  postVoideCancel(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/voide/cancel", {}, [], false, options)
  },

  /**
   * POST /voide/commit
   */
  postVoideCommit(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/voide/commit", {}, [], false, options)
  },

  /**
   * POST /voide/github/connect
   */
  postVoideGithubConnect(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/voide/github/connect", {}, [], false, options)
  },

  /**
   * POST /voide/github/disconnect
   */
  postVoideGithubDisconnect(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/voide/github/disconnect", {}, [], false, options)
  },

  /**
   * POST /voide/process
   */
  postVoideProcess(input: { body: { "command": string } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/voide/process", input ?? {}, [], true, options)
  },

  /**
   * POST /voide/process/stream
   */
  postVoideProcessStream(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/voide/process/stream", {}, [], false, options)
  },

  /**
   * POST /voide/push
   */
  postVoidePush(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/voide/push", {}, [], false, options)
  },

  /**
   * POST /voide/repo
   */
  postVoideRepo(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/voide/repo", {}, [], false, options)
  },

  /**
   * POST /voide/repo/validate
   */
  postVoideRepoValidate(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/voide/repo/validate", {}, [], false, options)
  },

  /**
   * GET /voide/settings
   */
  getVoideSettings(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/voide/settings", {}, [], false, options)
  },

  /**
   * POST /voide/settings
   */
  postVoideSettings(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/voide/settings", {}, [], false, options)
  },

  /**
   * GET /voide/state
   */
  getVoideState(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/voide/state", {}, [], false, options)
  },

  /**
   * POST /voide/title
   */
  postVoideTitle(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/voide/title", {}, [], false, options)
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

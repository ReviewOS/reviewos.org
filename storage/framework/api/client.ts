/* eslint-disable */
/**
 * Stacks API client, generated from OpenAPI.
 * Do not edit; run buddy generate:openapi.
 * No imports or dependencies.
 */


export type ApiResult<T> =
  | { ok: true, status: number, data: T, headers: Headers }
  | { ok: false, status: number, error: unknown, headers: Headers }

export interface ClientConfig {
  baseUrl: string
  token?: string
  headers?: Record<string, string>
  fetch?: typeof fetch
}
export interface RequestOptions {
  signal?: AbortSignal
  headers?: Record<string, string>
  /** Select one of the operation's declared request media types. */
  contentType?: string
}
interface Parameter {
  name: string
  in: string
  required: boolean
  group?: string
  style?: string
  explode?: boolean
}
interface BodyDescription { required: boolean, content: string[] }

function parameterValue(input: Record<string, unknown>, parameter: Parameter): unknown {
  const fields = parameter.group ? input[parameter.group] : input
  if (parameter.in === 'header' && fields && typeof fields === 'object') {
    const entries = Object.entries(fields).filter(([key]) => key.toLowerCase() === parameter.name.toLowerCase())
    return entries.at(-1)?.[1]
  }
  return fields && typeof fields === 'object' && Object.hasOwn(fields, parameter.name)
    ? (fields as Record<string, unknown>)[parameter.name] : undefined
}
function scalar(value: unknown): string {
  if (typeof value === 'object' && value !== null) throw new TypeError('Nested parameter values require an explicit supported serialization')
  return String(value)
}
function queryParameter(url: URL, parameter: Parameter, value: unknown): void {
  const style = parameter.style ?? 'form'
  const explode = parameter.explode ?? style === 'form'
  if (style === 'deepObject') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('deepObject requires an object')
    for (const [key, item] of Object.entries(value)) url.searchParams.append(parameter.name + '[' + key + ']', scalar(item))
  }
  else if (Array.isArray(value)) {
    if (style === 'form' && explode) {
      for (const item of value) url.searchParams.append(parameter.name, scalar(item))
    }
    else url.searchParams.append(parameter.name, value.map(scalar).join(style === 'spaceDelimited' ? ' ' : style === 'pipeDelimited' ? '|' : ','))
  }
  else if (value && typeof value === 'object') {
    if (style !== 'form') throw new TypeError('Object queries require form or deepObject style')
    if (explode) for (const [key, item] of Object.entries(value)) url.searchParams.append(key, scalar(item))
    else url.searchParams.append(parameter.name, Object.entries(value).flatMap(([key, item]) => [key, scalar(item)]).join(','))
  }
  else url.searchParams.append(parameter.name, scalar(value))
}
function simpleParameter(value: unknown, explode: boolean, encode: (value: string) => string): string {
  if (Array.isArray(value)) return value.map(item => encode(scalar(item))).join(',')
  if (value && typeof value === 'object') return Object.entries(value).map(([key, item]) => encode(key) + (explode ? '=' : ',') + encode(scalar(item))).join(',')
  return encode(scalar(value))
}
function buildUrl(config: ClientConfig, route: string, input: Record<string, unknown>, parameters: Parameter[], headers: Headers): string {
  const path = new Map<string, string>()
  for (const parameter of parameters) {
    const value = parameterValue(input, parameter)
    if (value === undefined || value === null) {
      if (parameter.required) throw new TypeError('Missing required ' + parameter.in + ' parameter: ' + parameter.name)
      continue
    }
    if (parameter.in === 'path') {
      const segment = simpleParameter(value, parameter.explode ?? false, encodeURIComponent)
      if (segment === '.' || segment === '..') throw new TypeError('Dot-only path parameters are not allowed')
      path.set(parameter.name, segment)
    }
    else if (parameter.in === 'header') headers.set(parameter.name, simpleParameter(value, parameter.explode ?? false, value => value))
  }
  const filled = route.replace(/\{([^{}]+)\}/g, (_, key: string) => {
    const value = path.get(key)
    if (value === undefined) throw new TypeError('Missing path parameter: ' + key)
    return value
  })
  const url = new URL(filled.replace(/^\/+/, '/'), config.baseUrl.endsWith('/') ? config.baseUrl : config.baseUrl + '/')
  for (const parameter of parameters) {
    const value = parameterValue(input, parameter)
    if (parameter.in === 'query' && value !== undefined && value !== null) queryParameter(url, parameter, value)
  }
  return url.toString()
}
function isJson(type: string): boolean { return type === 'application/json' || type.endsWith('+json') }
function mediaType(type: string): string { return type.split(';')[0]!.trim().toLowerCase() }
function requestBody(value: unknown, description: BodyDescription | null, headers: Headers, options?: RequestOptions): BodyInit | undefined {
  if (!description) return undefined
  if (value === undefined) {
    if (description.required) throw new TypeError('Missing required request body')
    return undefined
  }
  const declared = description.content
  const selected = options?.contentType ?? headers.get('content-type') ?? declared.find(isJson) ?? declared[0]
  if (!selected || !declared.some(type => mediaType(type) === mediaType(selected))) throw new TypeError('Request media type is not declared by this operation')
  const type = mediaType(selected)
  headers.set('content-type', selected)
  if (isJson(type)) return JSON.stringify(value)
  if (type === 'application/x-www-form-urlencoded' || type === 'multipart/form-data') {
    if (type === 'multipart/form-data' && value instanceof FormData) { headers.delete('content-type'); return value }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Form bodies require an object')
    if (type === 'application/x-www-form-urlencoded') {
      const form = new URLSearchParams()
      for (const [name, field] of Object.entries(value)) {
        for (const item of Array.isArray(field) ? field : [field]) if (item != null) form.append(name, scalar(item))
      }
      return form.toString()
    }
    const form = new FormData()
    for (const [name, field] of Object.entries(value)) {
      for (const item of Array.isArray(field) ? field : [field]) {
        if (item == null) continue
        form.append(name, item instanceof Blob ? item : typeof item === 'object' ? JSON.stringify(item) : String(item))
      }
    }
    headers.delete('content-type')
    return form
  }
  if (value instanceof Blob || value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return value as BodyInit
  if (typeof value === 'string') return value
  throw new TypeError('Non-JSON request bodies require text or binary data')
}
async function request<T>(config: ClientConfig, method: string, route: string, input: Record<string, unknown>, parameters: Parameter[], description: BodyDescription | null, accept: string, binary: string[], options?: RequestOptions): Promise<ApiResult<T>> {
  const headers = new Headers({ Accept: accept })
  for (const [name, value] of Object.entries(config.headers ?? {})) headers.set(name, value)
  if (config.token) headers.set('authorization', 'Bearer ' + config.token)
  for (const [name, value] of Object.entries(options?.headers ?? {})) headers.set(name, value)
  const url = buildUrl(config, route, input, parameters, headers)
  const body = requestBody(input.body, description, headers, options)
  const response = await (config.fetch ?? fetch)(url, { method, headers, body, signal: options?.signal })
  const type = mediaType(response.headers.get('content-type') ?? '')
  let parsed: unknown
  if (method === 'HEAD' || response.status === 204 || response.status === 205) parsed = null
  else if (binary.includes(type)) parsed = await response.blob()
  else {
    const text = await response.text()
    // Keep malformed JSON available as evidence, without parsing other media as JSON.
    if (!text.length) parsed = type.startsWith('text/') ? '' : null
    else if (isJson(type)) { try { parsed = JSON.parse(text) } catch { parsed = text } }
    else parsed = text
  }
  return response.ok
    ? { ok: true, status: response.status, data: parsed as T, headers: response.headers }
    : { ok: false, status: response.status, error: parsed, headers: response.headers }
}

export interface components {
  schemas: {
    "Notification": { "id": number; "uuid": string; "type": string; "data": string; "read_at"?: unknown; "created_at"?: string; "updated_at"?: string }
    "NotificationDelivery": { "id": number; "channel": "email" | "sms" | "chat" | "database" | "push" | "broadcast"; "recipient": string; "subject"?: string; "body": string; "status": "pending" | "sent" | "delivered" | "failed" | "skipped"; "error"?: string; "metadata"?: string; "sent_at"?: unknown; "created_at"?: string; "updated_at"?: string }
    "Release": { "id": number; "uuid": string; "version"?: string; "type"?: string; "status"?: string; "notes"?: string; "downloads"?: number; "author"?: string; "repository_id"?: number; "user_id"?: number; "tag_name"?: string; "target_sha"?: string; "name"?: string; "is_prerelease"?: boolean; "published_at"?: string; "external_id": string; "created_at"?: string; "updated_at"?: string }
  }
  requestSchemas: {
    "Notification": { "id": number; "uuid": string; "type": string; "data": string; "read_at"?: unknown; "created_at"?: string; "updated_at"?: string }
    "NotificationDelivery": { "id": number; "channel": "email" | "sms" | "chat" | "database" | "push" | "broadcast"; "recipient": string; "subject"?: string; "body": string; "status": "pending" | "sent" | "delivered" | "failed" | "skipped"; "error"?: string; "metadata"?: string; "sent_at"?: unknown; "created_at"?: string; "updated_at"?: string }
    "Release": { "id": number; "uuid": string; "version"?: string; "type"?: string; "status"?: string; "notes"?: string; "downloads"?: number; "author"?: string; "repository_id"?: number; "user_id"?: number; "tag_name"?: string; "target_sha"?: string; "name"?: string; "is_prerelease"?: boolean; "published_at"?: string; "external_id": string; "created_at"?: string; "updated_at"?: string }
  }
}

export function createClient(config: ClientConfig) {
  return {
    config,
  /**
   * GET /.well-known/jwks.json
   */
  getWellKnownJwksJson(options?: RequestOptions): Promise<ApiResult<{ "keys"?: Array<Record<string, unknown>> }>> {
    return request(config, "GET", "/.well-known/jwks.json", {}, [], null, "application/json", [], options)
  },

  /**
   * GET /.well-known/openid-configuration
   */
  getWellKnownOpenidConfiguration(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/.well-known/openid-configuration", {}, [], null, "application/json", [], options)
  },

  /**
   * GET /.well-known/reviewos-step-keys.json
   */
  getWellKnownReviewosStepKeysJson(options?: RequestOptions): Promise<ApiResult<{ "keys"?: Array<Record<string, unknown>> }>> {
    return request(config, "GET", "/.well-known/reviewos-step-keys.json", {}, [], null, "application/json", [], options)
  },

  /**
   * GET /_pages/*
   */
  getPages(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/_pages/*", {}, [], null, "application/json", [], options)
  },

  /**
   * POST /actions/{host}/{owner}/{repository}/git-upload-pack
   */
  postActionsHostOwnerRepositoryGitUploadPack(input: { "host": string; "owner": string; "repository": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/actions/{host}/{owner}/{repository}/git-upload-pack", input ?? {}, [{"name":"host","in":"path","required":true},{"name":"owner","in":"path","required":true},{"name":"repository","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * GET /actions/{host}/{owner}/{repository}/info/refs
   */
  getActionsHostOwnerRepositoryInfoRefs(input: { "host": string; "owner": string; "repository": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/actions/{host}/{owner}/{repository}/info/refs", input ?? {}, [{"name":"host","in":"path","required":true},{"name":"owner","in":"path","required":true},{"name":"repository","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * GET /api/audit
   */
  getAudit(input?: { "organization_id"?: number; "actor_id"?: number; "owner"?: string; "repo"?: string; "action"?: string; "since"?: string; "until"?: string; "limit"?: number; "before"?: number; "format"?: "json" | "jsonl" }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/audit", input ?? {}, [{"name":"organization_id","in":"query","required":false},{"name":"actor_id","in":"query","required":false},{"name":"owner","in":"query","required":false},{"name":"repo","in":"query","required":false},{"name":"action","in":"query","required":false},{"name":"since","in":"query","required":false},{"name":"until","in":"query","required":false},{"name":"limit","in":"query","required":false},{"name":"before","in":"query","required":false},{"name":"format","in":"query","required":false}], null, "application/json", [], options)
  },

  /**
   * POST /api/auth/atproto
   */
  postAuthAtproto(input: { body: { "identifier": string } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/auth/atproto", input ?? {}, [], {"required":true,"content":["application/json"]}, "application/json", [], options)
  },

  /**
   * GET /api/auth/atproto/callback
   */
  getAuthAtprotoCallback(input?: { "state"?: string; "code"?: string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/auth/atproto/callback", input ?? {}, [{"name":"state","in":"query","required":false},{"name":"code","in":"query","required":false}], null, "application/json", [], options)
  },

  /**
   * POST /api/auth/login
   */
  postAuthLogin(input?: { body?: { "code"?: string; "email"?: string; "next"?: string; "passkey"?: string; "password"?: string } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/auth/login", input ?? {}, [], {"required":false,"content":["application/json"]}, "application/json", [], options)
  },

  /**
   * POST /api/auth/logout
   */
  postAuthLogout(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/auth/logout", {}, [], null, "application/json", [], options)
  },

  /**
   * POST /api/auth/password/reset
   */
  postAuthPasswordReset(input?: { body?: { "email"?: string; "operation"?: string; "password"?: string; "token"?: string } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/auth/password/reset", input ?? {}, [], {"required":false,"content":["application/json"]}, "application/json", [], options)
  },

  /**
   * POST /api/auth/register
   */
  postAuthRegister(input?: { body?: { "email"?: string; "handle"?: string; "name"?: string; "next"?: string; "password"?: string } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/auth/register", input ?? {}, [], {"required":false,"content":["application/json"]}, "application/json", [], options)
  },

  /**
   * GET /api/auth/sso
   */
  getAuthSso(input?: { "code"?: string; "next"?: string; "state"?: string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/auth/sso", input ?? {}, [{"name":"code","in":"query","required":false},{"name":"next","in":"query","required":false},{"name":"state","in":"query","required":false}], null, "application/json", [], options)
  },

  /**
   * GET /api/auth/verify
   */
  getAuthVerify(input?: { "id"?: number; "token"?: string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/auth/verify", input ?? {}, [{"name":"id","in":"query","required":false},{"name":"token","in":"query","required":false}], null, "application/json", [], options)
  },

  /**
   * POST /api/auth/verify/resend
   */
  postAuthVerifyResend(input?: { body?: { "id"?: number; "token"?: string } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/auth/verify/resend", input ?? {}, [], {"required":false,"content":["application/json"]}, "application/json", [], options)
  },

  /**
   * GET /api/auth/{provider}
   */
  getAuthProvider(input: { "provider": string; "next"?: string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/auth/{provider}", input ?? {}, [{"name":"provider","in":"path","required":true},{"name":"next","in":"query","required":false}], null, "application/json", [], options)
  },

  /**
   * GET /api/auth/{provider}/callback
   */
  getAuthProviderCallback(input: { "provider": string; "code"?: string; "state"?: string; "error"?: string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/auth/{provider}/callback", input ?? {}, [{"name":"provider","in":"path","required":true},{"name":"code","in":"query","required":false},{"name":"state","in":"query","required":false},{"name":"error","in":"query","required":false}], null, "application/json", [], options)
  },

  /**
   * POST /api/auth/{provider}/callback
   */
  postAuthProviderCallback(input: { "provider": string; body?: { "code"?: string; "state"?: string; "error"?: string } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/auth/{provider}/callback", input ?? {}, [{"name":"provider","in":"path","required":true}], {"required":false,"content":["application/json"]}, "application/json", [], options)
  },

  /**
   * GET /api/discover
   */
  getDiscover(input?: { "before"?: number }, options?: RequestOptions): Promise<ApiResult<{ "entries"?: Array<Record<string, unknown>>; "cursor"?: number }>> {
    return request(config, "GET", "/api/discover", input ?? {}, [{"name":"before","in":"query","required":false}], null, "application/json", [], options)
  },

  /**
   * GET /api/explore
   */
  getExplore(input?: { "topic"?: string; "language"?: string; "days"?: number }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/explore", input ?? {}, [{"name":"topic","in":"query","required":false},{"name":"language","in":"query","required":false},{"name":"days","in":"query","required":false}], null, "application/json", [], options)
  },

  /**
   * GET /api/featured
   */
  getFeatured(input?: { "limit"?: number }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/featured", input ?? {}, [{"name":"limit","in":"query","required":false}], null, "application/json", [], options)
  },

  /**
   * GET /api/feed
   */
  getFeed(input?: { "before"?: unknown }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/feed", input ?? {}, [{"name":"before","in":"query","required":false}], null, "application/json", [], options)
  },

  /**
   * POST /api/gh/repos/{owner}/{repo}/issues/{number}/comments
   */
  postGhReposOwnerRepoIssuesNumberComments(input: { "owner": string; "repo": string; "number": string; body?: { "owner"?: string; "repo"?: string; "resource"?: string; "sha"?: string; "number"?: number } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown> | null>> {
    return request(config, "POST", "/api/gh/repos/{owner}/{repo}/issues/{number}/comments", input ?? {}, [{"name":"owner","in":"path","required":true},{"name":"repo","in":"path","required":true},{"name":"number","in":"path","required":true}], {"required":false,"content":["application/json"]}, "application/json", [], options)
  },

  /**
   * POST /api/gh/repos/{owner}/{repo}/statuses/{sha}
   */
  postGhReposOwnerRepoStatusesSha(input: { "owner": string; "repo": string; "sha": string; body?: { "owner"?: string; "repo"?: string; "resource"?: string; "sha"?: string; "number"?: number } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown> | null>> {
    return request(config, "POST", "/api/gh/repos/{owner}/{repo}/statuses/{sha}", input ?? {}, [{"name":"owner","in":"path","required":true},{"name":"repo","in":"path","required":true},{"name":"sha","in":"path","required":true}], {"required":false,"content":["application/json"]}, "application/json", [], options)
  },

  /**
   * POST /api/gh/repos/{owner}/{repo}/{resource}
   */
  postGhReposOwnerRepoResource(input: { "owner": string; "repo": string; "resource": string; body?: { "owner"?: string; "repo"?: string; "resource"?: string; "sha"?: string; "number"?: number } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown> | null>> {
    return request(config, "POST", "/api/gh/repos/{owner}/{repo}/{resource}", input ?? {}, [{"name":"owner","in":"path","required":true},{"name":"repo","in":"path","required":true},{"name":"resource","in":"path","required":true}], {"required":false,"content":["application/json"]}, "application/json", [], options)
  },

  /**
   * GET /api/health
   */
  getHealth(input?: { "quick"?: string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/health", input ?? {}, [{"name":"quick","in":"query","required":false}], null, "application/json", [], options)
  },

  /**
   * GET /api/insight
   */
  getInsight(input?: { "owner"?: string; "repo"?: string; "days"?: number }, options?: RequestOptions): Promise<ApiResult<{ "window"?: { "days"?: number; "from"?: string; "to"?: string }; "overall"?: { "workflow"?: string; "path"?: string; "runs"?: number; "success_rate"?: number | null; "p50_ms"?: number | null; "p95_ms"?: number | null; "retry_rate"?: number | null; "samples"?: number }; "workflows"?: Array<{ "workflow"?: string; "path"?: string; "runs"?: number; "success_rate"?: number | null; "p50_ms"?: number | null; "p95_ms"?: number | null; "retry_rate"?: number | null; "samples"?: number }>; "failures_by_job"?: Array<{ "name"?: string; "failures"?: number; "runs"?: number }>; "wait"?: Array<{ "queue"?: string; "pool"?: string; "samples"?: number; "p50_ms"?: number | null; "p95_ms"?: number | null }>; "runners"?: Array<{ "runner"?: string; "busy_ms"?: number; "utilization"?: number; "idle_ms"?: number }>; "cost"?: { "repositories"?: Array<Record<string, unknown>>; "owners"?: Array<Record<string, unknown>>; "queues"?: Array<Record<string, unknown>> }; "flaky"?: { "runs_failed_by_known_flaky"?: number; "failed_runs"?: number; "share"?: number | null } }>> {
    return request(config, "GET", "/api/insight", input ?? {}, [{"name":"owner","in":"query","required":false},{"name":"repo","in":"query","required":false},{"name":"days","in":"query","required":false}], null, "application/json", [], options)
  },

  /**
   * POST /api/instance/admin
   */
  postInstanceAdmin(input?: { body?: { "operation"?: "stats" | "users" | "repositories" | "queue" | "promote" | "demote" | "retry-job" | "deprovision"; "handle"?: string; "search"?: string; "id"?: number; "limit"?: number } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/instance/admin", input ?? {}, [], {"required":false,"content":["application/json"]}, "application/json", [], options)
  },

  /**
   * POST /api/instance/fleet
   */
  postInstanceFleet(input?: { body?: { "operation"?: "list" | "create-pool" | "create-queue" | "pause-queue" | "resume-queue" | "require-signatures" | "attach-plugin" | "detach-plugin" | "plugin-policy" | "assign-repository" | "unassign-repository" | "assign-runner" | "stop-runner" | "create-runner" | "create-token" | "revoke-token" | "add-maintainer" | "remove-maintainer" | "set-secret" | "unset-secret" | "list-secrets"; "name"?: string; "slug"?: string; "labels"?: string; "reason"?: string; "pool"?: number; "queue"?: number; "runner"?: number; "repository"?: number; "force"?: boolean; "required"?: boolean; "plugin"?: string; "allowlist"?: string; "capabilities"?: string; "pinned"?: boolean; "token"?: number; "expires"?: string; "user"?: number; "key"?: string; "value"?: string } }, options?: RequestOptions): Promise<ApiResult<null>> {
    return request(config, "POST", "/api/instance/fleet", input ?? {}, [], {"required":false,"content":["application/json"]}, "application/json", [], options)
  },

  /**
   * POST /api/instance/settings
   */
  postInstanceSettings(input?: { body?: { "key"?: string; "value"?: string } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/instance/settings", input ?? {}, [], {"required":false,"content":["application/json"]}, "application/json", [], options)
  },

  /**
   * POST /api/mcp
   */
  postMcp(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/mcp", {}, [], null, "application/json", [], options)
  },

  /**
   * GET /api/metrics
   */
  getMetrics(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/metrics", {}, [], null, "application/json", [], options)
  },

  /**
   * POST /api/mirrors/sync
   */
  postMirrorsSync(input?: { body?: { "owner"?: string; "repo"?: string } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/mirrors/sync", input ?? {}, [], {"required":false,"content":["application/json"]}, "application/json", [], options)
  },

  /**
   * POST /api/mirrors/webhook
   */
  postMirrorsWebhook(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/mirrors/webhook", {}, [], null, "application/json", [], options)
  },

  /**
   * GET /api/notification-deliveries
   */
  getNotificationDeliveries(options?: RequestOptions): Promise<ApiResult<{ "data": Array<{ "id": number; "channel": "email" | "sms" | "chat" | "database" | "push" | "broadcast"; "recipient": string; "subject"?: string; "body": string; "status": "pending" | "sent" | "delivered" | "failed" | "skipped"; "error"?: string; "metadata"?: string; "sent_at"?: unknown; "created_at"?: string; "updated_at"?: string }> }>> {
    return request(config, "GET", "/api/notification-deliveries", {}, [], null, "application/json", [], options)
  },

  /**
   * GET /api/notification-deliveries/{id}
   */
  getNotificationDeliveriesId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "channel": "email" | "sms" | "chat" | "database" | "push" | "broadcast"; "recipient": string; "subject"?: string; "body": string; "status": "pending" | "sent" | "delivered" | "failed" | "skipped"; "error"?: string; "metadata"?: string; "sent_at"?: unknown; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "GET", "/api/notification-deliveries/{id}", input ?? {}, [{"name":"id","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * GET /api/notifications
   */
  getNotifications(options?: RequestOptions): Promise<ApiResult<{ "data": Array<{ "id": number; "uuid": string; "type": string; "data": string; "read_at"?: unknown; "created_at"?: string; "updated_at"?: string }> }>> {
    return request(config, "GET", "/api/notifications", {}, [], null, "application/json", [], options)
  },

  /**
   * GET /api/notifications/{id}
   */
  getNotificationsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "type": string; "data": string; "read_at"?: unknown; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "GET", "/api/notifications/{id}", input ?? {}, [{"name":"id","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * GET /api/og
   */
  getOg(input?: { "path"?: string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/og", input ?? {}, [{"name":"path","in":"query","required":false}], null, "application/json", [], options)
  },

  /**
   * GET /api/openapi.json
   */
  getOpenapiJson(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/openapi.json", {}, [], null, "application/json", [], options)
  },

  /**
   * GET /api/operations/{id}
   */
  getOperationsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/operations/{id}", input ?? {}, [{"name":"id","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * POST /api/operations/{id}/cancel
   */
  postOperationsIdCancel(input: { "id": string; body?: { "id"?: unknown } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/operations/{id}/cancel", input ?? {}, [{"name":"id","in":"path","required":true}], {"required":false,"content":["application/json"]}, "application/json", [], options)
  },

  /**
   * PUT /api/orgs
   */
  putOrgs(input?: { body?: { "handle"?: string; "organization_id"?: unknown } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "PUT", "/api/orgs", input ?? {}, [], {"required":false,"content":["application/json"]}, "application/json", [], options)
  },

  /**
   * POST /api/orgs
   */
  postOrgs(input?: { body?: { "billing_email"?: string; "description"?: string; "handle"?: string; "name"?: string } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/orgs", input ?? {}, [], {"required":false,"content":["application/json"]}, "application/json", [], options)
  },

  /**
   * DELETE /api/orgs
   */
  deleteOrgs(input?: { "confirm"?: string; "organization_id"?: unknown }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "DELETE", "/api/orgs", input ?? {}, [{"name":"confirm","in":"query","required":false},{"name":"organization_id","in":"query","required":false}], null, "application/json", [], options)
  },

  /**
   * POST /api/orgs/delete
   */
  postOrgsDelete(input?: { body?: { "confirm"?: string; "organization_id"?: unknown } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/orgs/delete", input ?? {}, [], {"required":false,"content":["application/json"]}, "application/json", [], options)
  },

  /**
   * POST /api/orgs/machine-accounts
   */
  postOrgsMachineAccounts(input?: { body?: { "handle"?: string; "name"?: string; "organization_id"?: unknown } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/orgs/machine-accounts", input ?? {}, [], {"required":false,"content":["application/json"]}, "application/json", [], options)
  },

  /**
   * POST /api/orgs/members
   */
  postOrgsMembers(input?: { body?: { "handle"?: string; "organization_id"?: unknown; "role"?: string } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/orgs/members", input ?? {}, [], {"required":false,"content":["application/json"]}, "application/json", [], options)
  },

  /**
   * DELETE /api/orgs/members
   */
  deleteOrgsMembers(input?: { "organization_id"?: unknown; "user_id"?: number }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "DELETE", "/api/orgs/members", input ?? {}, [{"name":"organization_id","in":"query","required":false},{"name":"user_id","in":"query","required":false}], null, "application/json", [], options)
  },

  /**
   * POST /api/orgs/members/accept
   */
  postOrgsMembersAccept(input?: { body?: { "operation"?: string; "organization_id"?: unknown } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/orgs/members/accept", input ?? {}, [], {"required":false,"content":["application/json"]}, "application/json", [], options)
  },

  /**
   * POST /api/orgs/members/remove
   */
  postOrgsMembersRemove(input?: { body?: { "organization_id"?: unknown; "user_id"?: number } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/orgs/members/remove", input ?? {}, [], {"required":false,"content":["application/json"]}, "application/json", [], options)
  },

  /**
   * PUT /api/orgs/members/role
   */
  putOrgsMembersRole(input?: { body?: { "organization_id"?: unknown; "role"?: string; "user_id"?: number } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "PUT", "/api/orgs/members/role", input ?? {}, [], {"required":false,"content":["application/json"]}, "application/json", [], options)
  },

  /**
   * POST /api/orgs/members/role
   */
  postOrgsMembersRole(input?: { body?: { "organization_id"?: unknown; "role"?: string; "user_id"?: number } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/orgs/members/role", input ?? {}, [], {"required":false,"content":["application/json"]}, "application/json", [], options)
  },

  /**
   * POST /api/orgs/members/visibility
   */
  postOrgsMembersVisibility(input: { body: { "organization_id"?: unknown; "visibility": "public" | "private" } }, options?: RequestOptions): Promise<ApiResult<null>> {
    return request(config, "POST", "/api/orgs/members/visibility", input ?? {}, [], {"required":true,"content":["application/json"]}, "application/json", [], options)
  },

  /**
   * POST /api/orgs/teams
   */
  postOrgsTeams(input?: { body?: { "description"?: string; "name"?: string; "operation"?: string; "organization_id"?: unknown; "parent_team_id"?: unknown; "slug"?: string; "team_id"?: unknown } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/orgs/teams", input ?? {}, [], {"required":false,"content":["application/json"]}, "application/json", [], options)
  },

  /**
   * POST /api/orgs/teams/members
   */
  postOrgsTeamsMembers(input?: { body?: { "operation"?: string; "role"?: string; "team_id"?: unknown; "user_id"?: number } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/orgs/teams/members", input ?? {}, [], {"required":false,"content":["application/json"]}, "application/json", [], options)
  },

  /**
   * GET /api/orgs/tokens
   */
  getOrgsTokens(input?: { "organization_id"?: unknown }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/orgs/tokens", input ?? {}, [{"name":"organization_id","in":"query","required":false}], null, "application/json", [], options)
  },

  /**
   * POST /api/orgs/update
   */
  postOrgsUpdate(input?: { body?: { "handle"?: string; "organization_id"?: unknown } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/orgs/update", input ?? {}, [], {"required":false,"content":["application/json"]}, "application/json", [], options)
  },

  /**
   * GET /api/owners
   */
  getOwners(input: { "owner": string; "q"?: string; "page"?: number; "per_page"?: number }, options?: RequestOptions): Promise<ApiResult<null>> {
    return request(config, "GET", "/api/owners", input ?? {}, [{"name":"owner","in":"query","required":true},{"name":"q","in":"query","required":false},{"name":"page","in":"query","required":false},{"name":"per_page","in":"query","required":false}], null, "application/json", [], options)
  },

  /**
   * GET /api/releases
   */
  getReleases(options?: RequestOptions): Promise<ApiResult<{ "data": Array<{ "id": number; "uuid": string; "version"?: string; "type"?: string; "status"?: string; "notes"?: string; "downloads"?: number; "author"?: string; "repository_id"?: number; "user_id"?: number; "tag_name"?: string; "target_sha"?: string; "name"?: string; "is_prerelease"?: boolean; "published_at"?: string; "external_id": string; "created_at"?: string; "updated_at"?: string }> }>> {
    return request(config, "GET", "/api/releases", {}, [], null, "application/json", [], options)
  },

  /**
   * GET /api/releases/{id}
   */
  getReleasesId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<{ "data": { "id": number; "uuid": string; "version"?: string; "type"?: string; "status"?: string; "notes"?: string; "downloads"?: number; "author"?: string; "repository_id"?: number; "user_id"?: number; "tag_name"?: string; "target_sha"?: string; "name"?: string; "is_prerelease"?: boolean; "published_at"?: string; "external_id": string; "created_at"?: string; "updated_at"?: string } }>> {
    return request(config, "GET", "/api/releases/{id}", input ?? {}, [{"name":"id","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * PUT /api/repos
   */
  putRepos(input?: { body?: { "owner"?: string; "repo"?: string; "allow_merge_commit"?: unknown; "allow_rebase_merge"?: unknown; "allow_squash_merge"?: unknown; "default_branch"?: string; "default_merge_strategy"?: string; "delete_branch_on_merge"?: unknown; "description"?: string; "homepage"?: string; "is_archived"?: unknown; "is_template"?: unknown; "name"?: string; "visibility"?: string } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "PUT", "/api/repos", input ?? {}, [], {"required":false,"content":["application/json"]}, "application/json", [], options)
  },

  /**
   * POST /api/repos
   */
  postRepos(input?: { body?: { "owner"?: string; "default_branch"?: string; "description"?: string; "gitignore"?: string; "host"?: string; "license"?: string; "license_holder"?: string; "name"?: string; "readme"?: unknown; "visibility"?: string } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/repos", input ?? {}, [], {"required":false,"content":["application/json"]}, "application/json", [], options)
  },

  /**
   * DELETE /api/repos
   */
  deleteRepos(input: { "owner": string; "repo"?: string; "repository"?: string; "confirm"?: string }, options?: RequestOptions): Promise<ApiResult<null>> {
    return request(config, "DELETE", "/api/repos", input ?? {}, [{"name":"owner","in":"query","required":true},{"name":"repo","in":"query","required":false},{"name":"repository","in":"query","required":false},{"name":"confirm","in":"query","required":false}], null, "application/json", [], options)
  },

  /**
   * GET /api/repos/archive
   */
  getReposArchive(input?: { "owner"?: string; "repo"?: string; "format"?: string; "ref"?: string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/repos/archive", input ?? {}, [{"name":"owner","in":"query","required":false},{"name":"repo","in":"query","required":false},{"name":"format","in":"query","required":false},{"name":"ref","in":"query","required":false}], null, "application/json", [], options)
  },

  /**
   * POST /api/repos/attachments
   */
  postReposAttachments(input?: { body?: { "owner"?: string; "repo"?: string } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/repos/attachments", input ?? {}, [], {"required":false,"content":["application/json"]}, "application/json", [], options)
  },

  /**
   * GET /api/repos/badge
   */
  getReposBadge(input?: { "owner"?: string; "repo"?: string; "workflow"?: string; "branch"?: string; "label"?: string }, options?: RequestOptions): Promise<ApiResult<null>> {
    return request(config, "GET", "/api/repos/badge", input ?? {}, [{"name":"owner","in":"query","required":false},{"name":"repo","in":"query","required":false},{"name":"workflow","in":"query","required":false},{"name":"branch","in":"query","required":false},{"name":"label","in":"query","required":false}], null, "application/json", [], options)
  },

  /**
   * GET /api/repos/blame
   */
  getReposBlame(input?: { "owner"?: string; "repo"?: string; "limit"?: number; "path"?: string; "ref"?: string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/repos/blame", input ?? {}, [{"name":"owner","in":"query","required":false},{"name":"repo","in":"query","required":false},{"name":"limit","in":"query","required":false},{"name":"path","in":"query","required":false},{"name":"ref","in":"query","required":false}], null, "application/json", [], options)
  },

  /**
   * GET /api/repos/blob
   */
  getReposBlob(input?: { "owner"?: string; "repo"?: string; "path"?: string; "ref"?: string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/repos/blob", input ?? {}, [{"name":"owner","in":"query","required":false},{"name":"repo","in":"query","required":false},{"name":"path","in":"query","required":false},{"name":"ref","in":"query","required":false}], null, "application/json", [], options)
  },

  /**
   * GET /api/repos/blob/rows
   */
  getReposBlobRows(input?: { "owner"?: string; "repo"?: string; "count"?: number; "from"?: unknown; "path"?: string; "ref"?: string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/repos/blob/rows", input ?? {}, [{"name":"owner","in":"query","required":false},{"name":"repo","in":"query","required":false},{"name":"count","in":"query","required":false},{"name":"from","in":"query","required":false},{"name":"path","in":"query","required":false},{"name":"ref","in":"query","required":false}], null, "application/json", [], options)
  },

  /**
   * GET /api/repos/branches
   */
  getReposBranches(input?: { "owner"?: string; "repo"?: string; "ref"?: string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/repos/branches", input ?? {}, [{"name":"owner","in":"query","required":false},{"name":"repo","in":"query","required":false},{"name":"ref","in":"query","required":false}], null, "application/json", [], options)
  },

  /**
   * GET /api/repos/checks
   */
  getReposChecks(input: { "owner": string; "repository"?: string; "sha"?: string; "number"?: number }, options?: RequestOptions): Promise<ApiResult<{ "sha"?: string; "state"?: "success" | "failure" | "pending" | "neutral"; "counts"?: Record<string, unknown>; "statuses"?: Array<Record<string, unknown>>; "check_runs"?: Array<Record<string, unknown>> }>> {
    return request(config, "GET", "/api/repos/checks", input ?? {}, [{"name":"owner","in":"query","required":true},{"name":"repository","in":"query","required":false},{"name":"sha","in":"query","required":false},{"name":"number","in":"query","required":false}], null, "application/json", [], options)
  },

  /**
   * POST /api/repos/checks
   */
  postReposChecks(input: { body: { "owner": string; "repository"?: string; "sha": string; "kind"?: "status" | "check_run" } }, options?: RequestOptions): Promise<ApiResult<{ "id"?: number; "name"?: string; "status"?: "queued" | "in_progress" | "completed"; "conclusion"?: string | null; "ignored"?: string } | { "id"?: number; "name"?: string; "context"?: string; "status"?: string; "state"?: string; "conclusion"?: string | null }>> {
    return request(config, "POST", "/api/repos/checks", input ?? {}, [], {"required":true,"content":["application/json"]}, "application/json", [], options)
  },

  /**
   * POST /api/repos/collaborators
   */
  postReposCollaborators(input?: { body?: { "owner"?: string; "repo"?: string; "handle"?: string; "operation"?: string; "permission"?: string } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/repos/collaborators", input ?? {}, [], {"required":false,"content":["application/json"]}, "application/json", [], options)
  },

  /**
   * GET /api/repos/commit
   */
  getReposCommit(input?: { "owner"?: string; "repo"?: string; "ref"?: string; "sha"?: string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/repos/commit", input ?? {}, [{"name":"owner","in":"query","required":false},{"name":"repo","in":"query","required":false},{"name":"ref","in":"query","required":false},{"name":"sha","in":"query","required":false}], null, "application/json", [], options)
  },

  /**
   * GET /api/repos/commits
   */
  getReposCommits(input?: { "owner"?: string; "repo"?: string; "before"?: string; "limit"?: number; "path"?: string; "ref"?: string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/repos/commits", input ?? {}, [{"name":"owner","in":"query","required":false},{"name":"repo","in":"query","required":false},{"name":"before","in":"query","required":false},{"name":"limit","in":"query","required":false},{"name":"path","in":"query","required":false},{"name":"ref","in":"query","required":false}], null, "application/json", [], options)
  },

  /**
   * GET /api/repos/compare
   */
  getReposCompare(input?: { "owner"?: string; "repo"?: string; "base"?: string; "head"?: string; "ref"?: string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/repos/compare", input ?? {}, [{"name":"owner","in":"query","required":false},{"name":"repo","in":"query","required":false},{"name":"base","in":"query","required":false},{"name":"head","in":"query","required":false},{"name":"ref","in":"query","required":false}], null, "application/json", [], options)
  },

  /**
   * POST /api/repos/coverage
   */
  postReposCoverage(input: { body: { "owner": string; "repo"?: string; "repository"?: string; "sha": string; "lcov"?: string } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown> | null>> {
    return request(config, "POST", "/api/repos/coverage", input ?? {}, [], {"required":true,"content":["application/json"]}, "application/json", [], options)
  },

  /**
   * POST /api/repos/delete
   */
  postReposDelete(input: { body: { "owner": string; "repo"?: string; "repository"?: string; "confirm"?: string } }, options?: RequestOptions): Promise<ApiResult<null>> {
    return request(config, "POST", "/api/repos/delete", input ?? {}, [], {"required":true,"content":["application/json"]}, "application/json", [], options)
  },

  /**
   * POST /api/repos/deploy-keys
   */
  postReposDeployKeys(input?: { body?: { "owner"?: string; "repo"?: string; "can_write"?: string; "id"?: number; "key"?: string; "operation"?: string; "title"?: string } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/repos/deploy-keys", input ?? {}, [], {"required":false,"content":["application/json"]}, "application/json", [], options)
  },

  /**
   * POST /api/repos/deployments
   */
  postReposDeployments(input?: { body?: { "owner"?: string; "repo"?: string; "operation"?: "list" | "create" | "update" | "deactivate" | "rollback" | "history" | "health" | "hold" | "resume"; "environment"?: string; "sha"?: string; "ref"?: string; "url"?: string; "state"?: "in_progress" | "active" | "failed" | "inactive"; "description"?: string; "stages"?: string; "health"?: string; "pull_request"?: number; "run"?: number; "reason"?: string; "id"?: number; "limit"?: number } }, options?: RequestOptions): Promise<ApiResult<null>> {
    return request(config, "POST", "/api/repos/deployments", input ?? {}, [], {"required":false,"content":["application/json"]}, "application/json", [], options)
  },

  /**
   * POST /api/repos/dispatches
   */
  postReposDispatches(input?: { body?: { "owner"?: string; "repo"?: string; "event_type"?: string } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown> | { "event_type"?: string; "created"?: Array<number>; "note"?: string }>> {
    return request(config, "POST", "/api/repos/dispatches", input ?? {}, [], {"required":false,"content":["application/json"]}, "application/json", [], options)
  },

  /**
   * POST /api/repos/environments
   */
  postReposEnvironments(input?: { body?: { "owner"?: string; "repo"?: string; "operation"?: "list" | "create" | "update" | "delete" | "add-reviewer" | "remove-reviewer"; "name"?: string; "wait_minutes"?: number; "require_checks"?: boolean; "branches"?: string; "description"?: string; "reviewer"?: string } }, options?: RequestOptions): Promise<ApiResult<null>> {
    return request(config, "POST", "/api/repos/environments", input ?? {}, [], {"required":false,"content":["application/json"]}, "application/json", [], options)
  },

  /**
   * POST /api/repos/forks
   */
  postReposForks(input: { body: { "owner": string; "repo"?: string; "repository"?: string; "to"?: string } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown> | null>> {
    return request(config, "POST", "/api/repos/forks", input ?? {}, [], {"required":true,"content":["application/json"]}, "application/json", [], options)
  },

  /**
   * GET /api/repos/issues
   */
  getReposIssues(input: { "owner": string; "repo"?: string; "repository"?: string; "state"?: "open" | "closed" | "all"; "sort"?: "created" | "updated" | "comments"; "direction"?: "asc" | "desc"; "labels"?: string; "label"?: string; "assignee"?: string; "author"?: string; "milestone"?: string; "q"?: string; "search"?: string; "limit"?: number; "cursor"?: string }, options?: RequestOptions): Promise<ApiResult<null>> {
    return request(config, "GET", "/api/repos/issues", input ?? {}, [{"name":"owner","in":"query","required":true},{"name":"repo","in":"query","required":false},{"name":"repository","in":"query","required":false},{"name":"state","in":"query","required":false},{"name":"sort","in":"query","required":false},{"name":"direction","in":"query","required":false},{"name":"labels","in":"query","required":false},{"name":"label","in":"query","required":false},{"name":"assignee","in":"query","required":false},{"name":"author","in":"query","required":false},{"name":"milestone","in":"query","required":false},{"name":"q","in":"query","required":false},{"name":"search","in":"query","required":false},{"name":"limit","in":"query","required":false},{"name":"cursor","in":"query","required":false}], null, "application/json", [], options)
  },

  /**
   * PUT /api/repos/issues
   */
  putReposIssues(input?: { body?: { "owner"?: string; "repo"?: string; "number"?: number; "body"?: string; "title"?: string } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "PUT", "/api/repos/issues", input ?? {}, [], {"required":false,"content":["application/json"]}, "application/json", [], options)
  },

  /**
   * POST /api/repos/issues
   */
  postReposIssues(input: { body: { "owner": string; "repo"?: string; "repository"?: string; "title": string; "body"?: string; "labels"?: Array<unknown>; "milestone_id"?: number } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown> | null>> {
    return request(config, "POST", "/api/repos/issues", input ?? {}, [], {"required":true,"content":["application/json"]}, "application/json", [], options)
  },

  /**
   * PUT /api/repos/issues/assignees
   */
  putReposIssuesAssignees(input: { body: { "owner": string; "repo"?: string; "repository"?: string; "number": number; "assignees"?: Array<unknown> } }, options?: RequestOptions): Promise<ApiResult<null>> {
    return request(config, "PUT", "/api/repos/issues/assignees", input ?? {}, [], {"required":true,"content":["application/json"]}, "application/json", [], options)
  },

  /**
   * POST /api/repos/issues/bulk
   */
  postReposIssuesBulk(input?: { body?: { "owner"?: string; "repo"?: string; "label"?: string; "milestone_id"?: number; "numbers"?: string; "operation"?: string } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/repos/issues/bulk", input ?? {}, [], {"required":false,"content":["application/json"]}, "application/json", [], options)
  },

  /**
   * PUT /api/repos/issues/comments
   */
  putReposIssuesComments(input?: { body?: { "owner"?: string; "repo"?: string; "body"?: string; "comment_id"?: unknown } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "PUT", "/api/repos/issues/comments", input ?? {}, [], {"required":false,"content":["application/json"]}, "application/json", [], options)
  },

  /**
   * POST /api/repos/issues/comments
   */
  postReposIssuesComments(input: { body: { "owner": string; "repo"?: string; "repository"?: string; "number": number; "body": string } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown> | null>> {
    return request(config, "POST", "/api/repos/issues/comments", input ?? {}, [], {"required":true,"content":["application/json"]}, "application/json", [], options)
  },

  /**
   * DELETE /api/repos/issues/comments
   */
  deleteReposIssuesComments(input?: { "owner"?: string; "repo"?: string; "comment_id"?: unknown }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "DELETE", "/api/repos/issues/comments", input ?? {}, [{"name":"owner","in":"query","required":false},{"name":"repo","in":"query","required":false},{"name":"comment_id","in":"query","required":false}], null, "application/json", [], options)
  },

  /**
   * PUT /api/repos/issues/labels
   */
  putReposIssuesLabels(input: { body: { "owner": string; "repo"?: string; "repository"?: string; "number": number; "labels"?: Array<unknown> } }, options?: RequestOptions): Promise<ApiResult<null>> {
    return request(config, "PUT", "/api/repos/issues/labels", input ?? {}, [], {"required":true,"content":["application/json"]}, "application/json", [], options)
  },

  /**
   * PUT /api/repos/issues/lock
   */
  putReposIssuesLock(input: { body: { "owner": string; "repo"?: string; "repository"?: string; "number": number; "locked"?: boolean } }, options?: RequestOptions): Promise<ApiResult<null>> {
    return request(config, "PUT", "/api/repos/issues/lock", input ?? {}, [], {"required":true,"content":["application/json"]}, "application/json", [], options)
  },

  /**
   * PUT /api/repos/issues/milestone
   */
  putReposIssuesMilestone(input?: { body?: { "owner"?: string; "repo"?: string; "number"?: number; "milestone"?: string } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "PUT", "/api/repos/issues/milestone", input ?? {}, [], {"required":false,"content":["application/json"]}, "application/json", [], options)
  },

  /**
   * POST /api/repos/issues/reactions
   */
  postReposIssuesReactions(input?: { body?: { "owner"?: string; "repo"?: string; "number"?: number; "comment_id"?: unknown; "content"?: string } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/repos/issues/reactions", input ?? {}, [], {"required":false,"content":["application/json"]}, "application/json", [], options)
  },

  /**
   * PUT /api/repos/issues/state
   */
  putReposIssuesState(input?: { body?: { "owner"?: string; "repo"?: string; "number"?: number; "reason"?: string; "state"?: string } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "PUT", "/api/repos/issues/state", input ?? {}, [], {"required":false,"content":["application/json"]}, "application/json", [], options)
  },

  /**
   * PUT /api/repos/issues/tasks
   */
  putReposIssuesTasks(input?: { body?: { "owner"?: string; "repo"?: string; "number"?: number; "checked"?: string; "comment_id"?: unknown; "expected"?: string; "index"?: unknown } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "PUT", "/api/repos/issues/tasks", input ?? {}, [], {"required":false,"content":["application/json"]}, "application/json", [], options)
  },

  /**
   * POST /api/repos/labels
   */
  postReposLabels(input?: { body?: { "owner"?: string; "repo"?: string; "color"?: string; "description"?: string; "id"?: number; "name"?: string; "operation"?: string } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/repos/labels", input ?? {}, [], {"required":false,"content":["application/json"]}, "application/json", [], options)
  },

  /**
   * GET /api/repos/media
   */
  getReposMedia(input: { "owner": string; "repo"?: string; "repository"?: string; "ref"?: string; "path": string }, options?: RequestOptions): Promise<ApiResult<null>> {
    return request(config, "GET", "/api/repos/media", input ?? {}, [{"name":"owner","in":"query","required":true},{"name":"repo","in":"query","required":false},{"name":"repository","in":"query","required":false},{"name":"ref","in":"query","required":false},{"name":"path","in":"query","required":true}], null, "application/json", [], options)
  },

  /**
   * POST /api/repos/milestones
   */
  postReposMilestones(input?: { body?: { "owner"?: string; "repo"?: string; "description"?: string; "due_on"?: string; "id"?: number; "operation"?: string; "title"?: string } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/repos/milestones", input ?? {}, [], {"required":false,"content":["application/json"]}, "application/json", [], options)
  },

  /**
   * POST /api/repos/pages
   */
  postReposPages(input?: { body?: { "owner"?: string; "repo"?: string; "operation"?: "show" | "update"; "enabled"?: boolean; "source_branch"?: string; "domain"?: string; "visibility"?: "public" | "repository" } }, options?: RequestOptions): Promise<ApiResult<null>> {
    return request(config, "POST", "/api/repos/pages", input ?? {}, [], {"required":false,"content":["application/json"]}, "application/json", [], options)
  },

  /**
   * POST /api/repos/protected-branches
   */
  postReposProtectedBranches(input?: { body?: { "owner"?: string; "repo"?: string; "operation"?: string; "pattern"?: string; "allow_deletion"?: unknown; "allow_force_push"?: unknown; "dismiss_stale_reviews"?: unknown; "require_conversation_resolution"?: unknown; "require_human_approval_for_agents"?: unknown; "require_linear_history"?: unknown; "required_approvals"?: unknown; "required_checks"?: unknown; "require_up_to_date"?: unknown; "enforce_admins"?: unknown; "push_restrictions"?: unknown; "push_restrictions_users"?: unknown; "push_restrictions_teams"?: unknown } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/repos/protected-branches", input ?? {}, [], {"required":false,"content":["application/json"]}, "application/json", [], options)
  },

  /**
   * GET /api/repos/pulls
   */
  getReposPulls(input?: { "owner"?: string; "repo"?: string; "state"?: "open" | "closed" | "merged" | "all"; "author"?: string; "base"?: string; "per_page"?: number; "cursor"?: string; "fields"?: string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/repos/pulls", input ?? {}, [{"name":"owner","in":"query","required":false},{"name":"repo","in":"query","required":false},{"name":"state","in":"query","required":false},{"name":"author","in":"query","required":false},{"name":"base","in":"query","required":false},{"name":"per_page","in":"query","required":false},{"name":"cursor","in":"query","required":false},{"name":"fields","in":"query","required":false}], null, "application/json", [], options)
  },

  /**
   * PUT /api/repos/pulls
   */
  putReposPulls(input?: { body?: { "owner"?: string; "repo"?: string; "number"?: number } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "PUT", "/api/repos/pulls", input ?? {}, [], {"required":false,"content":["application/json"]}, "application/json", [], options)
  },

  /**
   * POST /api/repos/pulls
   */
  postReposPulls(input: { body: { "owner": string; "repo"?: string; "repository"?: string; "title": string; "head": string; "base"?: string; "body"?: string; "draft"?: boolean } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown> | null>> {
    return request(config, "POST", "/api/repos/pulls", input ?? {}, [], {"required":true,"content":["application/json"]}, "application/json", [], options)
  },

  /**
   * POST /api/repos/pulls/auto-merge
   */
  postReposPullsAutoMerge(input?: { body?: { "owner"?: string; "repo"?: string; "number"?: number; "strategy"?: string } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/repos/pulls/auto-merge", input ?? {}, [], {"required":false,"content":["application/json"]}, "application/json", [], options)
  },

  /**
   * POST /api/repos/pulls/auto-merge/disarm
   */
  postReposPullsAutoMergeDisarm(input?: { body?: { "owner"?: string; "repo"?: string; "number"?: number } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/repos/pulls/auto-merge/disarm", input ?? {}, [], {"required":false,"content":["application/json"]}, "application/json", [], options)
  },

  /**
   * POST /api/repos/pulls/comments
   */
  postReposPullsComments(input?: { body?: { "owner"?: string; "repo"?: string; "number"?: number; "path"?: string; "line"?: number; "side"?: "left" | "right"; "start_line"?: number; "body"?: string; "thread_id"?: number } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/repos/pulls/comments", input ?? {}, [], {"required":false,"content":["application/json"]}, "application/json", [], options)
  },

  /**
   * GET /api/repos/pulls/diff/blame
   */
  getReposPullsDiffBlame(input?: { "owner"?: string; "repo"?: string; "number"?: number; "line"?: number; "path"?: string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/repos/pulls/diff/blame", input ?? {}, [{"name":"owner","in":"query","required":false},{"name":"repo","in":"query","required":false},{"name":"number","in":"query","required":false},{"name":"line","in":"query","required":false},{"name":"path","in":"query","required":false}], null, "application/json", [], options)
  },

  /**
   * GET /api/repos/pulls/diff/conflicts
   */
  getReposPullsDiffConflicts(input?: { "owner"?: string; "repo"?: string; "number"?: number }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/repos/pulls/diff/conflicts", input ?? {}, [{"name":"owner","in":"query","required":false},{"name":"repo","in":"query","required":false},{"name":"number","in":"query","required":false}], null, "application/json", [], options)
  },

  /**
   * GET /api/repos/pulls/diff/context
   */
  getReposPullsDiffContext(input?: { "owner"?: string; "repo"?: string; "number"?: number; "from"?: unknown; "layout"?: string; "offset"?: unknown; "path"?: string; "to"?: unknown }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/repos/pulls/diff/context", input ?? {}, [{"name":"owner","in":"query","required":false},{"name":"repo","in":"query","required":false},{"name":"number","in":"query","required":false},{"name":"from","in":"query","required":false},{"name":"layout","in":"query","required":false},{"name":"offset","in":"query","required":false},{"name":"path","in":"query","required":false},{"name":"to","in":"query","required":false}], null, "application/json", [], options)
  },

  /**
   * GET /api/repos/pulls/diff/interdiff
   */
  getReposPullsDiffInterdiff(input?: { "owner"?: string; "repo"?: string; "number"?: number; "path"?: string; "since"?: string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/repos/pulls/diff/interdiff", input ?? {}, [{"name":"owner","in":"query","required":false},{"name":"repo","in":"query","required":false},{"name":"number","in":"query","required":false},{"name":"path","in":"query","required":false},{"name":"since","in":"query","required":false}], null, "application/json", [], options)
  },

  /**
   * GET /api/repos/pulls/diff/manifest
   */
  getReposPullsDiffManifest(input?: { "owner"?: string; "repo"?: string; "number"?: number; "highlight"?: string; "layout"?: string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/repos/pulls/diff/manifest", input ?? {}, [{"name":"owner","in":"query","required":false},{"name":"repo","in":"query","required":false},{"name":"number","in":"query","required":false},{"name":"highlight","in":"query","required":false},{"name":"layout","in":"query","required":false}], null, "application/json", [], options)
  },

  /**
   * GET /api/repos/pulls/diff/rows
   */
  getReposPullsDiffRows(input?: { "owner"?: string; "repo"?: string; "number"?: number; "from"?: string; "highlight"?: string; "layout"?: string; "open"?: string; "to"?: unknown }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/repos/pulls/diff/rows", input ?? {}, [{"name":"owner","in":"query","required":false},{"name":"repo","in":"query","required":false},{"name":"number","in":"query","required":false},{"name":"from","in":"query","required":false},{"name":"highlight","in":"query","required":false},{"name":"layout","in":"query","required":false},{"name":"open","in":"query","required":false},{"name":"to","in":"query","required":false}], null, "application/json", [], options)
  },

  /**
   * GET /api/repos/pulls/diff/structured
   */
  getReposPullsDiffStructured(input?: { "owner"?: string; "repo"?: string; "number"?: number; "path"?: string; "per_page"?: number; "offset"?: number }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/repos/pulls/diff/structured", input ?? {}, [{"name":"owner","in":"query","required":false},{"name":"repo","in":"query","required":false},{"name":"number","in":"query","required":false},{"name":"path","in":"query","required":false},{"name":"per_page","in":"query","required":false},{"name":"offset","in":"query","required":false}], null, "application/json", [], options)
  },

  /**
   * POST /api/repos/pulls/last-look
   */
  postReposPullsLastLook(input?: { body?: { "owner"?: string; "repo"?: string; "number"?: number } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/repos/pulls/last-look", input ?? {}, [], {"required":false,"content":["application/json"]}, "application/json", [], options)
  },

  /**
   * POST /api/repos/pulls/live
   */
  postReposPullsLive(input?: { body?: { "owner"?: string; "repo"?: string; "number"?: number } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/repos/pulls/live", input ?? {}, [], {"required":false,"content":["application/json"]}, "application/json", [], options)
  },

  /**
   * POST /api/repos/pulls/merge
   */
  postReposPullsMerge(input: { body: { "owner": string; "repo"?: string; "repository"?: string; "number": number; "strategy"?: "merge" | "squash" | "rebase"; "subject"?: string; "body_text"?: string } }, options?: RequestOptions): Promise<ApiResult<null>> {
    return request(config, "POST", "/api/repos/pulls/merge", input ?? {}, [], {"required":true,"content":["application/json"]}, "application/json", [], options)
  },

  /**
   * POST /api/repos/pulls/merge-stack
   */
  postReposPullsMergeStack(input?: { body?: { "owner"?: string; "repo"?: string; "number"?: number; "strategy"?: string } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/repos/pulls/merge-stack", input ?? {}, [], {"required":false,"content":["application/json"]}, "application/json", [], options)
  },

  /**
   * POST /api/repos/pulls/mergeability
   */
  postReposPullsMergeability(input?: { body?: { "owner"?: string; "repo"?: string; "number"?: number; "force"?: string } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/repos/pulls/mergeability", input ?? {}, [], {"required":false,"content":["application/json"]}, "application/json", [], options)
  },

  /**
   * POST /api/repos/pulls/restore-branch
   */
  postReposPullsRestoreBranch(input?: { body?: { "owner"?: string; "repo"?: string; "number"?: number } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/repos/pulls/restore-branch", input ?? {}, [], {"required":false,"content":["application/json"]}, "application/json", [], options)
  },

  /**
   * POST /api/repos/pulls/review-requests
   */
  postReposPullsReviewRequests(input: { body: { "owner": string; "repo"?: string; "repository"?: string; "number": number; "reviewer_id": number; "reviewer_type"?: "user" | "team" } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown> | null>> {
    return request(config, "POST", "/api/repos/pulls/review-requests", input ?? {}, [], {"required":true,"content":["application/json"]}, "application/json", [], options)
  },

  /**
   * GET /api/repos/pulls/review-state
   */
  getReposPullsReviewState(input?: { "owner"?: string; "repo"?: string; "number"?: number }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/repos/pulls/review-state", input ?? {}, [{"name":"owner","in":"query","required":false},{"name":"repo","in":"query","required":false},{"name":"number","in":"query","required":false}], null, "application/json", [], options)
  },

  /**
   * PUT /api/repos/pulls/review-state/draft
   */
  putReposPullsReviewStateDraft(input?: { body?: { "owner"?: string; "repo"?: string; "number"?: number } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "PUT", "/api/repos/pulls/review-state/draft", input ?? {}, [], {"required":false,"content":["application/json"]}, "application/json", [], options)
  },

  /**
   * GET /api/repos/pulls/review-state/since
   */
  getReposPullsReviewStateSince(input?: { "owner"?: string; "repo"?: string; "number"?: number; "since"?: string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/repos/pulls/review-state/since", input ?? {}, [{"name":"owner","in":"query","required":false},{"name":"repo","in":"query","required":false},{"name":"number","in":"query","required":false},{"name":"since","in":"query","required":false}], null, "application/json", [], options)
  },

  /**
   * GET /api/repos/pulls/review-state/stale
   */
  getReposPullsReviewStateStale(input?: { "owner"?: string; "repo"?: string; "number"?: number }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/repos/pulls/review-state/stale", input ?? {}, [{"name":"owner","in":"query","required":false},{"name":"repo","in":"query","required":false},{"name":"number","in":"query","required":false}], null, "application/json", [], options)
  },

  /**
   * PUT /api/repos/pulls/review-state/viewed
   */
  putReposPullsReviewStateViewed(input?: { body?: { "owner"?: string; "repo"?: string; "number"?: number; "path"?: string; "viewed"?: string } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "PUT", "/api/repos/pulls/review-state/viewed", input ?? {}, [], {"required":false,"content":["application/json"]}, "application/json", [], options)
  },

  /**
   * POST /api/repos/pulls/reviews
   */
  postReposPullsReviews(input?: { body?: { "owner"?: string; "repo"?: string; "number"?: number; "state"?: "approved" | "changes_requested" | "commented"; "body"?: string; "comments"?: Array<unknown> } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/repos/pulls/reviews", input ?? {}, [], {"required":false,"content":["application/json"]}, "application/json", [], options)
  },

  /**
   * PUT /api/repos/pulls/reviews/dismiss
   */
  putReposPullsReviewsDismiss(input?: { body?: { "owner"?: string; "repo"?: string; "number"?: number; "reason"?: string; "review_id"?: unknown } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "PUT", "/api/repos/pulls/reviews/dismiss", input ?? {}, [], {"required":false,"content":["application/json"]}, "application/json", [], options)
  },

  /**
   * GET /api/repos/pulls/show
   */
  getReposPullsShow(input?: { "owner"?: string; "repo"?: string; "number"?: number; "fields"?: string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/repos/pulls/show", input ?? {}, [{"name":"owner","in":"query","required":false},{"name":"repo","in":"query","required":false},{"name":"number","in":"query","required":false},{"name":"fields","in":"query","required":false}], null, "application/json", [], options)
  },

  /**
   * GET /api/repos/pulls/stack
   */
  getReposPullsStack(input?: { "owner"?: string; "repo"?: string; "number"?: number }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/repos/pulls/stack", input ?? {}, [{"name":"owner","in":"query","required":false},{"name":"repo","in":"query","required":false},{"name":"number","in":"query","required":false}], null, "application/json", [], options)
  },

  /**
   * PUT /api/repos/pulls/state
   */
  putReposPullsState(input?: { body?: { "owner"?: string; "repo"?: string; "number"?: number; "state"?: string } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "PUT", "/api/repos/pulls/state", input ?? {}, [], {"required":false,"content":["application/json"]}, "application/json", [], options)
  },

  /**
   * GET /api/repos/pulls/suggested-reviewers
   */
  getReposPullsSuggestedReviewers(input?: { "owner"?: string; "repo"?: string; "number"?: number }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/repos/pulls/suggested-reviewers", input ?? {}, [{"name":"owner","in":"query","required":false},{"name":"repo","in":"query","required":false},{"name":"number","in":"query","required":false}], null, "application/json", [], options)
  },

  /**
   * PUT /api/repos/pulls/threads
   */
  putReposPullsThreads(input?: { body?: { "owner"?: string; "repo"?: string; "resolved"?: string; "thread_id"?: unknown } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "PUT", "/api/repos/pulls/threads", input ?? {}, [], {"required":false,"content":["application/json"]}, "application/json", [], options)
  },

  /**
   * GET /api/repos/raw
   */
  getReposRaw(input?: { "owner"?: string; "repo"?: string; "inline"?: string; "path"?: string; "ref"?: string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/repos/raw", input ?? {}, [{"name":"owner","in":"query","required":false},{"name":"repo","in":"query","required":false},{"name":"inline","in":"query","required":false},{"name":"path","in":"query","required":false},{"name":"ref","in":"query","required":false}], null, "application/json", [], options)
  },

  /**
   * GET /api/repos/releases
   */
  getReposReleases(input?: { "owner"?: string; "repo"?: string; "ref"?: string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/repos/releases", input ?? {}, [{"name":"owner","in":"query","required":false},{"name":"repo","in":"query","required":false},{"name":"ref","in":"query","required":false}], null, "application/json", [], options)
  },

  /**
   * POST /api/repos/releases
   */
  postReposReleases(input?: { body?: { "owner"?: string; "repo"?: string; "body"?: string; "is_draft"?: unknown; "is_prerelease"?: string; "name"?: string; "operation"?: string; "tag_name"?: string } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/repos/releases", input ?? {}, [], {"required":false,"content":["application/json"]}, "application/json", [], options)
  },

  /**
   * GET /api/repos/releases/assets
   */
  getReposReleasesAssets(input?: { "owner"?: string; "repo"?: string; "name"?: string; "ref"?: string; "tag_name"?: string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/repos/releases/assets", input ?? {}, [{"name":"owner","in":"query","required":false},{"name":"repo","in":"query","required":false},{"name":"name","in":"query","required":false},{"name":"ref","in":"query","required":false},{"name":"tag_name","in":"query","required":false}], null, "application/json", [], options)
  },

  /**
   * POST /api/repos/releases/assets
   */
  postReposReleasesAssets(input?: { body?: { "owner"?: string; "repo"?: string; "tag_name"?: string } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/repos/releases/assets", input ?? {}, [], {"required":false,"content":["application/json"]}, "application/json", [], options)
  },

  /**
   * POST /api/repos/repair-settings
   */
  postReposRepairSettings(input?: { body?: { "owner"?: string; "repo"?: string; "operation"?: string; "enabled"?: boolean; "forbidden_paths"?: string; "steps"?: string; "max_attempts"?: number; "max_minutes"?: number; "max_cost"?: number } }, options?: RequestOptions): Promise<ApiResult<{ "repair"?: { "enabled"?: boolean; "forbidden_paths"?: Array<string>; "steps"?: Array<string>; "max_attempts"?: number; "max_minutes"?: number; "max_cost"?: number }; "defaults"?: Record<string, unknown> }>> {
    return request(config, "POST", "/api/repos/repair-settings", input ?? {}, [], {"required":false,"content":["application/json"]}, "application/json", [], options)
  },

  /**
   * GET /api/repos/search
   */
  getReposSearch(input: { "owner": string; "repository"?: string; "q": string; "ref"?: string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/repos/search", input ?? {}, [{"name":"owner","in":"query","required":true},{"name":"repository","in":"query","required":false},{"name":"q","in":"query","required":true},{"name":"ref","in":"query","required":false}], null, "application/json", [], options)
  },

  /**
   * POST /api/repos/secrets
   */
  postReposSecrets(input?: { body?: { "owner"?: string; "repo"?: string; "operation"?: "list" | "set" | "unset"; "scope"?: "instance" | "owner" | "repository" | "environment"; "reference"?: string; "environment"?: string; "key"?: string; "value"?: string } }, options?: RequestOptions): Promise<ApiResult<{ "secrets"?: Array<{ "key"?: string; "scope"?: string; "updated_at"?: string | null }> }>> {
    return request(config, "POST", "/api/repos/secrets", input ?? {}, [], {"required":false,"content":["application/json"]}, "application/json", [], options)
  },

  /**
   * POST /api/repos/settings
   */
  postReposSettings(input?: { body?: { "owner"?: string; "repo"?: string; "allow_merge_commit"?: unknown; "allow_rebase_merge"?: unknown; "allow_squash_merge"?: unknown; "default_branch"?: string; "default_merge_strategy"?: string; "delete_branch_on_merge"?: unknown; "description"?: string; "homepage"?: string; "is_archived"?: unknown; "is_template"?: unknown; "name"?: string; "visibility"?: string } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/repos/settings", input ?? {}, [], {"required":false,"content":["application/json"]}, "application/json", [], options)
  },

  /**
   * POST /api/repos/stars
   */
  postReposStars(input: { body: { "owner": string; "repo"?: string; "repository"?: string } }, options?: RequestOptions): Promise<ApiResult<null>> {
    return request(config, "POST", "/api/repos/stars", input ?? {}, [], {"required":true,"content":["application/json"]}, "application/json", [], options)
  },

  /**
   * GET /api/repos/tags
   */
  getReposTags(input?: { "owner"?: string; "repo"?: string; "ref"?: string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/repos/tags", input ?? {}, [{"name":"owner","in":"query","required":false},{"name":"repo","in":"query","required":false},{"name":"ref","in":"query","required":false}], null, "application/json", [], options)
  },

  /**
   * POST /api/repos/teams
   */
  postReposTeams(input?: { body?: { "owner"?: string; "repo"?: string; "operation"?: string; "permission"?: string; "team_id"?: unknown } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/repos/teams", input ?? {}, [], {"required":false,"content":["application/json"]}, "application/json", [], options)
  },

  /**
   * GET /api/repos/tests
   */
  getReposTests(input?: { "owner"?: string; "repo"?: string; "view"?: "suites" | "runs" | "executions" | "states"; "suite"?: string; "branch"?: string; "run"?: number; "test"?: number; "state"?: string; "limit"?: number; "cursor"?: number }, options?: RequestOptions): Promise<ApiResult<{ "suites"?: Array<Record<string, unknown>>; "runs"?: Array<Record<string, unknown>>; "executions"?: Array<Record<string, unknown>>; "states"?: Array<Record<string, unknown>>; "next"?: number | null }>> {
    return request(config, "GET", "/api/repos/tests", input ?? {}, [{"name":"owner","in":"query","required":false},{"name":"repo","in":"query","required":false},{"name":"view","in":"query","required":false},{"name":"suite","in":"query","required":false},{"name":"branch","in":"query","required":false},{"name":"run","in":"query","required":false},{"name":"test","in":"query","required":false},{"name":"state","in":"query","required":false},{"name":"limit","in":"query","required":false},{"name":"cursor","in":"query","required":false}], null, "application/json", [], options)
  },

  /**
   * POST /api/repos/tests/ingest
   */
  postReposTestsIngest(input?: { body?: { "owner"?: string; "repo"?: string; "suite"?: string; "sha"?: string; "branch"?: string; "key"?: string; "format"?: "junit" | "json"; "report"?: string } }, options?: RequestOptions): Promise<ApiResult<{ "run"?: number; "verdict"?: string; "duplicate"?: boolean; "counts"?: { "passed"?: number; "failed"?: number; "skipped"?: number; "muted_failures"?: number }; "newly_flaky"?: Array<string> }>> {
    return request(config, "POST", "/api/repos/tests/ingest", input ?? {}, [], {"required":false,"content":["application/json"]}, "application/json", [], options)
  },

  /**
   * POST /api/repos/tests/manage
   */
  postReposTestsManage(input?: { body?: { "owner"?: string; "repo"?: string; "operation"?: "list" | "flaky" | "quarantined" | "mute" | "skip" | "enable" | "own" | "history"; "suite"?: string; "test"?: number; "reason"?: string; "review"?: string; "who"?: string; "limit"?: number } }, options?: RequestOptions): Promise<ApiResult<null>> {
    return request(config, "POST", "/api/repos/tests/manage", input ?? {}, [], {"required":false,"content":["application/json"]}, "application/json", [], options)
  },

  /**
   * POST /api/repos/tests/monitors
   */
  postReposTestsMonitors(input?: { body?: { "owner"?: string; "repo"?: string; "operation"?: "list" | "create" | "update" | "delete" | "evaluate"; "monitor"?: number; "suite"?: string; "condition"?: "flaky" | "fail_rate" | "duration"; "threshold"?: number; "window_days"?: number; "enabled"?: boolean } }, options?: RequestOptions): Promise<ApiResult<null>> {
    return request(config, "POST", "/api/repos/tests/monitors", input ?? {}, [], {"required":false,"content":["application/json"]}, "application/json", [], options)
  },

  /**
   * POST /api/repos/tests/split
   */
  postReposTestsSplit(input?: { body?: { "owner"?: string; "repo"?: string; "suite"?: string; "nodes"?: number; "index"?: number } }, options?: RequestOptions): Promise<ApiResult<{ "items"?: Array<string>; "estimated_ms"?: number; "unknown"?: number; "note"?: string | null }>> {
    return request(config, "POST", "/api/repos/tests/split", input ?? {}, [], {"required":false,"content":["application/json"]}, "application/json", [], options)
  },

  /**
   * PUT /api/repos/topics
   */
  putReposTopics(input?: { body?: { "owner"?: string; "repo"?: string; "topics"?: string } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "PUT", "/api/repos/topics", input ?? {}, [], {"required":false,"content":["application/json"]}, "application/json", [], options)
  },

  /**
   * POST /api/repos/topics
   */
  postReposTopics(input?: { body?: { "owner"?: string; "repo"?: string; "topics"?: string } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/repos/topics", input ?? {}, [], {"required":false,"content":["application/json"]}, "application/json", [], options)
  },

  /**
   * POST /api/repos/transfer
   */
  postReposTransfer(input: { body: { "owner": string; "repo"?: string; "repository"?: string; "to"?: string; "new_owner"?: string } }, options?: RequestOptions): Promise<ApiResult<null>> {
    return request(config, "POST", "/api/repos/transfer", input ?? {}, [], {"required":true,"content":["application/json"]}, "application/json", [], options)
  },

  /**
   * GET /api/repos/tree
   */
  getReposTree(input?: { "owner"?: string; "repo"?: string; "path"?: string; "ref"?: string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/repos/tree", input ?? {}, [{"name":"owner","in":"query","required":false},{"name":"repo","in":"query","required":false},{"name":"path","in":"query","required":false},{"name":"ref","in":"query","required":false}], null, "application/json", [], options)
  },

  /**
   * POST /api/repos/variables
   */
  postReposVariables(input?: { body?: { "owner"?: string; "repo"?: string; "operation"?: "list" | "set" | "unset"; "scope"?: "instance" | "owner" | "repository"; "key"?: string; "value"?: string } }, options?: RequestOptions): Promise<ApiResult<{ "variables"?: Array<{ "key"?: string; "value"?: string; "scope"?: string; "from"?: string; "shadowed"?: Array<Record<string, unknown>> }> }>> {
    return request(config, "POST", "/api/repos/variables", input ?? {}, [], {"required":false,"content":["application/json"]}, "application/json", [], options)
  },

  /**
   * PUT /api/repos/watches
   */
  putReposWatches(input: { body: { "owner": string; "repo"?: string; "repository"?: string; "subscription"?: "all" | "participating" | "ignore" | "none" } }, options?: RequestOptions): Promise<ApiResult<null>> {
    return request(config, "PUT", "/api/repos/watches", input ?? {}, [], {"required":true,"content":["application/json"]}, "application/json", [], options)
  },

  /**
   * POST /api/repos/watches
   */
  postReposWatches(input: { body: { "owner": string; "repo"?: string; "repository"?: string; "subscription"?: "all" | "participating" | "ignore" | "none" } }, options?: RequestOptions): Promise<ApiResult<null>> {
    return request(config, "POST", "/api/repos/watches", input ?? {}, [], {"required":true,"content":["application/json"]}, "application/json", [], options)
  },

  /**
   * POST /api/repos/webhooks
   */
  postReposWebhooks(input: { body: { "owner": string; "repo"?: string; "repository"?: string; "operation"?: "create" | "update" | "delete" | "deliveries"; "id"?: number; "url"?: string; "secret"?: string; "content_type"?: string; "active"?: boolean; "limit"?: number; "events"?: unknown } }, options?: RequestOptions): Promise<ApiResult<null>> {
    return request(config, "POST", "/api/repos/webhooks", input ?? {}, [], {"required":true,"content":["application/json"]}, "application/json", [], options)
  },

  /**
   * POST /api/repos/webhooks/redeliver
   */
  postReposWebhooksRedeliver(input?: { body?: { "owner"?: string; "repo"?: string; "delivery_id"?: unknown } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/repos/webhooks/redeliver", input ?? {}, [], {"required":false,"content":["application/json"]}, "application/json", [], options)
  },

  /**
   * GET /api/repos/workflow-metrics
   */
  getReposWorkflowMetrics(input?: { "owner"?: string; "repo"?: string; "workflow"?: number; "days"?: number }, options?: RequestOptions): Promise<ApiResult<{ "window"?: { "days"?: number; "since"?: string }; "runs"?: Record<string, unknown>; "jobs"?: Record<string, unknown>; "steps"?: Array<Record<string, unknown>>; "cache"?: Record<string, unknown> }>> {
    return request(config, "GET", "/api/repos/workflow-metrics", input ?? {}, [{"name":"owner","in":"query","required":false},{"name":"repo","in":"query","required":false},{"name":"workflow","in":"query","required":false},{"name":"days","in":"query","required":false}], null, "application/json", [], options)
  },

  /**
   * POST /api/repos/workflow-notifications
   */
  postReposWorkflowNotifications(input?: { body?: { "owner"?: string; "repo"?: string; "operation"?: "list" | "add" | "remove"; "user"?: string; "workflow"?: string; "branch"?: string; "job"?: string; "condition"?: "failure" | "success" | "recovery" | "always"; "id"?: number } }, options?: RequestOptions): Promise<ApiResult<null>> {
    return request(config, "POST", "/api/repos/workflow-notifications", input ?? {}, [], {"required":false,"content":["application/json"]}, "application/json", [], options)
  },

  /**
   * GET /api/repos/workflow-runs
   */
  getReposWorkflowRuns(input?: { "owner"?: string; "repo"?: string; "state"?: string; "branch"?: string; "sha"?: string; "workflow"?: number; "per_page"?: number; "cursor"?: string }, options?: RequestOptions): Promise<ApiResult<{ "workflow_runs"?: Array<Record<string, unknown>>; "next"?: string | null }>> {
    return request(config, "GET", "/api/repos/workflow-runs", input ?? {}, [{"name":"owner","in":"query","required":false},{"name":"repo","in":"query","required":false},{"name":"state","in":"query","required":false},{"name":"branch","in":"query","required":false},{"name":"sha","in":"query","required":false},{"name":"workflow","in":"query","required":false},{"name":"per_page","in":"query","required":false},{"name":"cursor","in":"query","required":false}], null, "application/json", [], options)
  },

  /**
   * POST /api/repos/workflow-runs/approve
   */
  postReposWorkflowRunsApprove(input?: { body?: { "owner"?: string; "repo"?: string; "number"?: number; "job"?: unknown } }, options?: RequestOptions): Promise<ApiResult<{ "job"?: { "job_id"?: string; "state"?: string }; "run"?: { "number"?: number; "state"?: string }; "outputs"?: Record<string, unknown> }>> {
    return request(config, "POST", "/api/repos/workflow-runs/approve", input ?? {}, [], {"required":false,"content":["application/json"]}, "application/json", [], options)
  },

  /**
   * POST /api/repos/workflow-runs/approve-fork
   */
  postReposWorkflowRunsApproveFork(input?: { body?: { "owner"?: string; "repo"?: string; "number"?: number; "decision"?: string } }, options?: RequestOptions): Promise<ApiResult<{ "run"?: { "number"?: number; "state"?: string; "approval_state"?: string; "trusted"?: boolean }; "note"?: string }>> {
    return request(config, "POST", "/api/repos/workflow-runs/approve-fork", input ?? {}, [], {"required":false,"content":["application/json"]}, "application/json", [], options)
  },

  /**
   * GET /api/repos/workflow-runs/artifact
   */
  getReposWorkflowRunsArtifact(input: { "owner"?: string; "repo"?: string; "id": number }, options?: RequestOptions): Promise<ApiResult<null>> {
    return request(config, "GET", "/api/repos/workflow-runs/artifact", input ?? {}, [{"name":"owner","in":"query","required":false},{"name":"repo","in":"query","required":false},{"name":"id","in":"query","required":true}], null, "application/json", [], options)
  },

  /**
   * GET /api/repos/workflow-runs/artifacts
   */
  getReposWorkflowRunsArtifacts(input?: { "owner"?: string; "repo"?: string; "number"?: number; "q"?: string }, options?: RequestOptions): Promise<ApiResult<{ "artifacts"?: Array<Record<string, unknown>>; "total_bytes"?: number }>> {
    return request(config, "GET", "/api/repos/workflow-runs/artifacts", input ?? {}, [{"name":"owner","in":"query","required":false},{"name":"repo","in":"query","required":false},{"name":"number","in":"query","required":false},{"name":"q","in":"query","required":false}], null, "application/json", [], options)
  },

  /**
   * GET /api/repos/workflow-runs/artifacts/archive
   */
  getReposWorkflowRunsArtifactsArchive(input?: { "owner"?: string; "repo"?: string; "number"?: number }, options?: RequestOptions): Promise<ApiResult<null>> {
    return request(config, "GET", "/api/repos/workflow-runs/artifacts/archive", input ?? {}, [{"name":"owner","in":"query","required":false},{"name":"repo","in":"query","required":false},{"name":"number","in":"query","required":false}], null, "application/json", [], options)
  },

  /**
   * POST /api/repos/workflow-runs/cancel
   */
  postReposWorkflowRunsCancel(input?: { body?: { "owner"?: string; "repo"?: string; "number"?: number; "reason"?: string } }, options?: RequestOptions): Promise<ApiResult<{ "workflow_run"?: { "number"?: number; "state"?: string }; "cancelled"?: boolean; "reason"?: string }>> {
    return request(config, "POST", "/api/repos/workflow-runs/cancel", input ?? {}, [], {"required":false,"content":["application/json"]}, "application/json", [], options)
  },

  /**
   * POST /api/repos/workflow-runs/cancel-job
   */
  postReposWorkflowRunsCancelJob(input?: { body?: { "owner"?: string; "repo"?: string; "number"?: number; "job"?: string; "reason"?: string } }, options?: RequestOptions): Promise<ApiResult<{ "job"?: { "job_id"?: string; "state"?: string }; "run_state"?: string; "cancelled"?: boolean }>> {
    return request(config, "POST", "/api/repos/workflow-runs/cancel-job", input ?? {}, [], {"required":false,"content":["application/json"]}, "application/json", [], options)
  },

  /**
   * POST /api/repos/workflow-runs/event
   */
  postReposWorkflowRunsEvent(input?: { body?: { "owner"?: string; "repo"?: string; "number"?: number; "event"?: string; "payload"?: string; "key"?: string } }, options?: RequestOptions): Promise<ApiResult<{ "event"?: string; "duplicate"?: boolean; "delivered"?: number }>> {
    return request(config, "POST", "/api/repos/workflow-runs/event", input ?? {}, [], {"required":false,"content":["application/json"]}, "application/json", [], options)
  },

  /**
   * GET /api/repos/workflow-runs/log
   */
  getReposWorkflowRunsLog(input: { "owner"?: string; "repo"?: string; "job": number; "after"?: number; "attempt"?: number }, options?: RequestOptions): Promise<ApiResult<{ "chunks"?: Array<Record<string, unknown>>; "cursor"?: number; "state"?: string; "attempt"?: number }>> {
    return request(config, "GET", "/api/repos/workflow-runs/log", input ?? {}, [{"name":"owner","in":"query","required":false},{"name":"repo","in":"query","required":false},{"name":"job","in":"query","required":true},{"name":"after","in":"query","required":false},{"name":"attempt","in":"query","required":false}], null, "application/json", [], options)
  },

  /**
   * GET /api/repos/workflow-runs/log-image
   */
  getReposWorkflowRunsLogImage(input?: { "owner"?: string; "repo"?: string; "number"?: number; "artifact"?: string }, options?: RequestOptions): Promise<ApiResult<null>> {
    return request(config, "GET", "/api/repos/workflow-runs/log-image", input ?? {}, [{"name":"owner","in":"query","required":false},{"name":"repo","in":"query","required":false},{"name":"number","in":"query","required":false},{"name":"artifact","in":"query","required":false}], null, "application/json", [], options)
  },

  /**
   * POST /api/repos/workflow-runs/pause
   */
  postReposWorkflowRunsPause(input?: { body?: { "owner"?: string; "repo"?: string; "number"?: number; "action"?: string } }, options?: RequestOptions): Promise<ApiResult<{ "workflow_run"?: { "number"?: number; "state"?: string }; "changed"?: boolean }>> {
    return request(config, "POST", "/api/repos/workflow-runs/pause", input ?? {}, [], {"required":false,"content":["application/json"]}, "application/json", [], options)
  },

  /**
   * POST /api/repos/workflow-runs/rerun
   */
  postReposWorkflowRunsRerun(input?: { body?: { "owner"?: string; "repo"?: string; "number"?: number; "scope"?: string; "job"?: string; "step"?: string } }, options?: RequestOptions): Promise<ApiResult<{ "workflow_run"?: { "number"?: number; "state"?: string; "attempt"?: number }; "jobs"?: number; "reused"?: number; "reason"?: string }>> {
    return request(config, "POST", "/api/repos/workflow-runs/rerun", input ?? {}, [], {"required":false,"content":["application/json"]}, "application/json", [], options)
  },

  /**
   * GET /api/repos/workflow-runs/show
   */
  getReposWorkflowRunsShow(input?: { "owner"?: string; "repo"?: string; "number"?: number }, options?: RequestOptions): Promise<ApiResult<{ "workflow_run"?: Record<string, unknown> }>> {
    return request(config, "GET", "/api/repos/workflow-runs/show", input ?? {}, [{"name":"owner","in":"query","required":false},{"name":"repo","in":"query","required":false},{"name":"number","in":"query","required":false}], null, "application/json", [], options)
  },

  /**
   * POST /api/repos/workflow-templates
   */
  postReposWorkflowTemplates(input?: { body?: { "owner"?: string; "repo"?: string; "operation"?: "list" | "publish" | "remove" | "apply"; "slug"?: string; "name"?: string; "description"?: string; "path"?: string; "source"?: string; "template"?: number; "branch"?: string; "overwrite"?: boolean } }, options?: RequestOptions): Promise<ApiResult<null>> {
    return request(config, "POST", "/api/repos/workflow-templates", input ?? {}, [], {"required":false,"content":["application/json"]}, "application/json", [], options)
  },

  /**
   * GET /api/repos/workflows
   */
  getReposWorkflows(input?: { "owner"?: string; "repo"?: string; "state"?: string; "per_page"?: number; "cursor"?: string }, options?: RequestOptions): Promise<ApiResult<{ "workflows"?: Array<Record<string, unknown>>; "next"?: string | null }>> {
    return request(config, "GET", "/api/repos/workflows", input ?? {}, [{"name":"owner","in":"query","required":false},{"name":"repo","in":"query","required":false},{"name":"state","in":"query","required":false},{"name":"per_page","in":"query","required":false},{"name":"cursor","in":"query","required":false}], null, "application/json", [], options)
  },

  /**
   * POST /api/repos/workflows/dispatch
   */
  postReposWorkflowsDispatch(input?: { body?: { "owner"?: string; "repo"?: string; "workflow"?: string; "ref"?: string; "key"?: string } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown> | { "workflow_run"?: { "number"?: number; "state"?: string; "event"?: string; "inputs"?: Record<string, unknown>; "request_id"?: string } }>> {
    return request(config, "POST", "/api/repos/workflows/dispatch", input ?? {}, [], {"required":false,"content":["application/json"]}, "application/json", [], options)
  },

  /**
   * POST /api/repos/workflows/manage
   */
  postReposWorkflowsManage(input?: { body?: { "owner"?: string; "repo"?: string; "workflow"?: string; "operation"?: "enable" | "disable"; "reason"?: string } }, options?: RequestOptions): Promise<ApiResult<null>> {
    return request(config, "POST", "/api/repos/workflows/manage", input ?? {}, [], {"required":false,"content":["application/json"]}, "application/json", [], options)
  },

  /**
   * GET /api/repos/workflows/show
   */
  getReposWorkflowsShow(input?: { "owner"?: string; "repo"?: string; "workflow"?: string; "version"?: number }, options?: RequestOptions): Promise<ApiResult<{ "workflow"?: Record<string, unknown>; "versions"?: Array<Record<string, unknown>>; "version"?: Record<string, unknown> }>> {
    return request(config, "GET", "/api/repos/workflows/show", input ?? {}, [{"name":"owner","in":"query","required":false},{"name":"repo","in":"query","required":false},{"name":"workflow","in":"query","required":false},{"name":"version","in":"query","required":false}], null, "application/json", [], options)
  },

  /**
   * GET /api/repos/{owner}/{repository}/projects
   */
  getReposOwnerRepositoryProjects(input: { "owner": string; "repository": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/repos/{owner}/{repository}/projects", input ?? {}, [{"name":"owner","in":"path","required":true},{"name":"repository","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * POST /api/repos/{owner}/{repository}/projects
   */
  postReposOwnerRepositoryProjects(input: { "owner": string; "repository": string; body: { "title": string; "description"?: string } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/repos/{owner}/{repository}/projects", input ?? {}, [{"name":"owner","in":"path","required":true},{"name":"repository","in":"path","required":true}], {"required":true,"content":["application/json"]}, "application/json", [], options)
  },

  /**
   * GET /api/repos/{owner}/{repository}/projects/{project}
   */
  getReposOwnerRepositoryProjectsProject(input: { "owner": string; "repository": string; "project": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/repos/{owner}/{repository}/projects/{project}", input ?? {}, [{"name":"owner","in":"path","required":true},{"name":"repository","in":"path","required":true},{"name":"project","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * POST /api/repos/{owner}/{repository}/projects/{project}
   */
  postReposOwnerRepositoryProjectsProject(input: { "owner": string; "repository": string; "project": string; body?: { "title"?: string; "description"?: string; "state"?: string; "revision"?: unknown } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/repos/{owner}/{repository}/projects/{project}", input ?? {}, [{"name":"owner","in":"path","required":true},{"name":"repository","in":"path","required":true},{"name":"project","in":"path","required":true}], {"required":false,"content":["application/json"]}, "application/json", [], options)
  },

  /**
   * POST /api/repos/{owner}/{repository}/projects/{project}/columns
   */
  postReposOwnerRepositoryProjectsProjectColumns(input: { "owner": string; "repository": string; "project": string; body?: { "title"?: string; "operation"?: string; "column_id"?: unknown } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/repos/{owner}/{repository}/projects/{project}/columns", input ?? {}, [{"name":"owner","in":"path","required":true},{"name":"repository","in":"path","required":true},{"name":"project","in":"path","required":true}], {"required":false,"content":["application/json"]}, "application/json", [], options)
  },

  /**
   * POST /api/repos/{owner}/{repository}/projects/{project}/items
   */
  postReposOwnerRepositoryProjectsProjectItems(input: { "owner": string; "repository": string; "project": string; body?: { "number"?: unknown; "column_id"?: unknown } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/repos/{owner}/{repository}/projects/{project}/items", input ?? {}, [{"name":"owner","in":"path","required":true},{"name":"repository","in":"path","required":true},{"name":"project","in":"path","required":true}], {"required":false,"content":["application/json"]}, "application/json", [], options)
  },

  /**
   * POST /api/repos/{owner}/{repository}/projects/{project}/items/{item}/move
   */
  postReposOwnerRepositoryProjectsProjectItemsItemMove(input: { "owner": string; "repository": string; "project": string; "item": string; body?: { "column_id"?: unknown; "before_item_id"?: unknown; "revision"?: unknown } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/repos/{owner}/{repository}/projects/{project}/items/{item}/move", input ?? {}, [{"name":"owner","in":"path","required":true},{"name":"repository","in":"path","required":true},{"name":"project","in":"path","required":true},{"name":"item","in":"path","required":true}], {"required":false,"content":["application/json"]}, "application/json", [], options)
  },

  /**
   * POST /api/repos/{owner}/{repository}/projects/{project}/items/{item}/remove
   */
  postReposOwnerRepositoryProjectsProjectItemsItemRemove(input: { "owner": string; "repository": string; "project": string; "item": string; body?: { "revision"?: unknown } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/repos/{owner}/{repository}/projects/{project}/items/{item}/remove", input ?? {}, [{"name":"owner","in":"path","required":true},{"name":"repository","in":"path","required":true},{"name":"project","in":"path","required":true},{"name":"item","in":"path","required":true}], {"required":false,"content":["application/json"]}, "application/json", [], options)
  },

  /**
   * GET /api/repos/{owner}/{repository}/registry
   */
  getReposOwnerRepositoryRegistry(input: { "owner": string; "repository": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/repos/{owner}/{repository}/registry", input ?? {}, [{"name":"owner","in":"path","required":true},{"name":"repository","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * GET /api/repos/{owner}/{repository}/registry/packages/{scope}/{package}
   */
  getReposOwnerRepositoryRegistryPackagesScopePackage(input: { "owner": string; "repository": string; "scope": string; "package": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/repos/{owner}/{repository}/registry/packages/{scope}/{package}", input ?? {}, [{"name":"owner","in":"path","required":true},{"name":"repository","in":"path","required":true},{"name":"scope","in":"path","required":true},{"name":"package","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * GET /api/repos/{owner}/{repository}/registry/packages/{scope}/{package}/{version}
   */
  getReposOwnerRepositoryRegistryPackagesScopePackageVersion(input: { "owner": string; "repository": string; "scope": string; "package": string; "version": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/repos/{owner}/{repository}/registry/packages/{scope}/{package}/{version}", input ?? {}, [{"name":"owner","in":"path","required":true},{"name":"repository","in":"path","required":true},{"name":"scope","in":"path","required":true},{"name":"package","in":"path","required":true},{"name":"version","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * GET /api/repos/{owner}/{repository}/registry/packages/{scope}/{package}/{version}/tarball
   */
  getReposOwnerRepositoryRegistryPackagesScopePackageVersionTarball(input: { "owner": string; "repository": string; "scope": string; "package": string; "version": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/repos/{owner}/{repository}/registry/packages/{scope}/{package}/{version}/tarball", input ?? {}, [{"name":"owner","in":"path","required":true},{"name":"repository","in":"path","required":true},{"name":"scope","in":"path","required":true},{"name":"package","in":"path","required":true},{"name":"version","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * POST /api/repos/{owner}/{repository}/registry/publish
   */
  postReposOwnerRepositoryRegistryPublish(input: { "owner": string; "repository": string; body?: { "metadata"?: unknown; "name"?: string; "version"?: string; "description"?: string; "license"?: string } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/repos/{owner}/{repository}/registry/publish", input ?? {}, [{"name":"owner","in":"path","required":true},{"name":"repository","in":"path","required":true}], {"required":false,"content":["application/json"]}, "application/json", [], options)
  },

  /**
   * GET /api/repos/{owner}/{repository}/wiki
   */
  getReposOwnerRepositoryWiki(input: { "owner": string; "repository": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/repos/{owner}/{repository}/wiki", input ?? {}, [{"name":"owner","in":"path","required":true},{"name":"repository","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * POST /api/repos/{owner}/{repository}/wiki
   */
  postReposOwnerRepositoryWiki(input: { "owner": string; "repository": string; body: { "title": string; "slug"?: string; "body"?: string; "summary"?: string } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/repos/{owner}/{repository}/wiki", input ?? {}, [{"name":"owner","in":"path","required":true},{"name":"repository","in":"path","required":true}], {"required":true,"content":["application/json"]}, "application/json", [], options)
  },

  /**
   * POST /api/repos/{owner}/{repository}/wiki-preview
   */
  postReposOwnerRepositoryWikiPreview(input: { "owner": string; "repository": string; body?: { "body"?: string } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/repos/{owner}/{repository}/wiki-preview", input ?? {}, [{"name":"owner","in":"path","required":true},{"name":"repository","in":"path","required":true}], {"required":false,"content":["application/json"]}, "application/json", [], options)
  },

  /**
   * GET /api/repos/{owner}/{repository}/wiki/{slug}
   */
  getReposOwnerRepositoryWikiSlug(input: { "owner": string; "repository": string; "slug": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/repos/{owner}/{repository}/wiki/{slug}", input ?? {}, [{"name":"owner","in":"path","required":true},{"name":"repository","in":"path","required":true},{"name":"slug","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * POST /api/repos/{owner}/{repository}/wiki/{slug}
   */
  postReposOwnerRepositoryWikiSlug(input: { "owner": string; "repository": string; "slug": string; body: { "title": string; "body"?: string; "revision"?: unknown; "summary"?: string } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/repos/{owner}/{repository}/wiki/{slug}", input ?? {}, [{"name":"owner","in":"path","required":true},{"name":"repository","in":"path","required":true},{"name":"slug","in":"path","required":true}], {"required":true,"content":["application/json"]}, "application/json", [], options)
  },

  /**
   * POST /api/repos/{owner}/{repository}/wiki/{slug}/delete
   */
  postReposOwnerRepositoryWikiSlugDelete(input: { "owner": string; "repository": string; "slug": string; body?: { "revision"?: unknown } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/repos/{owner}/{repository}/wiki/{slug}/delete", input ?? {}, [{"name":"owner","in":"path","required":true},{"name":"repository","in":"path","required":true},{"name":"slug","in":"path","required":true}], {"required":false,"content":["application/json"]}, "application/json", [], options)
  },

  /**
   * GET /api/reviews/queue
   */
  getReviewsQueue(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/reviews/queue", {}, [], null, "application/json", [], options)
  },

  /**
   * POST /api/runner/annotations
   */
  postRunnerAnnotations(input?: { body?: { "summary"?: string; "context"?: string; "append"?: boolean } }, options?: RequestOptions): Promise<ApiResult<{ "recorded"?: number; "check_run"?: number }>> {
    return request(config, "POST", "/api/runner/annotations", input ?? {}, [], {"required":false,"content":["application/json"]}, "application/json", [], options)
  },

  /**
   * POST /api/runner/artifacts
   */
  postRunnerArtifacts(options?: RequestOptions): Promise<ApiResult<Record<string, unknown> | { "id"?: number; "name"?: string; "digest"?: string; "size_bytes"?: number; "expires_at"?: string; "duplicate"?: boolean }>> {
    return request(config, "POST", "/api/runner/artifacts", {}, [], null, "application/json", [], options)
  },

  /**
   * POST /api/runner/artifacts/fetch
   */
  postRunnerArtifactsFetch(input?: { body?: { "name"?: string; "job_id"?: number } }, options?: RequestOptions): Promise<ApiResult<null>> {
    return request(config, "POST", "/api/runner/artifacts/fetch", input ?? {}, [], {"required":false,"content":["application/json"]}, "application/json", [], options)
  },

  /**
   * POST /api/runner/caches
   */
  postRunnerCaches(options?: RequestOptions): Promise<ApiResult<Record<string, unknown> | { "scope"?: string; "duplicate"?: boolean }>> {
    return request(config, "POST", "/api/runner/caches", {}, [], null, "application/json", [], options)
  },

  /**
   * GET /api/runner/caches/restore
   */
  getRunnerCachesRestore(input?: { "key"?: string }, options?: RequestOptions): Promise<ApiResult<null>> {
    return request(config, "GET", "/api/runner/caches/restore", input ?? {}, [{"name":"key","in":"query","required":false}], null, "application/json", [], options)
  },

  /**
   * POST /api/runner/claim
   */
  postRunnerClaim(input?: { body?: { "accept_work"?: boolean; "hold_reason"?: string } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/runner/claim", input ?? {}, [], {"required":false,"content":["application/json"]}, "application/json", [], options)
  },

  /**
   * GET /api/runner/download
   */
  getRunnerDownload(input?: { "target"?: string }, options?: RequestOptions): Promise<ApiResult<null>> {
    return request(config, "GET", "/api/runner/download", input ?? {}, [{"name":"target","in":"query","required":false}], null, "application/json", [], options)
  },

  /**
   * POST /api/runner/heartbeat
   */
  postRunnerHeartbeat(input?: { body?: { "steps"?: Array<unknown> } }, options?: RequestOptions): Promise<ApiResult<{ "lease_expires_at"?: string; "steps_recorded"?: number }>> {
    return request(config, "POST", "/api/runner/heartbeat", input ?? {}, [], {"required":false,"content":["application/json"]}, "application/json", [], options)
  },

  /**
   * POST /api/runner/logs
   */
  postRunnerLogs(input: { body: { "sequence": number; "content"?: string; "stream"?: "stdout" | "stderr" } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/runner/logs", input ?? {}, [], {"required":true,"content":["application/json"]}, "application/json", [], options)
  },

  /**
   * POST /api/runner/metadata
   */
  postRunnerMetadata(input?: { body?: { "action"?: string; "key"?: string; "value"?: string; "if_version"?: number } }, options?: RequestOptions): Promise<ApiResult<{ "entry"?: { "key"?: string; "value"?: string; "version"?: number } | null; "entries"?: Array<Record<string, unknown>> }>> {
    return request(config, "POST", "/api/runner/metadata", input ?? {}, [], {"required":false,"content":["application/json"]}, "application/json", [], options)
  },

  /**
   * POST /api/runner/oidc
   */
  postRunnerOidc(input?: { body?: { "audience"?: string } }, options?: RequestOptions): Promise<ApiResult<{ "value"?: string; "expires_in"?: number; "claims"?: Record<string, unknown> }>> {
    return request(config, "POST", "/api/runner/oidc", input ?? {}, [], {"required":false,"content":["application/json"]}, "application/json", [], options)
  },

  /**
   * POST /api/runner/orchestrator
   */
  postRunnerOrchestrator(input: { body: { "sequence": number; "kind"?: string; "name"?: string } }, options?: RequestOptions): Promise<ApiResult<{ "decision"?: string; "result"?: unknown; "entry_id"?: number; "reason"?: string; "wake_at"?: string }>> {
    return request(config, "POST", "/api/runner/orchestrator", input ?? {}, [], {"required":true,"content":["application/json"]}, "application/json", [], options)
  },

  /**
   * POST /api/runner/orchestrator/result
   */
  postRunnerOrchestratorResult(input: { body: { "entry_id": number } }, options?: RequestOptions): Promise<ApiResult<{ "recorded"?: boolean }>> {
    return request(config, "POST", "/api/runner/orchestrator/result", input ?? {}, [], {"required":true,"content":["application/json"]}, "application/json", [], options)
  },

  /**
   * POST /api/runner/register
   */
  postRunnerRegister(input?: { body?: { "name"?: string; "labels"?: string; "tags"?: string } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown> | { "runner"?: { "id"?: number; "name"?: string; "token"?: string; "queue"?: string } }>> {
    return request(config, "POST", "/api/runner/register", input ?? {}, [], {"required":false,"content":["application/json"]}, "application/json", [], options)
  },

  /**
   * POST /api/runner/report
   */
  postRunnerReport(input?: { body?: { "state"?: "succeeded" | "failed" | "cancelled"; "error"?: string } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/runner/report", input ?? {}, [], {"required":false,"content":["application/json"]}, "application/json", [], options)
  },

  /**
   * POST /api/runner/split
   */
  postRunnerSplit(input?: { body?: { "suite"?: string; "nodes"?: number; "index"?: number } }, options?: RequestOptions): Promise<ApiResult<{ "items"?: Array<string>; "estimated_ms"?: number; "unknown"?: number; "note"?: string | null }>> {
    return request(config, "POST", "/api/runner/split", input ?? {}, [], {"required":false,"content":["application/json"]}, "application/json", [], options)
  },

  /**
   * POST /api/runner/upload
   */
  postRunnerUpload(input: { body: { "steps": string } }, options?: RequestOptions): Promise<ApiResult<{ "added"?: Array<number>; "reason"?: string }>> {
    return request(config, "POST", "/api/runner/upload", input ?? {}, [], {"required":true,"content":["application/json"]}, "application/json", [], options)
  },

  /**
   * POST /api/runner/workspaces/retirable
   */
  postRunnerWorkspacesRetirable(input?: { body?: { "job_ids"?: Array<unknown> } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/runner/workspaces/retirable", input ?? {}, [], {"required":false,"content":["application/json"]}, "application/json", [], options)
  },

  /**
   * GET /api/search
   */
  getSearch(input?: { "q"?: string; "scope"?: "repositories" | "issues" | "pulls" | "users" | "code"; "page"?: number; "per_page"?: number }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/search", input ?? {}, [{"name":"q","in":"query","required":false},{"name":"scope","in":"query","required":false},{"name":"page","in":"query","required":false},{"name":"per_page","in":"query","required":false}], null, "application/json", [], options)
  },

  /**
   * GET /api/search/code
   */
  getSearchCode(input: { "q": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/search/code", input ?? {}, [{"name":"q","in":"query","required":true}], null, "application/json", [], options)
  },

  /**
   * GET /api/user
   */
  getUser(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/user", {}, [], null, "application/json", [], options)
  },

  /**
   * POST /api/user/atproto
   */
  postUserAtproto(input?: { body?: { "operation"?: "link" | "list" | "unlink"; "identifier"?: string } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/user/atproto", input ?? {}, [], {"required":false,"content":["application/json"]}, "application/json", [], options)
  },

  /**
   * POST /api/user/forge-credentials
   */
  postUserForgeCredentials(input?: { body?: { "operation"?: "connect" | "list" | "disconnect"; "host"?: string; "provider"?: "github" | "gitlab" | "gitea"; "token"?: string } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/user/forge-credentials", input ?? {}, [], {"required":false,"content":["application/json"]}, "application/json", [], options)
  },

  /**
   * POST /api/user/gpg-keys
   */
  postUserGpgKeys(input?: { body?: { "key"?: string } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/user/gpg-keys", input ?? {}, [], {"required":false,"content":["application/json"]}, "application/json", [], options)
  },

  /**
   * DELETE /api/user/gpg-keys
   */
  deleteUserGpgKeys(input?: { "id"?: number }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "DELETE", "/api/user/gpg-keys", input ?? {}, [{"name":"id","in":"query","required":false}], null, "application/json", [], options)
  },

  /**
   * POST /api/user/gpg-keys/delete
   */
  postUserGpgKeysDelete(input?: { body?: { "id"?: number } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/user/gpg-keys/delete", input ?? {}, [], {"required":false,"content":["application/json"]}, "application/json", [], options)
  },

  /**
   * POST /api/user/keys
   */
  postUserKeys(input?: { body?: { "key"?: string; "title"?: string } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/user/keys", input ?? {}, [], {"required":false,"content":["application/json"]}, "application/json", [], options)
  },

  /**
   * DELETE /api/user/keys
   */
  deleteUserKeys(input?: { "id"?: number }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "DELETE", "/api/user/keys", input ?? {}, [{"name":"id","in":"query","required":false}], null, "application/json", [], options)
  },

  /**
   * POST /api/user/keys/delete
   */
  postUserKeysDelete(input?: { body?: { "id"?: number } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/user/keys/delete", input ?? {}, [], {"required":false,"content":["application/json"]}, "application/json", [], options)
  },

  /**
   * GET /api/user/notifications
   */
  getUserNotifications(input?: { "reason"?: string; "repository"?: string; "unread"?: string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/user/notifications", input ?? {}, [{"name":"reason","in":"query","required":false},{"name":"repository","in":"query","required":false},{"name":"unread","in":"query","required":false}], null, "application/json", [], options)
  },

  /**
   * POST /api/user/notifications/mutes
   */
  postUserNotificationsMutes(input?: { body?: { "duration"?: string; "muted"?: string; "subject_id"?: unknown; "subject_type"?: string } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/user/notifications/mutes", input ?? {}, [], {"required":false,"content":["application/json"]}, "application/json", [], options)
  },

  /**
   * POST /api/user/notifications/preferences
   */
  postUserNotificationsPreferences(input?: { body?: { "channel"?: string; "delivery"?: string; "event"?: string } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/user/notifications/preferences", input ?? {}, [], {"required":false,"content":["application/json"]}, "application/json", [], options)
  },

  /**
   * POST /api/user/notifications/push
   */
  postUserNotificationsPush(input?: { body?: { "auth"?: string; "endpoint"?: string; "operation"?: string; "p256dh"?: string } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/user/notifications/push", input ?? {}, [], {"required":false,"content":["application/json"]}, "application/json", [], options)
  },

  /**
   * POST /api/user/notifications/push/test
   */
  postUserNotificationsPushTest(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/user/notifications/push/test", {}, [], null, "application/json", [], options)
  },

  /**
   * POST /api/user/notifications/read
   */
  postUserNotificationsRead(input?: { body?: { "id"?: number; "ids"?: string; "mark_all"?: unknown; "reason"?: string; "repository"?: string } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/user/notifications/read", input ?? {}, [], {"required":false,"content":["application/json"]}, "application/json", [], options)
  },

  /**
   * PUT /api/user/notifications/schedule
   */
  putUserNotificationsSchedule(input?: { body?: { "breaks_through"?: string; "days"?: number; "do_not_disturb_until"?: string; "ends_at"?: string; "starts_at"?: string; "timezone"?: string } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "PUT", "/api/user/notifications/schedule", input ?? {}, [], {"required":false,"content":["application/json"]}, "application/json", [], options)
  },

  /**
   * POST /api/user/passkeys
   */
  postUserPasskeys(input?: { body?: { "operation"?: "list" | "options" | "register" | "remove"; "id"?: unknown; "credential"?: string } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/user/passkeys", input ?? {}, [], {"required":false,"content":["application/json"]}, "application/json", [], options)
  },

  /**
   * POST /api/user/profile
   */
  postUserProfile(input?: { body?: { "handle"?: string; "website"?: string } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/user/profile", input ?? {}, [], {"required":false,"content":["application/json"]}, "application/json", [], options)
  },

  /**
   * POST /api/user/sessions
   */
  postUserSessions(input?: { body?: { "operation"?: "list" | "revoke" | "revoke-others"; "id"?: number } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/user/sessions", input ?? {}, [], {"required":false,"content":["application/json"]}, "application/json", [], options)
  },

  /**
   * GET /api/user/tokens
   */
  getUserTokens(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/user/tokens", {}, [], null, "application/json", [], options)
  },

  /**
   * POST /api/user/tokens
   */
  postUserTokens(input: { body: { "name": string; "selection"?: "all" | "organization" | "selected"; "expires_at"?: string; "organization_id"?: number; "machine_account_id"?: number; "permissions"?: Array<unknown>; "repository_ids"?: Array<unknown> } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown> | null>> {
    return request(config, "POST", "/api/user/tokens", input ?? {}, [], {"required":true,"content":["application/json"]}, "application/json", [], options)
  },

  /**
   * DELETE /api/user/tokens
   */
  deleteUserTokens(input: { "id": number; "reason"?: string }, options?: RequestOptions): Promise<ApiResult<null>> {
    return request(config, "DELETE", "/api/user/tokens", input ?? {}, [{"name":"id","in":"query","required":true},{"name":"reason","in":"query","required":false}], null, "application/json", [], options)
  },

  /**
   * POST /api/user/tokens/revoke
   */
  postUserTokensRevoke(input: { body: { "id": number; "reason"?: string } }, options?: RequestOptions): Promise<ApiResult<null>> {
    return request(config, "POST", "/api/user/tokens/revoke", input ?? {}, [], {"required":true,"content":["application/json"]}, "application/json", [], options)
  },

  /**
   * POST /api/user/tokens/rotate
   */
  postUserTokensRotate(input: { body: { "id": number; "expires_at"?: string } }, options?: RequestOptions): Promise<ApiResult<null>> {
    return request(config, "POST", "/api/user/tokens/rotate", input ?? {}, [], {"required":true,"content":["application/json"]}, "application/json", [], options)
  },

  /**
   * POST /api/user/two-factor
   */
  postUserTwoFactor(input?: { body?: { "operation"?: "status" | "begin" | "enable" | "disable" | "recovery-codes"; "code"?: string } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/user/two-factor", input ?? {}, [], {"required":false,"content":["application/json"]}, "application/json", [], options)
  },

  /**
   * GET /api/view/manifest
   */
  getViewManifest(input?: { "owner"?: string; "repo"?: string; "kind"?: string; "ref"?: string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/view/manifest", input ?? {}, [{"name":"owner","in":"query","required":false},{"name":"repo","in":"query","required":false},{"name":"kind","in":"query","required":false},{"name":"ref","in":"query","required":false}], null, "application/json", [], options)
  },

  /**
   * GET /api/view/patch
   */
  getViewPatch(input?: { "owner"?: string; "repo"?: string; "kind"?: string; "ref"?: string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/view/patch", input ?? {}, [{"name":"owner","in":"query","required":false},{"name":"repo","in":"query","required":false},{"name":"kind","in":"query","required":false},{"name":"ref","in":"query","required":false}], null, "application/json", [], options)
  },

  /**
   * GET /api/view/rows
   */
  getViewRows(input?: { "owner"?: string; "repo"?: string; "kind"?: string; "ref"?: string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/view/rows", input ?? {}, [{"name":"owner","in":"query","required":false},{"name":"repo","in":"query","required":false},{"name":"kind","in":"query","required":false},{"name":"ref","in":"query","required":false}], null, "application/json", [], options)
  },

  /**
   * GET /atproto/client-metadata.json
   */
  getAtprotoClientMetadataJson(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/atproto/client-metadata.json", {}, [], null, "application/json", [], options)
  },

  /**
   * GET /attachments/{key}
   */
  getAttachmentsKey(input: { "key": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/attachments/{key}", input ?? {}, [{"name":"key","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * GET /git/{owner}/{repository}/bundles/checkpoint
   */
  getGitOwnerRepositoryBundlesCheckpoint(input: { "owner": string; "repository": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/git/{owner}/{repository}/bundles/checkpoint", input ?? {}, [{"name":"owner","in":"path","required":true},{"name":"repository","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * POST /git/{owner}/{repository}/git-receive-pack
   */
  postGitOwnerRepositoryGitReceivePack(input: { "owner": string; "repository": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/git/{owner}/{repository}/git-receive-pack", input ?? {}, [{"name":"owner","in":"path","required":true},{"name":"repository","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * POST /git/{owner}/{repository}/git-upload-pack
   */
  postGitOwnerRepositoryGitUploadPack(input: { "owner": string; "repository": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/git/{owner}/{repository}/git-upload-pack", input ?? {}, [{"name":"owner","in":"path","required":true},{"name":"repository","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * GET /git/{owner}/{repository}/info/lfs/locks
   */
  getGitOwnerRepositoryInfoLfsLocks(input: { "owner": string; "repository": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/git/{owner}/{repository}/info/lfs/locks", input ?? {}, [{"name":"owner","in":"path","required":true},{"name":"repository","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * POST /git/{owner}/{repository}/info/lfs/locks
   */
  postGitOwnerRepositoryInfoLfsLocks(input: { "owner": string; "repository": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/git/{owner}/{repository}/info/lfs/locks", input ?? {}, [{"name":"owner","in":"path","required":true},{"name":"repository","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * POST /git/{owner}/{repository}/info/lfs/locks/verify
   */
  postGitOwnerRepositoryInfoLfsLocksVerify(input: { "owner": string; "repository": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/git/{owner}/{repository}/info/lfs/locks/verify", input ?? {}, [{"name":"owner","in":"path","required":true},{"name":"repository","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * POST /git/{owner}/{repository}/info/lfs/locks/{id}/unlock
   */
  postGitOwnerRepositoryInfoLfsLocksIdUnlock(input: { "owner": string; "repository": string; "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/git/{owner}/{repository}/info/lfs/locks/{id}/unlock", input ?? {}, [{"name":"owner","in":"path","required":true},{"name":"repository","in":"path","required":true},{"name":"id","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * POST /git/{owner}/{repository}/info/lfs/objects/batch
   */
  postGitOwnerRepositoryInfoLfsObjectsBatch(input: { "owner": string; "repository": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/git/{owner}/{repository}/info/lfs/objects/batch", input ?? {}, [{"name":"owner","in":"path","required":true},{"name":"repository","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * GET /git/{owner}/{repository}/info/lfs/objects/{oid}
   */
  getGitOwnerRepositoryInfoLfsObjectsOid(input: { "owner": string; "repository": string; "oid": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/git/{owner}/{repository}/info/lfs/objects/{oid}", input ?? {}, [{"name":"owner","in":"path","required":true},{"name":"repository","in":"path","required":true},{"name":"oid","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * PUT /git/{owner}/{repository}/info/lfs/objects/{oid}
   */
  putGitOwnerRepositoryInfoLfsObjectsOid(input: { "owner": string; "repository": string; "oid": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "PUT", "/git/{owner}/{repository}/info/lfs/objects/{oid}", input ?? {}, [{"name":"owner","in":"path","required":true},{"name":"repository","in":"path","required":true},{"name":"oid","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * POST /git/{owner}/{repository}/info/lfs/verify
   */
  postGitOwnerRepositoryInfoLfsVerify(input: { "owner": string; "repository": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/git/{owner}/{repository}/info/lfs/verify", input ?? {}, [{"name":"owner","in":"path","required":true},{"name":"repository","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * GET /git/{owner}/{repository}/info/refs
   */
  getGitOwnerRepositoryInfoRefs(input: { "owner": string; "repository": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/git/{owner}/{repository}/info/refs", input ?? {}, [{"name":"owner","in":"path","required":true},{"name":"repository","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * POST /internal/git/post-receive
   */
  postInternalGitPostReceive(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/internal/git/post-receive", {}, [], null, "application/json", [], options)
  },

  /**
   * POST /internal/git/pre-receive
   */
  postInternalGitPreReceive(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/internal/git/pre-receive", {}, [], null, "application/json", [], options)
  },

  /**
   * POST /unsubscribe/{token}
   */
  postUnsubscribeToken(input: { "token": string; body?: { "token"?: string } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/unsubscribe/{token}", input ?? {}, [{"name":"token","in":"path","required":true}], {"required":false,"content":["application/json"]}, "application/json", [], options)
  },

  /**
   * GET /{owner}/{repository}/bundles/checkpoint
   */
  getOwnerRepositoryBundlesCheckpoint(input: { "owner": string; "repository": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/{owner}/{repository}/bundles/checkpoint", input ?? {}, [{"name":"owner","in":"path","required":true},{"name":"repository","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * POST /{owner}/{repository}/git-receive-pack
   */
  postOwnerRepositoryGitReceivePack(input: { "owner": string; "repository": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/{owner}/{repository}/git-receive-pack", input ?? {}, [{"name":"owner","in":"path","required":true},{"name":"repository","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * POST /{owner}/{repository}/git-upload-pack
   */
  postOwnerRepositoryGitUploadPack(input: { "owner": string; "repository": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/{owner}/{repository}/git-upload-pack", input ?? {}, [{"name":"owner","in":"path","required":true},{"name":"repository","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * GET /{owner}/{repository}/info/lfs/locks
   */
  getOwnerRepositoryInfoLfsLocks(input: { "owner": string; "repository": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/{owner}/{repository}/info/lfs/locks", input ?? {}, [{"name":"owner","in":"path","required":true},{"name":"repository","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * POST /{owner}/{repository}/info/lfs/locks
   */
  postOwnerRepositoryInfoLfsLocks(input: { "owner": string; "repository": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/{owner}/{repository}/info/lfs/locks", input ?? {}, [{"name":"owner","in":"path","required":true},{"name":"repository","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * POST /{owner}/{repository}/info/lfs/locks/verify
   */
  postOwnerRepositoryInfoLfsLocksVerify(input: { "owner": string; "repository": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/{owner}/{repository}/info/lfs/locks/verify", input ?? {}, [{"name":"owner","in":"path","required":true},{"name":"repository","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * POST /{owner}/{repository}/info/lfs/locks/{id}/unlock
   */
  postOwnerRepositoryInfoLfsLocksIdUnlock(input: { "owner": string; "repository": string; "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/{owner}/{repository}/info/lfs/locks/{id}/unlock", input ?? {}, [{"name":"owner","in":"path","required":true},{"name":"repository","in":"path","required":true},{"name":"id","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * POST /{owner}/{repository}/info/lfs/objects/batch
   */
  postOwnerRepositoryInfoLfsObjectsBatch(input: { "owner": string; "repository": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/{owner}/{repository}/info/lfs/objects/batch", input ?? {}, [{"name":"owner","in":"path","required":true},{"name":"repository","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * GET /{owner}/{repository}/info/lfs/objects/{oid}
   */
  getOwnerRepositoryInfoLfsObjectsOid(input: { "owner": string; "repository": string; "oid": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/{owner}/{repository}/info/lfs/objects/{oid}", input ?? {}, [{"name":"owner","in":"path","required":true},{"name":"repository","in":"path","required":true},{"name":"oid","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * PUT /{owner}/{repository}/info/lfs/objects/{oid}
   */
  putOwnerRepositoryInfoLfsObjectsOid(input: { "owner": string; "repository": string; "oid": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "PUT", "/{owner}/{repository}/info/lfs/objects/{oid}", input ?? {}, [{"name":"owner","in":"path","required":true},{"name":"repository","in":"path","required":true},{"name":"oid","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * POST /{owner}/{repository}/info/lfs/verify
   */
  postOwnerRepositoryInfoLfsVerify(input: { "owner": string; "repository": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/{owner}/{repository}/info/lfs/verify", input ?? {}, [{"name":"owner","in":"path","required":true},{"name":"repository","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * GET /{owner}/{repository}/info/refs
   */
  getOwnerRepositoryInfoRefs(input: { "owner": string; "repository": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/{owner}/{repository}/info/refs", input ?? {}, [{"name":"owner","in":"path","required":true},{"name":"repository","in":"path","required":true}], null, "application/json", [], options)
  },
  }
}
export type Client = ReturnType<typeof createClient>

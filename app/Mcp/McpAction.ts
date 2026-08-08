import { Action } from '@stacksjs/actions'
import { dispatch, fail, RPC, type ApiCaller } from './server'

/**
 * The MCP endpoint.
 *
 * One POST that speaks JSON-RPC. Self-hostable by construction: it is part of
 * the instance, so running one is running the forge, and there is nothing extra
 * to deploy or to give a credential to.
 *
 * **The token comes from the Authorization header and goes nowhere else.** It
 * is not stored, not logged, and not consulted here - it is handed to the API
 * call and that is the end of this file's involvement with it. The one thing
 * this endpoint does check is that there *is* one, because an unauthenticated
 * MCP connection would otherwise reach every public repository as a stranger
 * and read as though it were working.
 */
export default new Action({
  name: 'Mcp',
  description: 'Model Context Protocol endpoint for the review surface',
  method: 'POST',

  async handle(request: any) {
    const token = bearerFrom(request)

    if (!token) {
      /*
       * A JSON-RPC error rather than a 401 body, because a client that spoke
       * JSON-RPC deserves an answer in it - and a bare 401 leaves an MCP client
       * reporting "the server returned invalid JSON", which sends somebody
       * looking for a parsing bug.
       */
      return response.json(
        fail(null, RPC.invalidRequest, 'An access token is required. Send it as Authorization: Bearer <token>.'),
        401,
      )
    }

    /*
     * The raw bytes, parsed here rather than read from `request.all()`.
     *
     * `all()` merges the query string over the parsed body into one object,
     * which is right for a form and wrong for JSON-RPC twice over: a batch is
     * a top-level *array* and would arrive as an object with numeric keys, and
     * a query parameter could overwrite `method`. `request.body` is the
     * `Request` stream, not the payload - reaching for it is the mistake that
     * produced "jsonrpc must be 2.0" for a request that plainly said so.
     */
    let body: any
    try {
      const raw = await request.rawBody?.()
      body = raw ? JSON.parse(raw) : (request.jsonBody ?? {})
    }
    catch {
      return response.json(fail(null, RPC.parseError, 'the request body is not JSON'), 400)
    }

    /*
     * A batch is an array, and it is answered as one.
     *
     * Notifications inside a batch produce no entry, so a batch of only
     * notifications answers with nothing at all rather than with `[]` - which
     * is what the specification requires and what a strict client checks.
     */
    if (Array.isArray(body)) {
      const answers = []
      for (const entry of body) {
        const answer = await dispatch(entry, { token, call: callOwnApi(request) })
        if (answer)
          answers.push(answer)
      }

      return answers.length > 0 ? response.json(answers) : new Response(null, { status: 204 })
    }

    const answer = await dispatch(body, { token, call: callOwnApi(request) })

    // Same rule for a lone notification: no id, no reply.
    return answer ? response.json(answer) : new Response(null, { status: 204 })
  },
})

/** The bearer token, or null. */
function bearerFrom(request: any): string | null {
  const header = String(
    request.header?.('authorization') ?? request.headers?.get?.('authorization') ?? '',
  ).trim()

  const match = /^Bearer\s+(.+)$/i.exec(header)

  return match?.[1] ? match[1].trim() : null
}

/**
 * Call this instance's own API.
 *
 * The origin comes from the incoming request rather than from configuration,
 * so an instance behind a proxy, on a custom port, or under a path prefix
 * reaches itself without being told where it lives. The alternative -
 * `http://localhost:3000` - is right until the first deployment that is not
 * that, and then it is wrong in a way that only shows up in production.
 */
function callOwnApi(request: any): ApiCaller {
  const origin = originOf(request)

  return async ({ method, path, query, body, token }) => {
    const url = new URL(path, origin)
    for (const [key, value] of Object.entries(query))
      url.searchParams.set(key, value)

    const answer = await fetch(url, {
      method,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        // Asked for as JSON explicitly. Several endpoints here answer a browser
        // with a redirect when `Accept` says HTML, and a redirect is not a tool
        // result.
        'Accept': 'application/json',
      },
      ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
    })

    const text = await answer.text()

    let parsed: unknown = text
    try {
      parsed = JSON.parse(text)
    }
    catch {
      // Left as text. An endpoint that answered with something other than JSON
      // is worth showing the model verbatim rather than replacing with a parse
      // error that hides what it said.
    }

    return { status: answer.status, body: parsed }
  }
}

function originOf(request: any): string {
  const raw = String(request.url ?? '')

  try {
    return new URL(raw).origin
  }
  catch {
    const host = String(request.header?.('host') ?? request.headers?.get?.('host') ?? 'localhost')

    return `http://${host}`
  }
}

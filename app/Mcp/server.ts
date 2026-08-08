import type { ToolDefinition } from './tools'
import { checkArguments, publicToolList, splitArguments, toolByName } from './tools'

/**
 * The MCP server, as a request handler.
 *
 * JSON-RPC 2.0 over HTTP rather than stdio, because this one is *hosted*: it
 * runs alongside the instance and is reached over the network by whichever
 * agent holds a token. A stdio server would have to run on the agent's machine
 * with a credential sitting in its environment, which is the deployment this
 * design exists to avoid.
 *
 * **Nothing here decides permissions.** Every tool call becomes an HTTP request
 * to this instance's own API carrying the caller's token, and whatever comes
 * back is relayed. That is not laziness - it is the only arrangement in which
 * "the agent gets exactly the token's permissions and nothing that leaks from
 * the server process" is a property rather than a promise.
 */

/** A JSON-RPC request, as far as this cares. */
export interface RpcRequest {
  jsonrpc?: string
  id?: string | number | null
  method?: string
  params?: Record<string, unknown>
}

export interface RpcResponse {
  jsonrpc: '2.0'
  id: string | number | null
  result?: unknown
  error?: { code: number, message: string }
}

/** The JSON-RPC codes this uses, which are the standard ones. */
export const RPC = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
} as const

export function ok(id: string | number | null, result: unknown): RpcResponse {
  return { jsonrpc: '2.0', id, result }
}

export function fail(id: string | number | null, code: number, message: string): RpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } }
}

/** What the server says it can do. */
export const SERVER_INFO = {
  name: 'reviewos',
  version: '1',
} as const

/**
 * How a tool call reaches the API.
 *
 * Injected so the dispatcher can be tested without a server, and so the
 * self-hosted deployment can point it at its own origin rather than guessing
 * one from a request header - which is how an instance behind a proxy ends up
 * calling `http://localhost` and getting the wrong thing, or calling a hostname
 * an attacker set.
 */
export interface ApiCaller {
  (input: {
    method: 'GET' | 'POST'
    path: string
    query: Record<string, string>
    body: Record<string, unknown>
    token: string
  }): Promise<{ status: number, body: unknown }>
}

/**
 * Answer one JSON-RPC request.
 *
 * `token` is whatever authenticated the connection. There is no path through
 * this function that reaches the API without it.
 */
export async function dispatch(
  request: RpcRequest,
  context: { token: string, call: ApiCaller },
): Promise<RpcResponse | null> {
  const id = request?.id ?? null

  if (request?.jsonrpc !== '2.0')
    return fail(id, RPC.invalidRequest, 'jsonrpc must be "2.0"')

  switch (request.method) {
    case 'initialize':
      return ok(id, {
        protocolVersion: '2024-11-05',
        // Tools only. No resources and no prompts, because advertising a
        // capability this does not implement means a client calls it and gets
        // a method-not-found it had every reason not to expect.
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      })

    case 'notifications/initialized':
      /*
       * A notification, not a request: it carries no id and MUST NOT be
       * answered. Returning even an empty response to one is the mistake that
       * makes a strict client hang up, because it is now reading a reply to
       * something it never asked about.
       */
      return null

    case 'tools/list':
      return ok(id, { tools: publicToolList() })

    case 'tools/call':
      return await callTool(id, request.params ?? {}, context)

    case 'ping':
      return ok(id, {})

    default:
      return fail(id, RPC.methodNotFound, `unknown method: ${request.method ?? '(none)'}`)
  }
}

async function callTool(
  id: string | number | null,
  params: Record<string, unknown>,
  context: { token: string, call: ApiCaller },
): Promise<RpcResponse> {
  const name = String(params.name ?? '')
  const tool = toolByName(name)

  if (!tool)
    return fail(id, RPC.invalidParams, `unknown tool: ${name || '(none)'}`)

  const args = (params.arguments ?? {}) as Record<string, unknown>

  const checked = checkArguments(tool, args)
  if (!checked.ok)
    return fail(id, RPC.invalidParams, checked.problem)

  const { query, body } = splitArguments(tool, args)

  let answer: { status: number, body: unknown }
  try {
    answer = await context.call({
      method: tool.call.method,
      path: tool.call.path,
      query,
      body,
      token: context.token,
    })
  }
  catch (error) {
    return fail(id, RPC.internal, error instanceof Error ? error.message : String(error))
  }

  return ok(id, toolResult(answer, tool))
}

/**
 * The API's answer, as MCP expects a tool result.
 *
 * **A refusal comes back as `isError` with the API's own message, not as a
 * JSON-RPC error.** The distinction matters more than it looks: a JSON-RPC
 * error is a *protocol* failure and most clients surface it to the operator
 * rather than to the model, so a model that asked about a repository it cannot
 * read would be told nothing and would try again. `isError` puts the refusal in
 * front of the model, in words, which is the only way it learns to stop asking.
 */
export function toolResult(answer: { status: number, body: unknown }, tool: ToolDefinition): unknown {
  const failed = answer.status >= 400

  const text = typeof answer.body === 'string'
    ? answer.body
    : JSON.stringify(answer.body, null, 2)

  return {
    isError: failed,
    content: [{
      type: 'text',
      text: failed
        // Prefixed with the tool and the status, because a model reading three
        // tool results in one turn needs to know which one refused.
        ? `${tool.name} failed (${answer.status}): ${text}`
        : text,
    }],
  }
}

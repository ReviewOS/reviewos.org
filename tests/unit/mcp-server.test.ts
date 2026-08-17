/**
 * The MCP server: the review surface as tools an agent can call.
 *
 * The property worth testing hardest is the one the design exists for: **there
 * is no path through this that reaches the API without the caller's token.**
 * Not "the token is checked" - there is nothing here to check it, because the
 * server holds no credential of its own and every tool call is the API being
 * asked, by the caller, through this.
 *
 * So most of these assert on what gets *sent*, not on what comes back. What
 * comes back is the API's business and is tested where the API is.
 */

import { describe, expect, it } from 'bun:test'
import { dispatch, RPC, toolResult } from '../../app/Mcp/server'
import { checkArguments, publicToolList, splitArguments, toolByName, TOOLS } from '../../app/Mcp/tools'

/** A caller that records what it was asked to do and answers 200. */
function recorder(answer: { status: number, body: unknown } = { status: 200, body: { ok: true } }) {
  const calls: any[] = []

  return {
    calls,
    call: async (input: any) => {
      calls.push(input)
      return answer
    },
  }
}

const context = (over: Partial<{ token: string, call: any }> = {}) => ({
  token: 'tok_abc',
  call: recorder().call,
  ...over,
})

describe('the handshake', () => {
  it('advertises tools and nothing it does not implement', async () => {
    /*
     * No resources and no prompts. Advertising a capability this does not
     * implement means a client calls it and gets a method-not-found it had
     * every reason not to expect.
     */
    const answer = await dispatch({ jsonrpc: '2.0', id: 1, method: 'initialize' }, context())

    expect((answer as any).result.capabilities).toEqual({ tools: {} })
    expect((answer as any).result.serverInfo.name).toBe('reviewos')
  })

  it('does not answer the initialized notification', async () => {
    // A notification carries no id and MUST NOT be answered. Replying to one is
    // what makes a strict client hang up: it is now reading a reply to
    // something it never asked about.
    expect(await dispatch({ jsonrpc: '2.0', method: 'notifications/initialized' }, context())).toBeNull()
  })

  it('refuses a request that is not JSON-RPC 2.0', async () => {
    const answer = await dispatch({ id: 1, method: 'ping' } as any, context())

    expect((answer as any).error.code).toBe(RPC.invalidRequest)
  })

  it('says so for a method it does not have', async () => {
    const answer = await dispatch({ jsonrpc: '2.0', id: 1, method: 'resources/list' }, context())

    expect((answer as any).error.code).toBe(RPC.methodNotFound)
  })
})

describe('the tool list', () => {
  it('never publishes how a tool reaches the API', () => {
    /*
     * Publishing the path invites a client to bypass the tool and call it
     * directly - which would work, would break when the path changed, and would
     * be this server's fault for having advertised it.
     */
    for (const tool of publicToolList())
      expect((tool as any).call).toBeUndefined()
  })

  it('describes every tool it lists', () => {
    // The description is the entire interface a model has. An empty one is a
    // tool it will never choose correctly.
    for (const tool of publicToolList()) {
      expect(tool.description.length).toBeGreaterThan(40)
      expect(tool.inputSchema.type).toBe('object')
    }
  })

  it('offers no tool without an endpoint behind it', () => {
    /*
     * `read_check_output` was written and removed: checks are phase 9 and there
     * is nothing to expose. A model handed a tool that always 404s does not
     * conclude the tool is broken - it concludes the task is impossible and
     * gives up on the whole line of work.
     */
    expect(TOOLS.map(tool => tool.name)).not.toContain('read_check_output')
  })

  it('and every path it does offer is a route this instance actually serves', async () => {
    /*
     * The general form of the same rule. A tool whose path was renamed, or
     * written from memory, always 404s - and a model handed one of those does
     * not conclude the tool is broken, it concludes the task is impossible and
     * abandons the line of work.
     *
     * Checked against the route file rather than against a list here, so
     * moving an endpoint fails this test instead of silently breaking agents.
     */
    const routes = await Bun.file('routes/api.ts').text()

    for (const tool of TOOLS) {
      const path = tool.call.path.replace(/^\/api/, '')
      const declared = new RegExp(`route\\.${tool.call.method.toLowerCase()}\\('${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`)

      expect({ tool: tool.name, served: declared.test(routes) }).toEqual({ tool: tool.name, served: true })
    }
  })
})

describe('calling a tool', () => {
  it('sends the caller\'s token, always', async () => {
    // The property the whole design exists for. There is no branch here that
    // reaches the API without it, because the server has no credential to fall
    // back to.
    const api = recorder()

    await dispatch({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'list_review_queue', arguments: {} },
    }, context({ call: api.call }))

    expect(api.calls[0].token).toBe('tok_abc')
  })

  it('puts query arguments in the query and body arguments in the body', async () => {
    /*
     * A GET with a body is a request most intermediaries drop silently, and a
     * POST whose fields ended up in the URL is a comment body in an access log.
     */
    const api = recorder()

    await dispatch({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'read_pull_request_diff',
        arguments: { owner: 'acme', repo: 'api', number: 12, path: 'src/a.ts' },
      },
    }, context({ call: api.call }))

    expect(api.calls[0].method).toBe('GET')
    expect(api.calls[0].query).toEqual({ owner: 'acme', repo: 'api', number: '12', path: 'src/a.ts' })
    expect(api.calls[0].body).toEqual({})
  })

  it('and the reverse for a write', async () => {
    const api = recorder()

    await dispatch({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'submit_review',
        arguments: { owner: 'acme', repo: 'api', number: 12, state: 'approved', body: 'looks good' },
      },
    }, context({ call: api.call }))

    expect(api.calls[0].method).toBe('POST')
    expect(api.calls[0].body.state).toBe('approved')
    expect(api.calls[0].body.body).toBe('looks good')
  })

  it('refuses an unknown tool without calling anything', async () => {
    const api = recorder()

    const answer = await dispatch({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'delete_everything', arguments: {} },
    }, context({ call: api.call }))

    expect((answer as any).error.code).toBe(RPC.invalidParams)
    expect(api.calls).toHaveLength(0)
  })

  it('catches a missing argument before spending a request on it', async () => {
    // So the failure reads as "you left out number" rather than as a 422 the
    // model has to interpret.
    const api = recorder()

    const answer = await dispatch({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'read_pull_request', arguments: { owner: 'acme', repo: 'api' } },
    }, context({ call: api.call }))

    expect((answer as any).error.message).toContain('number')
    expect(api.calls).toHaveLength(0)
  })
})

describe('when the API refuses', () => {
  it('reports it to the model rather than to the operator', async () => {
    /*
     * The distinction that matters. A JSON-RPC error is a *protocol* failure and
     * most clients surface it to the operator, not the model - so a model that
     * asked about a repository it cannot read would be told nothing and would
     * try again. `isError` puts the refusal in front of the model, in words,
     * which is the only way it learns to stop asking.
     */
    const api = recorder({ status: 404, body: { error: 'No such pull request' } })

    const answer = await dispatch({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'read_pull_request', arguments: { owner: 'a', repo: 'b', number: 1 } },
    }, context({ call: api.call }))

    // Not a JSON-RPC error.
    expect((answer as any).error).toBeUndefined()
    expect((answer as any).result.isError).toBe(true)
    expect((answer as any).result.content[0].text).toContain('No such pull request')
  })

  it('names the tool and the status, for a turn that called three', async () => {
    const result: any = toolResult({ status: 403, body: { error: 'Forbidden' } }, toolByName('submit_review')!)

    expect(result.content[0].text).toContain('submit_review')
    expect(result.content[0].text).toContain('403')
  })

  it('relays a refusal unchanged, because it is the API failing rather than this', async () => {
    // There is no second permission check here to disagree with the first one,
    // because there is no first one here at all - a tool call against a
    // repository the token cannot read fails exactly as the API does.
    const api = recorder({ status: 404, body: { error: 'No such pull request' } })

    const answer = await dispatch({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'read_pull_request_diff', arguments: { owner: 'a', repo: 'private', number: 1 } },
    }, context({ call: api.call }))

    // The 404 the API gives a stranger, verbatim: no "forbidden", which would
    // confirm the repository exists.
    expect((answer as any).result.content[0].text).toContain('404')
    expect((answer as any).result.content[0].text).not.toContain('Forbidden')
  })

  it('turns a transport failure into a protocol error, which it genuinely is', async () => {
    const answer = await dispatch({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'list_review_queue', arguments: {} },
    }, context({ call: async () => { throw new Error('connection refused') } }))

    expect((answer as any).error.code).toBe(RPC.internal)
  })
})

describe('argument checking', () => {
  it('accepts a value inside a declared enum', () => {
    const tool = toolByName('submit_review')!

    expect(checkArguments(tool, { owner: 'a', repo: 'b', number: 1, state: 'approved' })).toEqual({ ok: true })
  })

  it('and refuses one outside it, naming the choices', () => {
    const tool = toolByName('submit_review')!
    const checked = checkArguments(tool, { owner: 'a', repo: 'b', number: 1, state: 'lgtm' })

    expect(checked.ok).toBe(false)
    expect((checked as any).problem).toContain('approved')
  })

  it('drops arguments that were not sent rather than sending empty ones', () => {
    // `path=` on a diff request means "the file called empty string", which
    // matches nothing - quite different from not filtering.
    const tool = toolByName('read_pull_request_diff')!
    const { query } = splitArguments(tool, { owner: 'a', repo: 'b', number: 1, path: undefined })

    expect('path' in query).toBe(false)
  })
})

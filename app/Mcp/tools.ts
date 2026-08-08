/**
 * The review surface, as tools an agent can call.
 *
 * **Every tool is a call to this instance's own public API, carrying the token
 * the MCP connection authenticated with.** That is the whole design, and it is
 * what makes two of this phase's requirements true by construction rather than
 * by vigilance:
 *
 * - *No ambient authority.* The server process holds no credential. It cannot
 *   read a repository the caller could not read, because it has nothing to read
 *   it with - the only credential in play arrived with the connection.
 * - *Fails the same way the API does.* Not "fails similarly": it **is** the API
 *   failing, relayed. There is no second permission check here to disagree with
 *   the first one, because there is no first one here at all.
 *
 * The cost is an HTTP round trip to ourselves per call. Worth it: the
 * alternative is calling the actions directly, which means this file re-derives
 * which token may do what - and a second implementation of that is the one bug
 * in this codebase that would matter most.
 *
 * Read tools return the *structured* diff. An agent handed HTML has to parse it
 * back into hunks, which is a parser it should never have had to write.
 */

/** A tool, in the shape MCP's `tools/list` wants. */
export interface ToolDefinition {
  name: string
  description: string
  inputSchema: {
    type: 'object'
    properties: Record<string, unknown>
    required?: string[]
  }
  /** How the call reaches the API. Not sent to the client. */
  call: {
    method: 'GET' | 'POST'
    path: string
    /** Arguments that go in the query string rather than the body. */
    query?: string[]
  }
}

const repository = {
  owner: { type: 'string', description: 'The user or organization that owns the repository' },
  repo: { type: 'string', description: 'The repository name' },
}

/**
 * The tools, and deliberately only these.
 *
 * Scoped to what a reviewing agent does: find what is waiting, read it, say
 * something about it. Not the whole API - a tool list is a menu, and a menu with
 * two hundred entries costs the model context on every single call while
 * making the six that matter harder to find.
 *
 * Anything absent is still reachable through the HTTP API. This is a curated
 * surface, not a gate.
 */
export const TOOLS: ToolDefinition[] = [
  {
    name: 'list_review_queue',
    description:
      'Pull requests waiting on you: review requested, changes you asked for that have been '
      + 'addressed, and your own that are approved and mergeable. This is the "what should I look '
      + 'at" question, already ordered.',
    inputSchema: { type: 'object', properties: {} },
    call: { method: 'GET', path: '/api/reviews/queue' },
  },
  {
    name: 'read_pull_request',
    description:
      'One pull request: title, body, state, author, branches, and its review state. Does not '
      + 'include the diff - ask for that separately, because it is usually the larger half.',
    inputSchema: {
      type: 'object',
      properties: {
        ...repository,
        number: { type: 'integer', description: 'The pull request number' },
      },
      required: ['owner', 'repo', 'number'],
    },
    call: { method: 'GET', path: '/api/repos/pulls/show', query: ['owner', 'repo', 'number'] },
  },
  {
    name: 'read_pull_request_diff',
    description:
      'The diff as structured data: files, hunks, and every line with its origin (added, removed, '
      + 'context) and its line number on both sides. Pass `path` for one file. Never HTML.',
    inputSchema: {
      type: 'object',
      properties: {
        ...repository,
        number: { type: 'integer', description: 'The pull request number' },
        path: { type: 'string', description: 'Limit to one file' },
        per_page: { type: 'integer', description: 'Files per page, up to 100' },
        offset: { type: 'integer', description: 'Files to skip, for paging a large diff' },
      },
      required: ['owner', 'repo', 'number'],
    },
    call: {
      method: 'GET',
      path: '/api/repos/pulls/diff/structured',
      query: ['owner', 'repo', 'number', 'path', 'per_page', 'offset'],
    },
  },
  {
    name: 'comment_on_line',
    description:
      'Leave one comment anchored to a file and line. Use the line numbers from '
      + 'read_pull_request_diff: `new_line` for the proposed version (side "right"), `old_line` for '
      + 'the version being replaced (side "left").',
    inputSchema: {
      type: 'object',
      properties: {
        ...repository,
        number: { type: 'integer' },
        path: { type: 'string', description: 'The file the comment is about' },
        line: { type: 'integer', description: 'The line number on the chosen side' },
        side: { type: 'string', enum: ['left', 'right'], description: 'Defaults to right' },
        body: { type: 'string', description: 'The comment, in markdown' },
      },
      required: ['owner', 'repo', 'number', 'path', 'line', 'body'],
    },
    call: { method: 'POST', path: '/api/repos/pulls/comments' },
  },
  {
    name: 'submit_review',
    description:
      'Submit a whole review at once: a verdict plus any number of line comments, atomically. '
      + 'Prefer this over calling comment_on_line repeatedly - twelve round trips is twelve chances '
      + 'to leave half a review behind.',
    inputSchema: {
      type: 'object',
      properties: {
        ...repository,
        number: { type: 'integer' },
        state: {
          type: 'string',
          enum: ['approved', 'changes_requested', 'commented'],
          description: 'The verdict. You cannot approve your own pull request.',
        },
        body: { type: 'string', description: 'The overall remark' },
        comments: {
          type: 'array',
          description: 'Line comments, written with the verdict or not at all',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string' },
              line: { type: 'integer' },
              side: { type: 'string', enum: ['left', 'right'] },
              body: { type: 'string' },
            },
            required: ['path', 'line', 'body'],
          },
        },
      },
      required: ['owner', 'repo', 'number', 'state'],
    },
    call: { method: 'POST', path: '/api/repos/pulls/reviews' },
  },
]

/*
 * `read_check_output` is deliberately absent.
 *
 * The roadmap asks for it and there is no endpoint behind it: checks are phase
 * 9, which is barely started. Shipping the tool anyway would advertise a
 * capability that answers 404 - and a model handed a tool that always fails
 * does not conclude the tool is broken, it concludes the *task* is impossible
 * and gives up on the whole line of work.
 *
 * An absent tool is a capability an agent works around. A broken one is a
 * capability it stops trusting. The box stays unticked until phase 9 has
 * something to expose.
 */

/** A tool by name, or null. */
export function toolByName(name: string): ToolDefinition | null {
  return TOOLS.find(tool => tool.name === name) ?? null
}

/**
 * What `tools/list` sends: the schema, never the routing.
 *
 * `call` is stripped deliberately. It is this server's business how a tool
 * reaches the API, and publishing it invites a client to bypass the tool and
 * call the path itself - which would work, and would then break when the path
 * changed, and would be this server's fault for having advertised it.
 */
export function publicToolList(): Array<Omit<ToolDefinition, 'call'>> {
  /*
   * Built by naming what goes out, rather than by spreading and removing
   * `call`. The two are equivalent today and stop being equivalent the moment
   * `ToolDefinition` grows another internal field: a spread publishes it, and
   * an allow-list leaves it out until somebody decides otherwise.
   */
  return TOOLS.map(tool => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  }))
}

/**
 * Split arguments into a query string and a body, per the tool's declaration.
 *
 * A GET with a body is a request most intermediaries drop silently, and a POST
 * whose fields ended up in the URL is a comment body in an access log. The tool
 * declares which of its arguments are which, so neither happens by accident.
 */
export function splitArguments(
  tool: ToolDefinition,
  args: Record<string, unknown>,
): { query: Record<string, string>, body: Record<string, unknown> } {
  const query: Record<string, string> = {}
  const body: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(args ?? {})) {
    if (value === undefined || value === null)
      continue

    if (tool.call.query?.includes(key)) {
      query[key] = String(value)
      continue
    }

    body[key] = value
  }

  return { query, body }
}

/**
 * Whether the arguments satisfy the tool's schema, as far as a model gets wrong.
 *
 * Only the two things models actually get wrong - a missing required field, and
 * a value outside a declared `enum` - rather than a full JSON Schema validator.
 * The API validates properly on the other side; this exists so the failure comes
 * back as "you left out `number`" instead of as a 422 the model has to interpret.
 */
export function checkArguments(
  tool: ToolDefinition,
  args: Record<string, unknown>,
): { ok: true } | { ok: false, problem: string } {
  for (const field of tool.inputSchema.required ?? []) {
    const value = (args ?? {})[field]

    if (value === undefined || value === null || value === '')
      return { ok: false, problem: `${field} is required` }
  }

  for (const [field, schema] of Object.entries(tool.inputSchema.properties)) {
    const allowed = (schema as any)?.enum as string[] | undefined
    const value = (args ?? {})[field]

    if (allowed && value !== undefined && value !== null && !allowed.includes(String(value)))
      return { ok: false, problem: `${field} must be one of ${allowed.join(', ')}` }
  }

  return { ok: true }
}

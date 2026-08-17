import { Action } from '@stacksjs/actions'
import { schema } from '@stacksjs/validation'
import { RATE_LIMIT_HEADERS } from './documented'

/**
 * A small GitHub-shaped surface at `GITHUB_API_URL`, for the actions people
 * already run.
 *
 * The ecosystem's actions do not read this instance's API reference. They build
 * `${GITHUB_API_URL}/repos/{owner}/{repo}/check-runs`, post what Octokit sends,
 * and an instance that answers 404 to that is one where `actions/github-script`,
 * every "report status" action and every annotation wrapper fails - with an
 * error about a URL, which reads as "this forge is broken" rather than "this
 * forge is different".
 *
 * **Three endpoints, deliberately, not the API.** GitHub's whole surface is not
 * a thing to reimplement, and a layer that half-implements two hundred
 * endpoints is worse than one that implements three and says so: the first
 * fails at a random depth inside somebody's action, the second fails at the
 * call with a message naming what exists.
 *
 * The three are what CI *writes* - a check run, a commit status, a comment.
 * What an action reads it already has: the event payload, the environment and
 * the checkout.
 *
 * **Every call is this instance's own API, called with the caller's token**,
 * which is the shape `app/Mcp/tools.ts` uses and for the same reason: there is
 * no second permission check here to disagree with the first, because there is
 * no first one here at all. A workflow whose `permissions:` did not ask for the
 * write gets the ordinary refusal from the ordinary gate.
 */
export default new Action({
  name: 'GitHubCompat',
  description: 'GitHub-shaped check runs, statuses and comments, for actions written against GITHUB_API_URL',
  method: 'POST',

  validations: {
    owner: { rule: schema.string() },
    repo: { rule: schema.string() },
    resource: { rule: schema.string() },
    sha: { rule: schema.string() },
    number: { rule: schema.number() },
  },

  responses: {
    201: { description: 'Created, in the shape Octokit expects: an id and the fields it sent back.' },
    401: { description: 'No credential, or one this instance does not recognise.' },
    404: { description: 'No such repository, or a resource this surface does not implement - the body names the three that exist.' },
    422: { description: 'Missing something GitHub would require too: `head_sha`, `state`, or `body`.' },
  },

  responseHeaders: RATE_LIMIT_HEADERS,

  async handle(request: any) {
    /*
     * From the path, not from a parameter.
     *
     * Three routes reach this action and only one of them has a `{resource}`
     * placeholder - the other two spell the resource out, because that is how
     * GitHub's URLs are shaped. Reading the parameter meant `statuses` and
     * `comments` arrived with an empty resource and got the "not implemented"
     * answer, from an action that implements them.
     */
    const resource = resourceOf(request)
    const owner = String(request.get('owner') ?? '')
    const repo = String(request.get('repo') ?? '')
    const token = bearerOf(request)

    if (!token)
      return response.json({ message: 'Requires authentication' }, 401)

    if (resource === 'check-runs') {
      const sha = String(request.get('head_sha') ?? request.get('sha') ?? '')

      if (!sha)
        return response.json({ message: 'Invalid request.\n\n"head_sha" wasn\'t supplied.' }, 422)

      const output = asRecord(request.get('output'))

      /*
       * Octokit's shape onto this instance's, which is mostly a rename:
       * `status` and `conclusion` mean the same things, `output.title` and
       * `output.summary` are the two fields a check page shows, and the
       * annotations are the findings that land on the diff.
       */
      const answer = await callSelf(request, '/api/repos/checks', token, {
        owner,
        repository: repo,
        sha,
        kind: 'check_run',
        name: String(request.get('name') ?? 'check'),
        status: String(request.get('status') ?? 'completed'),
        conclusion: request.get('conclusion') ?? null,
        details_url: request.get('details_url') ?? null,
        external_id: request.get('external_id') ?? null,
        started_at: request.get('started_at') ?? null,
        completed_at: request.get('completed_at') ?? null,
        title: output?.title ?? null,
        summary: output?.summary ?? null,
        annotations: Array.isArray(output?.annotations) ? output.annotations : [],
      })

      if (answer.status >= 400)
        return response.json({ message: messageOf(answer.body) }, answer.status)

      const body = asRecord(answer.body) ?? {}

      return response.json({
        id: Number(body.id ?? 0),
        head_sha: sha,
        name: String(request.get('name') ?? 'check'),
        status: String(request.get('status') ?? 'completed'),
        conclusion: request.get('conclusion') ?? null,
        html_url: `${origin(request)}/${owner}/${repo}/commit/${sha}`,
      }, 201)
    }

    if (resource === 'statuses') {
      const sha = String(request.get('sha') ?? pathTail(request))
      const state = String(request.get('state') ?? '')

      if (!sha || !state)
        return response.json({ message: 'Invalid request.\n\n"state" wasn\'t supplied.' }, 422)

      const answer = await callSelf(request, '/api/repos/checks', token, {
        owner,
        repository: repo,
        sha,
        kind: 'status',
        context: String(request.get('context') ?? 'default'),
        /*
         * GitHub's vocabulary is `error|failure|pending|success`, and `error`
         * has no equivalent here - both mean the commit did not pass, and
         * inventing a third state to preserve a distinction nothing acts on
         * would be compatibility as decoration.
         */
        state: state === 'error' ? 'failure' : state,
        target_url: request.get('target_url') ?? null,
        description: request.get('description') ?? null,
      })

      if (answer.status >= 400)
        return response.json({ message: messageOf(answer.body) }, answer.status)

      const body = asRecord(answer.body) ?? {}

      return response.json({ id: Number(body.id ?? 0), state, context: String(request.get('context') ?? 'default'), sha }, 201)
    }

    if (resource === 'comments') {
      const number = Number(request.get('number') ?? numberInPath(request))
      const text = String(request.get('body') ?? '').trim()

      if (!text)
        return response.json({ message: 'Invalid request.\n\n"body" wasn\'t supplied.' }, 422)

      /*
       * One call, because this instance's own comment endpoint already serves
       * both: issues and pull requests share a table here, which is what makes
       * `#12` resolve either way - and it is why GitHub's habit of numbering
       * them together translates cleanly rather than needing a guess.
       */
      const answer = await callSelf(request, '/api/repos/issues/comments', token, {
        owner,
        repo,
        number,
        body: text,
      })

      if (answer.status >= 400)
        return response.json({ message: messageOf(answer.body) }, answer.status)

      const body = asRecord(answer.body) ?? {}

      return response.json({ id: Number(body.id ?? body.comment?.id ?? 0), body: text }, 201)
    }

    /*
     * Everything else, with the list rather than a bare 404.
     *
     * An action that gets "Not Found" from an API it believes in retries,
     * blames the token, and eventually blames the forge. One that is told the
     * three endpoints that exist has been told what to do next.
     */
    return response.json({
      message: `This instance implements a small GitHub-compatible surface: check-runs, statuses, and issue comments. \`${resource || '(nothing)'}\` is not part of it.`,
      documentation_url: `${origin(request)}/docs/api`,
    }, 404)
  },
})

/**
 * Call this instance's own API, carrying the caller's credential.
 *
 * A round trip to ourselves per call, which is the same cost `app/Mcp/tools.ts`
 * accepts for the same reason: the alternative is a second implementation of
 * who may write what, and the two would eventually disagree in the direction
 * that matters.
 */
async function callSelf(
  request: any,
  path: string,
  token: string,
  body: Record<string, unknown>,
): Promise<{ status: number, body: unknown }> {
  try {
    const answer = await fetch(`${origin(request)}${path}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify(body),
    })

    return { status: answer.status, body: await answer.json().catch(() => null) }
  }
  catch (error) {
    return { status: 502, body: { error: error instanceof Error ? error.message : String(error) } }
  }
}

/** GitHub answers with `message`; this instance answers with `error`. */
function messageOf(body: unknown): string {
  const record = asRecord(body)

  return String(record?.message ?? record?.error ?? 'Not Found')
}

/** The last path segment, for `/statuses/{sha}` when the parameter did not arrive. */
function pathTail(request: any): string {
  try {
    return new URL(String(request.url ?? '')).pathname.split('/').filter(Boolean).pop() ?? ''
  }
  catch {
    return ''
  }
}

/** `/issues/{number}/comments`, when the parameter did not arrive. */
function numberInPath(request: any): number {
  try {
    const parts = new URL(String(request.url ?? '')).pathname.split('/').filter(Boolean)
    const at = parts.lastIndexOf('issues')

    return at >= 0 ? Number(parts[at + 1] ?? 0) : 0
  }
  catch {
    return 0
  }
}

function asRecord(value: unknown): Record<string, any> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : null
}

/** Where this instance is, from the request rather than from configuration. */
function origin(request: any): string {
  try {
    const url = new URL(String(request.url ?? request.getUrl?.() ?? 'http://127.0.0.1'))

    return `${url.protocol}//${url.host}`
  }
  catch {
    return 'http://127.0.0.1'
  }
}

/**
 * Which of the three this call is, out of the path.
 *
 * `/gh/repos/{owner}/{repo}/check-runs` names it last; `/statuses/{sha}` and
 * `/issues/{number}/comments` bury it, because GitHub's paths are shaped around
 * the subject rather than the verb.
 */
function resourceOf(request: any): string {
  const path = (() => {
    try {
      return new URL(String(request.url ?? '')).pathname
    }
    catch {
      return ''
    }
  })()

  if (path.includes('/statuses/'))
    return 'statuses'

  if (path.endsWith('/comments'))
    return 'comments'

  const last = path.split('/').filter(Boolean).pop() ?? ''

  return last
}

/** The bearer, as the runner's token arrives. */
function bearerOf(request: any): string {
  const header = String(request.header?.('authorization') ?? request.headers?.authorization ?? request.get?.('authorization') ?? '')

  return header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : ''
}

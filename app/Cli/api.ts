/**
 * The CLI's connection to an instance.
 *
 * A thin wrapper over `fetch` rather than a second set of endpoint knowledge:
 * every command names a path and this adds the origin, the token and the
 * accept header. Nothing here knows what a pull request is.
 *
 * **HTTP only.** The CLI is a client of the public API, and the value of that
 * rule is entirely in it being absolute: the moment one command reaches into
 * the database because it is quicker, the CLI stops being a check on whether
 * the API is complete and becomes a second implementation of the product.
 */

import process from 'node:process'
import { HOSTED_INSTANCE, otherForge } from './context'

/** What every call answers with. Nothing here throws for a 4xx. */
export type Answer<T = any> =
  | { ok: true, status: number, data: T }
  | { ok: false, status: number, message: string, code?: string, fix?: string }

export interface Connection {
  instance: string
  token: string | null
}

/**
 * The message a person should read for this failure.
 *
 * The API's error envelope carries a `message` and often a `fix`, and both are
 * worth surfacing verbatim: they were written to be read, and paraphrasing them
 * in the client means two descriptions of one failure that drift apart.
 */
function describe(status: number, body: any): { message: string, code?: string, fix?: string } {
  const error = body?.error

  if (error && typeof error === 'object') {
    return {
      message: String(error.message ?? 'The request was refused'),
      code: error.code ? String(error.code) : undefined,
      fix: error.fix ? String(error.fix) : undefined,
    }
  }

  if (typeof error === 'string')
    return { message: error }

  if (status === 401)
    return { message: 'Not signed in', fix: 'Run `reviewos login` first.' }

  return { message: `The server answered ${status}` }
}

/**
 * What a 401 means to the person at the terminal, and what to do about it.
 *
 * Two different situations answer 401 and used to print the same word,
 * "Unauthenticated": never having signed in, and having signed in with a token
 * that has since expired or been revoked. The second is the confusing one - the
 * command worked last week - so it is said in full, with the one command that
 * fixes it. A token from the environment is named, because `reviewos login`
 * cannot replace that one and somebody would run it and see no change.
 */
export function signedOut(connection: Connection, environment: Record<string, string | undefined> = process.env): { message: string, fix: string } {
  if (!connection.token)
    return { message: `Not signed in to ${connection.instance}.`, fix: 'Run `reviewos login` to sign in through your browser.' }

  if (String(environment.REVIEWOS_TOKEN ?? '').trim() === connection.token) {
    return {
      message: `${connection.instance} refused the token in REVIEWOS_TOKEN. It may have expired or been revoked.`,
      fix: 'Replace it, or unset it and run `reviewos login`.',
    }
  }

  return {
    message: `${connection.instance} refused your sign-in. The token may have expired or been revoked.`,
    // "May": an instance mid-deploy has answered 401 to a token that worked
    // again minutes later, so the retry comes before the new sign-in.
    fix: 'Try again in a moment. If it keeps happening, run `reviewos login` to sign in again through your browser.',
  }
}

export async function call<T = any>(
  connection: Connection,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  input: { query?: Record<string, unknown>, body?: unknown } = {},
): Promise<Answer<T>> {
  const url = new URL(path, connection.instance.endsWith('/') ? connection.instance : `${connection.instance}/`)

  for (const [key, value] of Object.entries(input.query ?? {})) {
    // Absent means absent. `?state=` asks for the state called empty string.
    if (value === undefined || value === null || value === '')
      continue

    url.searchParams.set(key, String(value))
  }

  const headers: Record<string, string> = { Accept: 'application/json' }
  if (connection.token)
    headers.Authorization = `Bearer ${connection.token}`
  if (input.body !== undefined)
    headers['Content-Type'] = 'application/json'

  let answer: Response
  try {
    answer = await fetch(url, {
      method,
      headers,
      body: input.body === undefined ? undefined : JSON.stringify(input.body),
    })
  }
  catch (error) {
    /*
     * A connection failure is reported as one rather than as a status. "fetch
     * failed" with no context is the error people paste into an issue; the URL
     * is the thing that makes it obvious the instance name is wrong.
     */
    return {
      ok: false,
      status: 0,
      message: `Could not reach ${connection.instance}: ${error instanceof Error ? error.message : String(error)}`,
      fix: 'Check the remote, or set REVIEWOS_URL.',
    }
  }

  const text = await answer.text()
  let body: any = null

  if (text.length) {
    try {
      body = JSON.parse(text)
    }
    catch {
      body = text
    }
  }

  if (!answer.ok) {
    // Another forge's 404 or 422 says nothing about what went wrong here: the
    // request went to the wrong product. Said once, with the way out.
    const forge = otherForge(connection.instance)
    if (forge) {
      return {
        ok: false,
        status: answer.status,
        message: `This checkout's remote is ${forge}, which is not a ReviewOS instance.`,
        fix: `Set REVIEWOS_URL=${HOSTED_INSTANCE} (or your own instance), and pass --repo owner/name if the repository is named differently there.`,
      }
    }

    const described = describe(answer.status, body)

    // The server's own words win when it explained itself. A bare
    // "Unauthenticated" explains nothing, and is what a lapsed token gets.
    if (answer.status === 401 && !described.fix)
      return { ok: false, status: 401, code: described.code, ...signedOut(connection) }

    return { ok: false, status: answer.status, ...described }
  }

  return { ok: true, status: answer.status, data: body as T }
}

/** Print a failure the way a person reads one, and return the exit code. */
export function report(answer: Extract<Answer, { ok: false }>): number {
  console.error(answer.message)

  if (answer.fix)
    console.error(answer.fix)

  return 1
}

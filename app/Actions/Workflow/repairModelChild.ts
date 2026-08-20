/**
 * The one place a repair talks to a model, and it is a process of its own.
 *
 * **Nothing in this file may import the application.** No database, no
 * configuration, no models, no logging - the SDK and the standard library, and
 * that is the whole point rather than a style preference. What runs here is the
 * handling of content a stranger wrote: a CI log is whatever the repository's
 * own test suite printed, which on a fork's pull request is a stranger's code
 * choosing this program's input, and the reply is a stranger's proposal parsed
 * by somebody else's dependency.
 *
 * Until now that happened inside the control plane: the same process that holds
 * a handle to the database with every private repository in it, the instance
 * key, and the deploy credentials in its environment. The gate on the *output*
 * is what stops a crafted log getting a bad diff committed - that is
 * `mayProposeRepair`, and it works - but it does nothing about a bug in the SDK,
 * a transitive dependency, or this file, because all three ran somewhere they
 * could read everything.
 *
 * So the model call moved out. This process is handed a prompt on stdin and an
 * environment containing the model key and nothing else; it answers JSON on
 * stdout and exits. It cannot read the database because it has no handle and no
 * credentials to make one. It cannot read the repository because it is never
 * told where one is. It does not open files.
 *
 * ## What this is not
 *
 * It is not a sandbox. It is the same user on the same host with the same
 * network, and a determined escape from this process reaches everything the
 * control plane could reach anyway. What it removes is the *ambient* authority -
 * the handle and the secrets that were simply lying in scope - which is the
 * difference between a dependency bug being a bad afternoon and being a
 * disclosure. `docs/ci-security-review.md` is the honest account of what this
 * product does and does not isolate, and nothing here should be read as
 * changing it.
 *
 * ## Two invocations, no state
 *
 * The agent calls this twice - once to choose files, once to propose changes -
 * and this program knows about neither. It takes a prompt and a schema and
 * returns what came back. Keeping it stateless is what lets the *parent* own
 * every filesystem read: the child asks for nothing and is told nothing it did
 * not need.
 */

import Anthropic from '@anthropic-ai/sdk'
import { jsonSchemaOutputFormat } from '@anthropic-ai/sdk/helpers/json-schema'

/** What the parent sends on stdin. */
export interface ModelCallRequest {
  model: string
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  maxTokens: number
  system: string
  prompt: string
  /** The JSON schema the answer must satisfy. */
  schema: Record<string, unknown>
}

/** What it answers on stdout, always one line of JSON. */
export type ModelCallReply =
  | { ok: true, output: unknown, tokens: number }
  | { ok: false, error: string }

/**
 * Make the call.
 *
 * Exported so the shape is testable without spawning anything; `main` below is
 * the three lines that wire it to the pipes.
 */
export async function callModel(request: ModelCallRequest, client?: Anthropic): Promise<ModelCallReply> {
  const key = String(process.env.ANTHROPIC_API_KEY ?? '').trim()

  if (!client && !key)
    return { ok: false, error: 'no model credentials reached the repair process' }

  try {
    const anthropic = client ?? new Anthropic({ apiKey: key })

    const answer = await anthropic.messages.parse({
      model: request.model,
      max_tokens: request.maxTokens,
      system: request.system,
      thinking: { type: 'adaptive' },
      output_config: {
        effort: request.effort,
        format: jsonSchemaOutputFormat(request.schema as any),
      },
      messages: [{ role: 'user', content: request.prompt }],
    })

    /*
     * A refusal is an answer, not an error.
     *
     * The model declining to write a repair is a legitimate outcome - it is what
     * should happen when the only way to make a step pass is to edit the test -
     * and reporting it as a failure would put it in the wrong column of the
     * attempt ledger.
     */
    if (answer.stop_reason === 'refusal')
      return { ok: false, error: `the model declined to answer: ${answer.stop_details?.category ?? 'unspecified'}` }

    return {
      ok: true,
      output: answer.parsed_output ?? null,
      tokens: whole(answer.usage?.input_tokens) + whole(answer.usage?.output_tokens),
    }
  }
  catch (error) {
    /*
     * The message only, never the error object.
     *
     * An SDK error can carry the request that produced it, and the request
     * carries the prompt. This answer is written to a pipe the parent logs on
     * failure, and a log line with the whole prompt in it is a log line with a
     * repository's source in it.
     */
    return { ok: false, error: String((error as Error)?.message ?? error).slice(0, 500) }
  }
}

function whole(value: unknown): number {
  const raw = Number(value)

  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0
}

/**
 * Read one request, answer one reply, exit.
 *
 * Guarded on being the entry point so importing this file - which the tests do,
 * for `callModel` - does not block on a stdin that is never going to arrive.
 */
if (import.meta.main) {
  const body = await Bun.stdin.text()

  let reply: ModelCallReply

  try {
    reply = await callModel(JSON.parse(body) as ModelCallRequest)
  }
  catch (error) {
    reply = { ok: false, error: `the repair process could not read its request: ${String((error as Error)?.message ?? error).slice(0, 200)}` }
  }

  // One line of JSON and nothing else on stdout, so a stray `console.log` from
  // a dependency cannot be mistaken for the answer.
  process.stdout.write(`${JSON.stringify(reply)}\n`)
}

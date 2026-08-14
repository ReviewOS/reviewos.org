/**
 * The API and webhook reference, written by the code that implements them.
 *
 * A hand-written reference is a second description of the same thing, and the
 * second description is the one that goes stale: an endpoint gains a parameter,
 * the page keeps the old list, and somebody spends an afternoon finding out
 * that the docs are wrong rather than their request. So the page is generated -
 * from the OpenAPI document the actions produce, and from the payload module
 * webhooks are actually built from.
 *
 * **Generated, not live.** The pages are files in `docs/`, committed like the
 * rest, because the docs site is static and a reference that needs the
 * application running is a reference nobody can read while the application is
 * down. `buddy docs:reference` regenerates them and a test fails when the
 * committed copy has drifted.
 */

import { WEBHOOK_EVENTS } from '../Webhooks/payloads'

export interface OpenApiDocument {
  paths: Record<string, Record<string, OpenApiOperation>>
}

export interface OpenApiOperation {
  summary?: string
  operationId?: string
  parameters?: Array<{ name: string, in: string, required?: boolean, schema?: { type?: string } }>
  requestBody?: { required?: boolean, content?: Record<string, { schema?: { properties?: Record<string, { type?: string }>, required?: string[] } }> }
  responses?: Record<string, { description?: string, headers?: Record<string, { description?: string }> }>
}

/** Endpoints under `/api`, which is the surface a client is meant to use. */
const PUBLIC_PREFIX = '/api/'

/**
 * The routes this application declares, read out of its own route files.
 *
 * Keyed `METHOD /api/path` and valued with the action that answers it, because
 * both halves are needed: the key says what belongs in the reference, and the
 * value is what an endpoint that documents nothing can at least be traced to.
 *
 * The OpenAPI document carries every route registered in the process, and most
 * of those are the framework's defaults - a git forge's document listing
 * `Campaigns`, `Board columns` and `Card comments` is 550 entries of which the
 * hundred somebody wants are unfindable. What belongs in a reference is what
 * this product declares, which is exactly what `routes/` says.
 *
 * Parsed from the source rather than from the route table, for the reason
 * `tests/helpers/declaredRoutes.ts` gives: the table is shared by the whole
 * process and anything that has served a page has added its own file-based
 * views to it, so the answer depends on what ran first.
 */
export function declaredRoutes(sources: Array<{ prefix: string, source: string }>): Map<string, string> {
  const routes = new Map<string, string>()

  for (const { prefix, source } of sources) {
    const pattern = /\broute\s*\.\s*(get|post|put|patch|delete)\s*\(\s*'([^']+)'\s*,\s*'([^']+)'/g

    for (const match of source.matchAll(pattern)) {
      const [, method = '', path = '', handler = ''] = match

      if (path)
        routes.set(`${method} ${`${prefix}${path}`.replace(/\/{2,}/g, '/')}`, handler)
    }
  }

  return routes
}

/** Just the paths, for deciding what the reference covers. */
export function pathsOf(routes: Map<string, string>): Set<string> {
  return new Set([...routes.keys()].map(key => key.slice(key.indexOf(' ') + 1)))
}

/**
 * The paths worth publishing, grouped the way somebody looks for them.
 *
 * By first segment after `/api/`, because that is the noun a reader has in
 * mind - repositories, runs, tokens - and an alphabetical list of two hundred
 * paths is a list nobody scrolls.
 */
export function groupPaths(document: OpenApiDocument, declared?: Set<string>): Map<string, string[]> {
  const groups = new Map<string, string[]>()

  for (const path of Object.keys(document.paths ?? {})) {
    if (!path.startsWith(PUBLIC_PREFIX))
      continue

    // Only what this application declares. Everything else in the document is
    // a framework default this product does not use, and a reference that
    // lists them buries the endpoints somebody came for.
    if (declared && !declared.has(path))
      continue

    const rest = path.slice(PUBLIC_PREFIX.length)
    const group = rest.split('/')[0] ?? 'other'

    groups.set(group, [...(groups.get(group) ?? []), path])
  }

  for (const [group, paths] of groups)
    groups.set(group, paths.sort())

  return new Map([...groups.entries()].sort(([left], [right]) => left.localeCompare(right)))
}

/** A heading a person recognises, from a path segment a machine produced. */
export function titleFor(group: string): string {
  const words = group.replace(/[-_]/g, ' ').trim()

  return words.charAt(0).toUpperCase() + words.slice(1)
}

/**
 * The answers the generator invents when an action says nothing.
 *
 * Every operation gets these three whether or not anybody wrote them, so their
 * presence says nothing - but an operation that carries *anything else* was
 * described on purpose, by somebody who would have listed the inputs too if
 * there were any.
 */
const GENERIC_RESPONSES = new Set(['Successful response', 'Validation failed', 'Server error'])

/** Whether an author described this endpoint, rather than the generator filling it in. */
export function isDescribed(operation: OpenApiOperation): boolean {
  return Object.values(operation.responses ?? {})
    .some(answer => answer.description && !GENERIC_RESPONSES.has(answer.description))
}

function parameterTable(operation: OpenApiOperation, handler: string): string {
  const parameters = operation.parameters ?? []
  const body = operation.requestBody?.content?.['application/json']?.schema
  const required = new Set(body?.required ?? [])

  const rows: string[] = []

  for (const parameter of parameters)
    rows.push(`| \`${parameter.name}\` | ${parameter.in} | ${parameter.required ? 'required' : 'optional'} | ${parameter.schema?.type ?? 'string'} |`)

  for (const [name, shape] of Object.entries(body?.properties ?? {}))
    rows.push(`| \`${name}\` | body | ${required.has(name) ? 'required' : 'optional'} | ${shape?.type ?? 'string'} |`)

  if (rows.length === 0) {
    /*
     * "Takes no parameters" would be a lie for most of these.
     *
     * The document only knows the inputs an action declares in `validations`,
     * and an action that validates by hand inside its handler declares
     * nothing - so an endpoint that plainly requires a name would be published
     * as taking nothing at all. Naming the action is the honest answer, and it
     * is also the thing that gets the declaration written.
     */
    /*
     * Unless the endpoint was described. `ClaimJob` takes a credential in a
     * header and nothing else; telling a reader its inputs are undeclared
     * sends them to read an action that has nothing more to say.
     */
    return handler && !isDescribed(operation)
      ? `_Inputs are not declared on \`${handler}\`, so they are not listed here._\n`
      : '_Takes no parameters._\n'
  }

  return [
    '| Name | In | | Type |',
    '|---|---|---|---|',
    ...rows,
  ].join('\n').replace('| Name | In | | Type |', '| Name | In | Required | Type |') + '\n'
}

function responseTable(operation: OpenApiOperation): string {
  const responses = Object.entries(operation.responses ?? {})

  if (responses.length === 0)
    return ''

  const rows = responses
    .sort(([left], [right]) => Number(left) - Number(right))
    .map(([status, answer]) => `| \`${status}\` | ${answer.description ?? ''} |`)

  return ['', '| Status | Means |', '|---|---|', ...rows, ''].join('\n')
}

/**
 * The API reference, as markdown.
 *
 * Every operation the document carries, with what it takes and what it answers.
 * The prose beside each status comes from the action itself, which is the point
 * of `responses` living there: the sentence a reader gets is the sentence the
 * person who wrote the endpoint wrote.
 */
export function renderApiReference(document: OpenApiDocument, at: string, routes: Map<string, string> = new Map()): string {
  const groups = groupPaths(document, routes.size > 0 ? pathsOf(routes) : undefined)
  const total = [...groups.values()].reduce((count, paths) => count + paths.length, 0)
  const { declared, operations } = countDeclared(document, groups)

  const out: string[] = [
    '# API reference',
    '',
    '<!-- Generated by `buddy docs:reference`. Edits here are overwritten; change the action. -->',
    '',
    `Every endpoint this instance declares under \`/api\`, ${total} of them, generated from the`,
    'actions that implement them rather than written beside them. A hand-written reference is a',
    'second description of the same thing, and the second one is the one that goes stale.',
    '',
    'Authentication is a bearer token unless an endpoint says otherwise:',
    '',
    '```bash',
    'curl -H "Authorization: Bearer $TOKEN" "$SERVER/api/repos/workflow-runs?owner=you&repo=yours"',
    '```',
    '',
    'A token carries scopes, and a repository the token cannot reach answers **404** rather than',
    '403 - saying "forbidden" would confirm that a private repository exists.',
    '',
    // Said out loud rather than left to be discovered halfway down the page.
    // An endpoint whose action validates by hand has nothing for a generator
    // to read, and pretending otherwise is how a reference stops being one.
    `${declared} of the ${operations} operations below declare their inputs on the action, and this page`,
    'lists them. The rest validate inside the handler, so the page names the action instead of',
    'guessing - that number going up is the work, and a test holds it from going down.',
    '',
    `_Generated ${at}._`,
    '',
  ]

  for (const [group, paths] of groups) {
    out.push(`## ${titleFor(group)}`, '')

    for (const path of paths) {
      const methods = document.paths[path] ?? {}

      for (const [method, operation] of Object.entries(methods)) {
        out.push(`### \`${method.toUpperCase()} ${path}\``, '')

        if (operation.summary && operation.summary !== path)
          out.push(operation.summary, '')

        out.push(parameterTable(operation, routes.get(`${method} ${path}`) ?? ''))

        const responses = responseTable(operation)
        if (responses)
          out.push(responses)

        const headers = Object.keys(operation.responses?.['200']?.headers ?? {})
        if (headers.length > 0)
          out.push('', `Response headers: ${headers.map(name => `\`${name}\``).join(', ')}.`, '')
      }
    }
  }

  // Trimmed rather than joined exactly: a page that ends in a blank line is a
  // lint error in this repository, and a generator that emits one makes every
  // regeneration fail the check it exists to pass.
  return `${out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`
}

/** How much of the surface documents itself, which is a number worth publishing. */
export function countDeclared(document: OpenApiDocument, groups: Map<string, string[]>): { declared: number, operations: number } {
  let declared = 0
  let operations = 0

  for (const paths of groups.values()) {
    for (const path of paths) {
      for (const operation of Object.values(document.paths[path] ?? {})) {
        operations += 1

        const body = operation.requestBody?.content?.['application/json']?.schema?.properties ?? {}

        if ((operation.parameters ?? []).length > 0 || Object.keys(body).length > 0)
          declared += 1
      }
    }
  }

  return { declared, operations }
}

/**
 * The webhook reference.
 *
 * From `WEBHOOK_EVENTS`, so an event that exists is listed and one that is
 * listed exists. The envelope is described once because it is the same for
 * every event - a receiver that handles it handles all of them - and the
 * per-event part says only what is different.
 */
export function renderWebhookReference(at: string): string {
  const out: string[] = [
    '# Webhook payloads',
    '',
    '<!-- Generated by `buddy docs:reference`. Edits here are overwritten; change app/Webhooks/payloads.ts. -->',
    '',
    'Every event this instance can send, generated from the module the payloads are built from.',
    '',
    `_Generated ${at}._`,
    '',
    '## The envelope',
    '',
    'Every payload has the same shape, so a receiver can be written once:',
    '',
    '```json',
    '{',
    '  "event": "pr:opened",',
    '  "delivered_at": "2026-08-13T10:00:00.000Z",',
    '  "repository": { "full_name": "owner/name", "owner": "owner", "name": "name", "id": 1 },',
    '  "sender": { "handle": "somebody", "id": 2 },',
    '  "subject": { "type": "pull_request", "id": 3, "number": 12, "title": "A change", "url": "/owner/name/pull/12" },',
    '  "action": "opened"',
    '}',
    '```',
    '',
    'Three rules the shapes follow:',
    '',
    '- **Numbers are numbers and times are ISO 8601 strings.** Both survive JSON, both parse',
    '  everywhere, and neither depends on knowing this instance\'s timezone.',
    '- **`sender` is null when nothing did it.** A scheduled action or a recovery sweep has no',
    '  person behind it, and a receiver that assumes one crashes on the day it is missing.',
    '- **Nothing is a database row.** These are named fields chosen for the receiver, so a column',
    '  rename here is not a breaking change to somebody\'s CI.',
    '',
    '## Signing',
    '',
    'Each delivery carries a signature over the exact bytes sent. Verify it before trusting the',
    'body: a webhook endpoint that skips the check is an endpoint anybody can post to.',
    '',
    '## The events',
    '',
    '| Event | Sent when |',
    '|---|---|',
  ]

  for (const event of WEBHOOK_EVENTS)
    out.push(`| \`${event}\` | ${describeEvent(event)} |`)

  out.push(
    '',
    '`check:reported`, `status:reported`, `run:transitioned` and `job:transitioned` carry an extra',
    'key - `check`, `run` or `job` - and put the new state in `action`, so one subscription covers a',
    'whole lifecycle and a receiver switches on one field.',
    '',
  )

  return `${out.join('\n').trimEnd()}\n`
}

/** One line per event, in the terms a receiver's author thinks in. */
function describeEvent(event: string): string {
  const sentences: Record<string, string> = {
    'pr:opened': 'somebody opened a pull request',
    'pr:synchronized': 'the head of an open pull request moved, so a review already written may be stale',
    'pr:ready_for_review': 'a draft became ready, and nothing else about it changed',
    'pr:merged': 'the work landed',
    'pr:closed': 'the work will not land, and anything queued against it should stop',
    'review:requested': 'somebody is waiting on a specific reviewer',
    'review:submitted': 'a verdict arrived',
    'issue:opened': 'there is something new to triage',
    'issue:closed': 'work queued against it should stop',
    'comment:created': 'somebody replied',
    'release:published': 'a release went out',
    'check:reported': 'a check run said something about a commit; `action` is its status',
    'status:reported': 'the older commit-status API said something; `action` is its state',
    'run:transitioned': 'a workflow run changed state; `action` is the new one',
    'job:transitioned': 'one job of a run changed state; `action` is the new one',
  }

  return sentences[event] ?? 'see the payload module'
}

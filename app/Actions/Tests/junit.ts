/**
 * JUnit XML, as frameworks actually emit it.
 *
 * The format every test framework in every language can produce and most
 * already do, which is why it is the one worth reading: a repository gets flake
 * detection by pointing an existing reporter at an endpoint, with nothing to
 * install and no pipeline to move.
 *
 * It is also barely a format. There is no specification, only Ant's output and
 * two decades of tools imitating it, so this reads the shapes that exist rather
 * than a schema:
 *
 * - `<testsuites>` wrapping `<testsuite>`, or a bare `<testsuite>`, or several
 *   roots concatenated by a script somebody wrote.
 * - A skip is `<skipped/>`; a failure is `<failure>` *or* `<error>` - the
 *   distinction is an assertion versus an exception, and nobody consuming it
 *   has ever cared.
 * - The message is an attribute, the stack is the element's text, and half the
 *   emitters put the message in the text as well.
 * - `time` is seconds with a decimal point, sometimes with a comma, sometimes
 *   absent.
 *
 * Read with a small scanner rather than an XML library, deliberately. The input
 * is a file written by somebody else's tool, arriving from a machine this
 * instance does not control, and a reader that cannot be made to allocate a
 * gigabyte or resolve an external entity is worth more here than one that
 * handles namespaces.
 */

import type { IngestExecution } from './ingest'

export interface JunitReport {
  ok: boolean
  reason: string
  executions: IngestExecution[]
}

/** A ceiling on how much of somebody else's file this will read. */
const MAX_LENGTH = 20_000_000

/** And on how many results one report may carry. */
const MAX_EXECUTIONS = 50_000

export function parseJunit(source: string): JunitReport {
  const text = String(source ?? '')

  if (text.length > MAX_LENGTH)
    return { ok: false, reason: 'that report is larger than this instance will read', executions: [] }

  if (!text.includes('<testcase'))
    return { ok: false, reason: 'this does not look like a JUnit report: it has no `<testcase>` elements', executions: [] }

  const executions: IngestExecution[] = []

  /*
   * Each `<testcase>`, with whatever follows it up to the next one. The
   * children that matter - `<failure>`, `<error>`, `<skipped>` - are inside
   * that span, and reading it as a span rather than as a tree is what makes
   * this immune to the nesting each emitter invents.
   */
  const cases = text.split(/<testcase\b/).slice(1)

  for (const one of cases) {
    if (executions.length >= MAX_EXECUTIONS)
      break

    const closes = one.indexOf('>')

    if (closes < 0)
      continue

    const head = one.slice(0, closes + 1)
    const body = head.trimEnd().endsWith('/>') ? '' : one.slice(head.length)

    const name = attribute(head, 'name')

    if (!name)
      continue

    /*
     * Scope from `classname`, falling back to `file`. Both are what emitters
     * use for "where this test lives", and a test's identity depends on it: two
     * tests called `renders` in different files are two tests, and a tool that
     * keys on the name alone reports one flaky test that is really two healthy
     * ones.
     */
    const scope = attribute(head, 'classname') || attribute(head, 'file') || ''

    const failedAt = body.search(/<(?:failure|error)\b/)
    const failed = failedAt >= 0
    const skipped = !failed && /<skipped\b/.test(body)
    const failure = failed ? body.slice(failedAt) : ''
    const failureHead = failed ? failure.slice(0, failure.indexOf('>') + 1) : ''

    executions.push({
      scope,
      name,
      result: failed ? 'failed' : skipped ? 'skipped' : 'passed',
      durationMs: Math.round(seconds(attribute(head, 'time')) * 1000),
      /*
       * `retries` is not a JUnit concept, and the emitters that support them
       * invented an attribute each. Both spellings are read; neither being
       * present is the ordinary case and means the reporter ran it once.
       */
      retries: Math.max(0, Number(attribute(head, 'retries') || attribute(head, 'retry') || 0) || 0),
      failureMessage: failed ? ((attribute(failureHead, 'message') || textOf(failure)).slice(0, 4000) || null) : null,
      failureStack: failed ? (textOf(failure).slice(0, 20_000) || null) : null,
      tags: [],
    })
  }

  if (executions.length === 0)
    return { ok: false, reason: 'no test cases could be read from this report', executions: [] }

  return { ok: true, reason: `read ${executions.length} results`, executions }
}

/** One attribute, single or double quoted, entities decoded. */
function attribute(source: string, name: string): string {
  const match = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`).exec(source)

  return decode(match?.[2] ?? match?.[3] ?? '')
}

/** The text inside the first element of a fragment, CDATA included. */
function textOf(fragment: string): string {
  const start = fragment.indexOf('>')

  if (start < 0)
    return ''

  const end = fragment.indexOf('</', start)
  const inner = fragment.slice(start + 1, end < 0 ? undefined : end)

  return decode(inner.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')).trim()
}

/**
 * `time="1.25"` as seconds.
 *
 * A comma decimal separator is accepted because locale-aware emitters produce
 * it, and a number this cannot read is zero rather than a refusal: a duration
 * is not worth failing an entire report over.
 */
function seconds(value: string): number {
  const parsed = Number.parseFloat(String(value ?? '').replace(',', '.'))

  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0
}

/**
 * The five XML entities, and numeric references.
 *
 * Deliberately *not* general entity expansion. An external entity is how an XML
 * parser is made to read `/etc/passwd` or spend a minute expanding a billion
 * laughs, and this input arrives from a machine the instance does not control.
 * Nothing here resolves anything.
 */
function decode(value: string): string {
  return String(value ?? '')
    .replace(/&#(\d+);/g, (_, code) => safeCharacter(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => safeCharacter(Number.parseInt(code, 16)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, '\'')
    .replace(/&amp;/g, '&')
}

function safeCharacter(code: number): string {
  return Number.isFinite(code) && code > 0 && code <= 0x10FFFF ? String.fromCodePoint(code) : ''
}

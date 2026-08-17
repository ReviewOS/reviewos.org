// JUnit XML, as frameworks actually emit it.
//
// There is no specification for this format - only Ant's output and two decades
// of tools imitating it - so every case here is a shape something real produces.
// A reader tested against an idealised document is one that fails on the first
// report a person actually has.

import { describe, expect, test } from 'bun:test'
import { parseJunit } from '../../app/Actions/Tests/junit'

describe('reading a report', () => {
  test('the ordinary shape: suites, cases, failures, skips', () => {
    const report = parseJunit(`<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="unit" tests="3" failures="1">
    <testcase classname="src/parse.ts" name="reads a header" time="0.012"/>
    <testcase classname="src/parse.ts" name="refuses a bad one" time="1.5">
      <failure message="expected 2 to be 3">at parse.ts:12</failure>
    </testcase>
    <testcase classname="src/slow.ts" name="not yet">
      <skipped/>
    </testcase>
  </testsuite>
</testsuites>`)

    expect(report.ok).toBe(true)
    expect(report.executions).toHaveLength(3)

    expect(report.executions[0]).toMatchObject({ scope: 'src/parse.ts', name: 'reads a header', result: 'passed', durationMs: 12 })
    expect(report.executions[1]).toMatchObject({ result: 'failed', durationMs: 1500, failureMessage: 'expected 2 to be 3' })
    expect(report.executions[1]!.failureStack).toContain('parse.ts:12')
    expect(report.executions[2]!.result).toBe('skipped')
  })

  test('`<error>` is a failure too, because nobody consuming this cares', () => {
    // The distinction is an assertion versus an exception. Both mean the test
    // did not pass, which is the only thing a history needs.
    const report = parseJunit(`<testsuite><testcase name="throws"><error message="boom"/></testcase></testsuite>`)

    expect(report.executions[0]!.result).toBe('failed')
    expect(report.executions[0]!.failureMessage).toBe('boom')
  })

  test('a bare testsuite with no wrapper', () => {
    const report = parseJunit(`<testsuite name="x"><testcase name="one"/></testsuite>`)

    expect(report.ok).toBe(true)
    expect(report.executions).toHaveLength(1)
  })

  test('single quotes, CDATA, and entities', () => {
    const report = parseJunit(`<testsuite><testcase classname='a &amp; b' name='it &lt;works&gt;'>
      <failure message='a &quot;quoted&quot; thing'><![CDATA[line one
line two]]></failure>
    </testcase></testsuite>`)

    expect(report.executions[0]!.scope).toBe('a & b')
    expect(report.executions[0]!.name).toBe('it <works>')
    expect(report.executions[0]!.failureMessage).toBe('a "quoted" thing')
    expect(report.executions[0]!.failureStack).toContain('line two')
  })

  test('`file` stands in for `classname`, since a test needs a scope', () => {
    /*
     * Two tests called `renders` in different files are two tests. A reader
     * that keyed on the name alone would report one flaky test that is really
     * two healthy ones.
     */
    const report = parseJunit(`<testsuite><testcase file="src/a.spec.ts" name="renders"/></testsuite>`)

    expect(report.executions[0]!.scope).toBe('src/a.spec.ts')
  })

  test('a comma decimal duration, because locale-aware emitters exist', () => {
    expect(parseJunit(`<testsuite><testcase name="x" time="0,25"/></testsuite>`).executions[0]!.durationMs).toBe(250)
  })

  test('and an unreadable duration is zero rather than a refusal', () => {
    // A duration is not worth failing an entire report over.
    const report = parseJunit(`<testsuite><testcase name="x" time="ages"/></testsuite>`)

    expect(report.ok).toBe(true)
    expect(report.executions[0]!.durationMs).toBe(0)
  })

  test('retries are read where an emitter provides them', () => {
    // Not a JUnit concept; the emitters that support it each invented an
    // attribute. Both spellings are read, and neither is the ordinary case.
    expect(parseJunit(`<testsuite><testcase name="x" retries="2"/></testsuite>`).executions[0]!.retries).toBe(2)
    expect(parseJunit(`<testsuite><testcase name="x" retry="1"/></testsuite>`).executions[0]!.retries).toBe(1)
  })
})

describe('a report that cannot be read', () => {
  test('says so rather than recording nothing and reporting success', () => {
    const report = parseJunit('<html><body>404 Not Found</body></html>')

    expect(report.ok).toBe(false)
    expect(report.reason).toContain('`<testcase>`')
  })

  test('an empty body is refused', () => {
    expect(parseJunit('').ok).toBe(false)
  })

  test('a truncated document keeps what it could read', () => {
    /*
     * A report cut off mid-write - a killed process, a full disk - still
     * carries the results before the cut, and those are the ones somebody
     * needs. Refusing the whole file would throw away the passing history that
     * makes the next failure legible.
     */
    const report = parseJunit(`<testsuite><testcase name="one"/><testcase name="two"/><testcase name="thr`)

    expect(report.ok).toBe(true)
    expect(report.executions.map(one => one.name)).toEqual(['one', 'two'])
  })

  test('and an external entity is never resolved', () => {
    /*
     * The reason this is a scanner rather than an XML library. `&xxe;` is how
     * a parser is made to read `/etc/passwd`, and this input arrives from a
     * machine the instance does not control.
     */
    const report = parseJunit(`<!DOCTYPE t [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>
<testsuite><testcase name="&xxe;" classname="x"/></testsuite>`)

    expect(report.ok).toBe(true)
    // The reference is left as text: nothing was resolved, and nothing was read
    // off the filesystem to put in its place.
    expect(report.executions[0]!.name).toBe('&xxe;')
  })
})

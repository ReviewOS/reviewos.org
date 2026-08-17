// Actions' own documented examples, run against this evaluator.
//
// `workflow-expression.test.ts` tests the language this instance implements.
// This file tests something narrower and more useful: **the examples GitHub
// publishes**, including the ones that surprise people. A compatibility claim
// is only worth what somebody can check, and the cheapest way to check this one
// is to take the expressions out of the documentation and assert what the
// documentation says they produce.
//
// The surprising ones are the point. Nobody's workflow breaks on
// `1 == 1`; workflows break on `'' == 0` being true, on `'ABC' == 'abc'` being
// true, on `&&` returning an operand rather than a boolean, and on an `if:`
// without a status function implying `success()`. Each of those is a rule
// somebody has to be told, and each of them is here.

import { describe, expect, test } from 'bun:test'
import { evaluateExpression, interpolate, shouldRun } from '../../app/Actions/Workflow/expression'

const value = (source: string, context: Record<string, unknown> = {}): unknown =>
  evaluateExpression(source, context).value

describe('type coercion, as the documentation tabulates it', () => {
  /*
   * GitHub's table: when two operands are not the same type, both are cast to
   * a number. It is the rule behind almost every "why did my condition fire"
   * question, because it makes an empty string, false, null and 0 all equal.
   */
  test('everything compares as a number, so these are all true', () => {
    expect(value("'' == 0")).toBe(true)
    expect(value("'0' == 0")).toBe(true)
    expect(value('false == 0')).toBe(true)
    expect(value('null == 0')).toBe(true)
    expect(value('true == 1')).toBe(true)
  })

  test('and a string that is not a number is NaN, which equals nothing', () => {
    // Including itself. A comparison against an unparseable string is false
    // whichever way round it is written, which is the half people miss.
    expect(value("'abc' == 'abc'")).toBe(true)
    expect(value("'abc' == 0")).toBe(false)
    expect(value("'abc' > 0")).toBe(false)
    expect(value("'abc' < 0")).toBe(false)
  })

  test('null and an undefined property are the same nothing', () => {
    expect(value('github.nothing == null', { github: {} })).toBe(true)
    expect(value('github.a.b.c == null', { github: {} })).toBe(true)
  })
})

describe('strings, which compare without case', () => {
  test("'ABC' == 'abc' is true, and it is the rule people forget", () => {
    expect(value("'ABC' == 'abc'")).toBe(true)
    expect(value("startsWith('Hello world', 'hello')")).toBe(true)
    expect(value("endsWith('Hello world', 'WORLD')")).toBe(true)
    expect(value("contains('Hello world', 'LLO')")).toBe(true)
  })

  test("a single quote is doubled, which is the only escape there is", () => {
    expect(value("'It''s open'")).toBe("It's open")
  })
})

describe('the documented function examples', () => {
  test("contains('Hello world', 'llo') is true", () => {
    expect(value("contains('Hello world', 'llo')")).toBe(true)
  })

  test('contains over an array is membership, not substring', () => {
    const context = { github: { event: { issue: { labels: [{ name: 'bug' }, { name: 'help wanted' }] } } } }

    // The documented shape: a star filter into `contains`, which is how every
    // "only run for this label" workflow is written.
    expect(value("contains(github.event.issue.labels.*.name, 'bug')", context)).toBe(true)
    expect(value("contains(github.event.issue.labels.*.name, 'wontfix')", context)).toBe(false)
  })

  test("format('{0} {1} {2}', 'hello', 'world', '!') is 'hello world !'", () => {
    expect(value("format('{0} {1} {2}', 'hello', 'world', '!')")).toBe('hello world !')
  })

  test("format('{{Hello {0} {1} {2}!}}', 'Mona', 'the', 'Octocat')", () => {
    // Doubled braces are the escape, which is the example the documentation
    // uses precisely because it looks wrong at first.
    expect(value("format('{{Hello {0} {1} {2}!}}', 'Mona', 'the', 'Octocat')"))
      .toBe('{Hello Mona the Octocat!}')
  })

  test("join(github.event.issue.labels.*.name, ', ')", () => {
    const context = { github: { event: { issue: { labels: [{ name: 'bug' }, { name: 'help wanted' }] } } } }

    expect(value("join(github.event.issue.labels.*.name, ', ')", context)).toBe('bug, help wanted')
  })

  test('join with no separator uses a comma', () => {
    expect(value('join(a)', { a: ['one', 'two'] })).toBe('one,two')
  })

  test('toJSON and fromJSON, the documented round trip', () => {
    expect(String(value('toJSON(job)', { job: { status: 'success' } }))).toContain('"status"')

    // The documented use: a matrix built from a job output, which only works
    // because `fromJSON` produces a real value rather than a string.
    const parsed: any = value(`fromJSON('{"config":{"os":"linux"}}')`)

    expect(parsed.config.os).toBe('linux')
    expect(value(`fromJSON('[1,2,3]')[1]`)).toBe(2)
    expect(value(`fromJSON('true')`)).toBe(true)
  })
})

describe('the operators that return operands rather than booleans', () => {
  /*
   * The documented behaviour: `&&` and `||` return one of their operands, not
   * `true` or `false`. It is what makes `${{ inputs.x || 'default' }}` the
   * idiom for a default, and it is why a workflow that expects a boolean out of
   * `||` gets a string instead.
   */
  test("github.event.action || 'none' is the documented default idiom", () => {
    expect(value("github.event.action || 'none'", { github: { event: {} } })).toBe('none')
    expect(value("github.event.action || 'none'", { github: { event: { action: 'opened' } } })).toBe('opened')
  })

  test('and && returns the second operand when the first is truthy', () => {
    expect(value("true && 'yes'")).toBe('yes')
    expect(value("false && 'yes'")).toBe(false)
  })

  test('an empty string is false and an empty object is true', () => {
    // Actions' truthiness, which does not match JavaScript's: `{}` and `[]`
    // are true, `''` and `0` are not.
    expect(value("'' || 'fallback'")).toBe('fallback')
    expect(value("a || 'fallback'", { a: {} })).toEqual({})
  })
})

describe('status functions, and the implied success()', () => {
  test('an if: with no status function only runs when nothing has failed', () => {
    // The single most surprising documented rule: every condition carries an
    // implicit `success() &&`. A workflow that writes `if: always()` is asking
    // for the *absence* of that.
    const failing = { job: { status: 'failure' } }

    expect(shouldRun("github.ref == 'refs/heads/main'", { ...failing, github: { ref: 'refs/heads/main' } }).run)
      .toBe(false)
    expect(shouldRun("always() && github.ref == 'refs/heads/main'", { ...failing, github: { ref: 'refs/heads/main' } }).run)
      .toBe(true)
  })

  test('failure() is how a step runs only when something broke', () => {
    expect(shouldRun('failure()', { job: { status: 'failure' } }).run).toBe(true)
    expect(shouldRun('failure()', { job: { status: 'success' } }).run).toBe(false)
  })

  test('cancelled() reads the run rather than computing anything', () => {
    expect(shouldRun('cancelled()', { job: { status: 'cancelled' } }).run).toBe(true)
    expect(shouldRun('always()', { job: { status: 'cancelled' } }).run).toBe(true)
  })

  test('success() with nothing reported yet is true, which is the default written out', () => {
    expect(shouldRun('success()', {}).run).toBe(true)
  })
})

describe('the documented context examples', () => {
  const context = {
    github: {
      ref: 'refs/heads/main',
      ref_name: 'main',
      event_name: 'pull_request',
      repository: 'octo-org/octo-repo',
      actor: 'octocat',
      event: { pull_request: { base: { ref: 'main' }, head: { ref: 'feature' }, draft: false } },
    },
    matrix: { os: 'ubuntu-latest', node: 20 },
    needs: { build: { result: 'success', outputs: { artifact: 'app.tgz' } } },
    steps: { check: { outcome: 'failure', conclusion: 'success', outputs: { count: '3' } } },
    runner: { os: 'Linux' },
    env: { DEPLOY: 'yes' },
  }

  test('the conditions people actually write', () => {
    expect(value("github.ref == 'refs/heads/main'", context)).toBe(true)
    expect(value("github.event_name == 'pull_request' && !github.event.pull_request.draft", context)).toBe(true)
    expect(value("startsWith(github.ref, 'refs/tags/')", context)).toBe(false)
    expect(value("matrix.os == 'ubuntu-latest' && matrix.node == 20", context)).toBe(true)
    expect(value("needs.build.result == 'success'", context)).toBe(true)
    expect(value('needs.build.outputs.artifact', context)).toBe('app.tgz')
    expect(value("runner.os == 'Linux'", context)).toBe(true)
    expect(value("env.DEPLOY == 'yes'", context)).toBe(true)
  })

  test("a step's outcome and its conclusion are different questions", () => {
    // They differ exactly when `continue-on-error` turned a failure into a
    // non-failure, and a condition reading one when it meant the other is the
    // bug the distinction exists to prevent.
    expect(value("steps.check.outcome == 'failure'", context)).toBe(true)
    expect(value("steps.check.conclusion == 'success'", context)).toBe(true)
  })

  test('index syntax reaches what dots cannot', () => {
    expect(value("github['ref_name']", context)).toBe('main')
    expect(value("env['DEPLOY']", context)).toBe('yes')
  })
})

describe('interpolation, as a workflow writes it', () => {
  const context = { github: { ref_name: 'main', sha: 'abc123' }, matrix: { node: 20 } }

  test('the ordinary substitutions', () => {
    expect(interpolate('build-${{ github.ref_name }}-${{ matrix.node }}', context)).toBe('build-main-20')
    expect(interpolate('${{ github.sha }}', context)).toBe('abc123')
  })

  test('whitespace inside the braces is not significant', () => {
    expect(interpolate('${{github.ref_name}}', context)).toBe('main')
    expect(interpolate('${{   github.ref_name   }}', context)).toBe('main')
  })

  test('a null interpolates as nothing, which is what a shell expects', () => {
    expect(interpolate('x${{ github.missing }}y', context)).toBe('xy')
  })

  test('and an expression this cannot resolve is left exactly as written', () => {
    /*
     * The documented failure mode of *this* instance rather than of Actions,
     * and the one deliberate difference in this file. An unresolvable
     * expression becoming an empty string would silently change what a command
     * means - `rm -rf ${{ secrets.PREFIX }}/build` is the example that ends
     * badly - so it stays visible instead.
     */
    expect(interpolate('${{ hashFiles(\'**/lock\') }}', context)).toBe('${{ hashFiles(\'**/lock\') }}')
  })
})

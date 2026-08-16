// The expression language: `${{ ... }}` and `if:`.
//
// Everything else in this phase stores what a file said and defers the meaning.
// `if:` cannot - a job either runs or does not - so this is the piece that
// decides, and the cases below are the ones where deciding differently from
// Actions would mean debugging a workflow twice.

import { describe, expect, test } from 'bun:test'
import { evaluateExpression, interpolate, shouldRun } from '../../app/Actions/Workflow/expression'

const value = (source: string, context: any = {}): any => evaluateExpression(source, context).value

describe('literals and lookups', () => {
  test('the literal forms the language has', () => {
    expect(value('true')).toBe(true)
    expect(value('false')).toBe(false)
    expect(value('null')).toBeNull()
    expect(value('42')).toBe(42)
    expect(value('-7')).toBe(-7)
    expect(value('\'hello\'')).toBe('hello')
  })

  test('a single quote inside a string doubles, which is the only escape', () => {
    expect(value('\'it\'\'s\'')).toBe('it\'s')
  })

  test('double quotes are a syntax error rather than a second kind of string', () => {
    // Surprising once. Silently accepting them would make a workflow behave
    // differently here than on Actions.
    expect(evaluateExpression('"hello"').ok).toBe(false)
  })

  test('context lookups, including nested ones', () => {
    const context = { github: { ref: 'refs/heads/main', event: { number: 12 } } }

    expect(value('github.ref', context)).toBe('refs/heads/main')
    expect(value('github.event.number', context)).toBe(12)
    expect(value('github[\'ref\']', context)).toBe('refs/heads/main')
  })

  /*
   * GitHub's rule, and the one that keeps `if: env.THING == 'x'` working on a
   * workflow where THING is set only sometimes.
   */
  test('an unknown name or property is null, not an error', () => {
    expect(value('nothing')).toBeNull()
    expect(value('github.nothing', { github: {} })).toBeNull()
    expect(value('a.b.c.d', { a: null })).toBeNull()
  })
})

describe('operators', () => {
  test('comparison coerces to number, as Actions does', () => {
    // Copied deliberately, including the parts that look wrong.
    expect(value('\'\' == 0')).toBe(true)
    expect(value('null == 0')).toBe(true)
    expect(value('\'abc\' == 0')).toBe(false)
    expect(value('\'1\' == 1')).toBe(true)
  })

  test('strings compare without case, which is the rule people forget', () => {
    expect(value('\'Main\' == \'main\'')).toBe(true)
  })

  test('ordering, with NaN false in every direction', () => {
    expect(value('2 > 1')).toBe(true)
    expect(value('1 >= 1')).toBe(true)
    expect(value('\'abc\' > 1')).toBe(false)
    expect(value('\'abc\' < 1')).toBe(false)
  })

  /*
   * `&&` and `||` return an operand rather than a boolean, and people rely on
   * it: `${{ inputs.name || 'default' }}` is the idiom for a fallback.
   */
  test('and and or return operands', () => {
    expect(value('\'a\' && \'b\'')).toBe('b')
    expect(value('\'\' || \'fallback\'')).toBe('fallback')
    expect(value('\'set\' || \'fallback\'')).toBe('set')
  })

  test('not, and precedence between the operators', () => {
    expect(value('!false')).toBe(true)
    expect(value('!\'\'')).toBe(true)
    expect(value('true || false && false')).toBe(true)
    expect(value('(true || false) && false')).toBe(false)
    expect(value('1 == 1 && 2 == 2')).toBe(true)
  })

  test('an empty object is true, unlike an empty string', () => {
    expect(value('!github', { github: {} })).toBe(false)
    expect(value('!github', { github: '' })).toBe(true)
  })
})

describe('functions', () => {
  test('contains over a string and over an array', () => {
    expect(value('contains(\'hello world\', \'World\')')).toBe(true)
    expect(value('contains(labels, \'bug\')', { labels: ['bug', 'urgent'] })).toBe(true)
    expect(value('contains(labels, \'nope\')', { labels: ['bug'] })).toBe(false)
  })

  test('startsWith and endsWith, both case-insensitive', () => {
    expect(value('startsWith(github.ref, \'refs/heads/\')', { github: { ref: 'refs/heads/main' } })).toBe(true)
    expect(value('endsWith(\'file.TS\', \'.ts\')')).toBe(true)
  })

  test('format, with doubled braces as the escape', () => {
    expect(value('format(\'{0}-{1}\', \'a\', 2)')).toBe('a-2')
    expect(value('format(\'{{literal}} {0}\', \'x\')')).toBe('{literal} x')
  })

  test('join, with a comma by default', () => {
    expect(value('join(labels)', { labels: ['a', 'b'] })).toBe('a,b')
    expect(value('join(labels, \' | \')', { labels: ['a', 'b'] })).toBe('a | b')
  })

  test('toJSON and fromJSON round-trip', () => {
    expect(value('toJSON(thing)', { thing: { a: 1 } })).toBe('{"a":1}')
    expect(value('fromJSON(\'[1,2]\')')).toEqual([1, 2])
    expect(evaluateExpression('fromJSON(\'not json\')').ok).toBe(false)
  })

  test('the status functions read the job rather than computing anything', () => {
    expect(value('success()', { job: { status: 'success' } })).toBe(true)
    expect(value('success()', { job: { status: 'failure' } })).toBe(false)
    expect(value('failure()', { job: { status: 'failure' } })).toBe(true)
    expect(value('cancelled()', { job: { status: 'cancelled' } })).toBe(true)
    expect(value('always()', { job: { status: 'failure' } })).toBe(true)
  })

  /*
   * `hashFiles` reads the checked-out tree, which this side does not have.
   * Refused rather than answered with a fake digest: a wrong hash silently
   * restores the wrong cache, which is a bug people chase for days.
   */
  test('hashFiles is refused rather than guessed', () => {
    const result = evaluateExpression('hashFiles(\'**/lock\')')

    expect(result.ok).toBe(false)
    expect(result.error).toContain('checkout')
  })

  test('an unknown function is an error, not null', () => {
    expect(evaluateExpression('nonsense(1)').ok).toBe(false)
  })
})

describe('the star filter', () => {
  test('collects a property from every element', () => {
    const context = { steps: { one: { outcome: 'success' }, two: { outcome: 'failure' } } }

    expect(value('steps.*.outcome', context)).toEqual(['success', 'failure'])
  })

  test('and works with contains, which is what it is for', () => {
    const context = { steps: { one: { outcome: 'success' }, two: { outcome: 'failure' } } }

    expect(value('contains(steps.*.outcome, \'failure\')', context)).toBe(true)
  })
})

describe('deciding whether something runs', () => {
  test('no condition runs', () => {
    expect(shouldRun(null).run).toBe(true)
    expect(shouldRun('  ').run).toBe(true)
  })

  /*
   * An `if:` is an expression whether or not it is wrapped, which is why a bare
   * string cannot be read as a literal: `if: false` is the boolean, not a
   * non-empty string that happens to spell one.
   */
  test('a bare condition is an expression, wrapped or not', () => {
    expect(shouldRun('false').run).toBe(false)
    expect(shouldRun('${{ false }}').run).toBe(false)
    expect(shouldRun('github.ref == \'refs/heads/main\'', { github: { ref: 'refs/heads/main' } }).run).toBe(true)
    expect(shouldRun('${{ github.ref == \'refs/heads/main\' }}', { github: { ref: 'refs/heads/dev' } }).run).toBe(false)
  })

  /*
   * The direction that matters. Running on an unreadable condition deploys
   * somebody's code because they made a typo.
   */
  test('a condition that cannot be read does not run, and says why', () => {
    const answer = shouldRun('github.ref == ')

    expect(answer.run).toBe(false)
    expect(answer.reason).toBeTruthy()
  })

  test('and the reason names the condition when it simply was not true', () => {
    expect(shouldRun('1 == 2').reason).toContain('1 == 2')
  })
})

describe('interpolation', () => {
  test('fills what it can', () => {
    expect(interpolate('deploy-${{ github.ref_name }}', { github: { ref_name: 'main' } })).toBe('deploy-main')
  })

  test('leaves what it cannot exactly as written', () => {
    // The same direction as everywhere else here: an expression this does not
    // understand stays visible rather than becoming an empty string somebody
    // has to explain.
    expect(interpolate('x-${{ hashFiles(\'a\') }}', {})).toBe('x-${{ hashFiles(\'a\') }}')
  })

  test('an object interpolates as JSON, the way Actions renders one', () => {
    expect(interpolate('${{ thing }}', { thing: { a: 1 } })).toBe('{"a":1}')
  })
})

describe('what the language deliberately cannot do', () => {
  /*
   * The grammar is closed. An expression comes out of a file in a repository,
   * which on a public instance means it comes from a stranger - and evaluating
   * it with the language's own evaluator would hand that stranger this process.
   */
  test('it cannot reach the host language', () => {
    for (const attempt of [
      'constructor.constructor(\'return 1\')()',
      'process.env',
      'globalThis',
      'this',
      '[].constructor',
    ]) {
      const result = evaluateExpression(attempt, {})

      // Either a parse error or a null lookup; never a value from the host.
      expect(result.value === null || result.ok === false).toBe(true)
    }
  })

  test('and a name that happens to exist on an object prototype is not reachable', () => {
    expect(value('thing.toString', { thing: { a: 1 } })).toBeNull()
    expect(value('thing.__proto__', { thing: { a: 1 } })).toBeNull()
  })
})

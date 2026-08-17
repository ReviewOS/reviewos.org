/**
 * The expression language: `${{ ... }}` and `if:`.
 *
 * Everything else in this phase has been able to store what a file said and
 * defer the meaning. `if:` cannot: a job or a step with a condition either runs
 * or does not, and there is no third answer to record. So this is the piece
 * that decides, and it is written as a small lexer, a Pratt parser, and an
 * evaluator over a context - not as a regular expression, and never as
 * `new Function`.
 *
 * **Nothing here executes JavaScript.** That is not a performance decision. An
 * expression comes out of a file in a repository, which on a public instance
 * means it comes from a stranger; evaluating it with the language's own
 * evaluator would hand that stranger the control plane's process. The grammar
 * below is closed: it can read the context it is given, call the functions
 * named here, and produce a value. It cannot reach anything else, and there is
 * no escape hatch to add later without noticing.
 *
 * GitHub's semantics are copied deliberately, including the parts that look
 * wrong: values are loosely compared after coercion to number, `&&` and `||`
 * return operands rather than booleans, and an undefined property is null
 * rather than an error. A workflow that behaves differently here than on
 * Actions is a workflow somebody has to debug twice.
 */

export type ExpressionValue = string | number | boolean | null | ExpressionValue[] | { [key: string]: ExpressionValue }

export interface ExpressionContext {
  [name: string]: unknown
}

export interface EvaluationResult {
  ok: boolean
  value: ExpressionValue
  /** Why it could not be evaluated, in words for the person who wrote it. */
  error: string | null
}

/* ------------------------------------------------------------------ lexing */

type TokenKind = 'name' | 'number' | 'string' | 'operator' | 'end'

interface Token {
  kind: TokenKind
  text: string
  position: number
}

const OPERATORS = ['&&', '||', '==', '!=', '<=', '>=', '(', ')', '[', ']', '.', ',', '!', '<', '>', '*']

function tokenize(source: string): Token[] {
  const tokens: Token[] = []
  let index = 0

  while (index < source.length) {
    const char = source[index]!

    if (/\s/.test(char)) {
      index++
      continue
    }

    // A single-quoted string, with '' as the escape - the only one the
    // language has. "double quotes" are not a string here, which surprises
    // people once; it is a syntax error rather than a silent second meaning.
    if (char === '\'') {
      let text = ''
      index++

      while (index < source.length) {
        if (source[index] === '\'') {
          if (source[index + 1] === '\'') {
            text += '\''
            index += 2
            continue
          }

          break
        }

        text += source[index]
        index++
      }

      if (source[index] !== '\'')
        throw new ExpressionError('a string is not closed', index)

      index++
      tokens.push({ kind: 'string', text, position: index })
      continue
    }

    if (/[0-9]/.test(char) || (char === '-' && /[0-9]/.test(source[index + 1] ?? ''))) {
      let text = char
      index++

      while (index < source.length && /[0-9.eExXa-fA-F+-]/.test(source[index]!)) {
        // Stop before an operator that happens to share a character with a
        // number's tail: `1-2` is a subtraction the language does not have, so
        // it must not be swallowed into the literal.
        if (/[+-]/.test(source[index]!) && !/[eE]/.test(text[text.length - 1] ?? ''))
          break

        text += source[index]
        index++
      }

      tokens.push({ kind: 'number', text, position: index })
      continue
    }

    if (/[a-z_$]/i.test(char)) {
      let text = ''

      while (index < source.length && /[a-z0-9_$-]/i.test(source[index]!)) {
        text += source[index]
        index++
      }

      tokens.push({ kind: 'name', text, position: index })
      continue
    }

    const operator = OPERATORS.find(candidate => source.startsWith(candidate, index))

    if (!operator)
      throw new ExpressionError(`\`${char}\` is not part of this language`, index)

    index += operator.length
    tokens.push({ kind: 'operator', text: operator, position: index })
  }

  tokens.push({ kind: 'end', text: '', position: index })

  return tokens
}

export class ExpressionError extends Error {
  constructor(message: string, readonly position: number) {
    super(message)
    this.name = 'ExpressionError'
  }
}

/* ----------------------------------------------------------------- parsing */

type Node =
  | { type: 'literal', value: ExpressionValue }
  | { type: 'name', name: string }
  | { type: 'property', target: Node, name: string }
  | { type: 'index', target: Node, index: Node }
  | { type: 'star', target: Node }
  | { type: 'call', name: string, args: Node[] }
  | { type: 'not', operand: Node }
  | { type: 'binary', operator: string, left: Node, right: Node }

/** Tighter binds later. `&&` before `||`, comparisons before both. */
const PRECEDENCE: Record<string, number> = {
  '||': 1,
  '&&': 2,
  '==': 3,
  '!=': 3,
  '<': 4,
  '<=': 4,
  '>': 4,
  '>=': 4,
}

function parse(tokens: Token[]): Node {
  let position = 0

  const peek = (): Token => tokens[position]!
  const next = (): Token => tokens[position++]!

  const expect = (text: string): void => {
    const token = next()

    if (token.text !== text)
      throw new ExpressionError(`expected \`${text}\``, token.position)
  }

  function parsePrimary(): Node {
    const token = next()

    if (token.kind === 'number')
      return { type: 'literal', value: Number(token.text) }

    if (token.kind === 'string')
      return { type: 'literal', value: token.text }

    if (token.kind === 'operator' && token.text === '(') {
      const inner = parseExpression(0)
      expect(')')
      return inner
    }

    if (token.kind === 'operator' && token.text === '!')
      return { type: 'not', operand: parseUnary() }

    if (token.kind === 'name') {
      const word = token.text.toLowerCase()

      if (word === 'true')
        return { type: 'literal', value: true }

      if (word === 'false')
        return { type: 'literal', value: false }

      if (word === 'null')
        return { type: 'literal', value: null }

      if (peek().text === '(' && peek().kind === 'operator') {
        next()
        const args: Node[] = []

        if (peek().text !== ')') {
          args.push(parseExpression(0))

          while (peek().text === ',') {
            next()
            args.push(parseExpression(0))
          }
        }

        expect(')')

        return { type: 'call', name: token.text, args }
      }

      return { type: 'name', name: token.text }
    }

    throw new ExpressionError(`unexpected \`${token.text || 'end of expression'}\``, token.position)
  }

  function parseAccessors(target: Node): Node {
    let node = target

    for (;;) {
      const token = peek()

      if (token.kind === 'operator' && token.text === '.') {
        next()
        const name = next()

        // `steps.*.outcome` - the star is a filter over a collection, and it
        // is the one piece of syntax that is not property access.
        if (name.kind === 'operator' && name.text === '*') {
          node = { type: 'star', target: node }
          continue
        }

        if (name.kind !== 'name' && name.kind !== 'number')
          throw new ExpressionError('expected a property name after `.`', name.position)

        node = { type: 'property', target: node, name: name.text }
        continue
      }

      if (token.kind === 'operator' && token.text === '[') {
        next()
        const index = parseExpression(0)
        expect(']')
        node = { type: 'index', target: node, index }
        continue
      }

      return node
    }
  }

  function parseUnary(): Node {
    const token = peek()

    if (token.kind === 'operator' && token.text === '!') {
      next()
      return { type: 'not', operand: parseUnary() }
    }

    return parseAccessors(parsePrimary())
  }

  function parseExpression(minimum: number): Node {
    let left = parseUnary()

    for (;;) {
      const token = peek()
      const precedence = token.kind === 'operator' ? PRECEDENCE[token.text] : undefined

      if (precedence === undefined || precedence < minimum)
        return left

      next()
      const right = parseExpression(precedence + 1)
      left = { type: 'binary', operator: token.text, left, right }
    }
  }

  const node = parseExpression(0)
  const trailing = peek()

  if (trailing.kind !== 'end')
    throw new ExpressionError(`unexpected \`${trailing.text}\``, trailing.position)

  return node
}

/* -------------------------------------------------------------- evaluating */

/**
 * GitHub's coercion, which is the part people trip over.
 *
 * Comparison converts both sides to numbers: `'' == 0` is true, `'abc' == 0`
 * is false because `abc` is NaN, and `null == 0` is true. Copied rather than
 * corrected - a workflow that behaves differently here than on Actions is one
 * somebody has to debug twice.
 */
function toNumber(value: unknown): number {
  if (value === null || value === undefined)
    return 0

  if (typeof value === 'boolean')
    return value ? 1 : 0

  if (typeof value === 'number')
    return value

  if (typeof value === 'string') {
    const text = value.trim()

    if (text === '')
      return 0

    const parsed = Number(text)

    return Number.isNaN(parsed) ? Number.NaN : parsed
  }

  return Number.NaN
}

/** Truthiness, which is *not* JavaScript's: an empty object is true here. */
function toBoolean(value: unknown): boolean {
  if (value === null || value === undefined)
    return false

  if (typeof value === 'boolean')
    return value

  if (typeof value === 'number')
    return value !== 0 && !Number.isNaN(value)

  if (typeof value === 'string')
    return value !== ''

  return true
}

function toDisplay(value: unknown): string {
  if (value === null || value === undefined)
    return ''

  if (typeof value === 'object')
    return JSON.stringify(value)

  return String(value)
}

function looseEquals(left: unknown, right: unknown): boolean {
  if (typeof left === 'string' && typeof right === 'string')
    return left.toLowerCase() === right.toLowerCase()

  if (typeof left === 'object' && left !== null && typeof right === 'object' && right !== null)
    return left === right

  const one = toNumber(left)
  const two = toNumber(right)

  if (Number.isNaN(one) || Number.isNaN(two))
    return false

  return one === two
}

const FUNCTIONS = new Set([
  'contains', 'startswith', 'endswith', 'format', 'join', 'tojson', 'fromjson',
  'hashfiles', 'success', 'always', 'cancelled', 'failure',
])

function callFunction(name: string, args: ExpressionValue[], context: ExpressionContext): ExpressionValue {
  const word = name.toLowerCase()

  switch (word) {
    case 'contains': {
      const [haystack, needle] = args

      if (Array.isArray(haystack))
        return haystack.some(item => looseEquals(item, needle))

      return toDisplay(haystack).toLowerCase().includes(toDisplay(needle).toLowerCase())
    }

    case 'startswith':
      return toDisplay(args[0]).toLowerCase().startsWith(toDisplay(args[1]).toLowerCase())

    case 'endswith':
      return toDisplay(args[0]).toLowerCase().endsWith(toDisplay(args[1]).toLowerCase())

    case 'format': {
      const [template, ...rest] = args

      // `{0}` with `{{` and `}}` as the escapes, which is why a format string
      // full of braces is the one place a workflow legitimately writes them.
      return toDisplay(template).replace(/\{\{|\}\}|\{(\d+)\}/g, (match, digits) => {
        if (match === '{{')
          return '{'

        if (match === '}}')
          return '}'

        return toDisplay(rest[Number(digits)])
      })
    }

    case 'join': {
      const [value, separator] = args
      const parts = Array.isArray(value) ? value : [value]

      return parts.map(item => toDisplay(item)).join(separator === undefined ? ',' : toDisplay(separator))
    }

    case 'tojson':
      return JSON.stringify(args[0] ?? null) ?? 'null'

    case 'fromjson': {
      try {
        return JSON.parse(toDisplay(args[0]))
      }
      catch {
        throw new ExpressionError('fromJSON was given something that is not JSON', 0)
      }
    }

    /*
     * The status functions read the job's state rather than computing
     * anything, so they are context, not logic. `success()` with nothing to
     * report is true, which is what makes `if: success()` the default
     * behaviour written out.
     */
    case 'success':
      return statusOf(context) === 'success'

    case 'failure':
      return statusOf(context) === 'failure'

    case 'cancelled':
      return statusOf(context) === 'cancelled'

    case 'always':
      return true

    /*
     * `hashFiles` reads the checked-out tree, which this side does not have.
     * Refused rather than answered with a fake digest: a wrong hash silently
     * restores the wrong cache, and that is a bug people chase for days.
     */
    case 'hashfiles':
      throw new ExpressionError('hashFiles needs a checkout, which the control plane does not have', 0)

    default:
      throw new ExpressionError(`\`${name}\` is not a function in this language`, 0)
  }
}

function statusOf(context: ExpressionContext): string {
  const job = context.job as { status?: unknown } | undefined

  return String(job?.status ?? 'success').toLowerCase()
}

function evaluateNode(node: Node, context: ExpressionContext): ExpressionValue {
  switch (node.type) {
    case 'literal':
      return node.value

    case 'name': {
      const value = context[node.name]

      // An unknown name is null rather than an error, which is GitHub's rule
      // and the one that keeps a condition reading an environment variable
      // working on a workflow where that variable is set only sometimes.
      return (value ?? null) as ExpressionValue
    }

    case 'property': {
      const target = evaluateNode(node.target, context)

      if (target === null || typeof target !== 'object')
        return null

      if (Array.isArray(target)) {
        // A property read over an array collects it from every element, which
        // is how `steps.*.outputs.thing` keeps working after the star.
        return target
          .map(item => own(item, node.name))
          .filter(item => item !== null) as ExpressionValue
      }

      return own(target, node.name)
    }

    case 'index': {
      const target = evaluateNode(node.target, context)
      const index = evaluateNode(node.index, context)

      if (target === null || typeof target !== 'object')
        return null

      if (Array.isArray(target)) {
        const position = toNumber(index)

        return Number.isNaN(position) ? null : (target[position] ?? null)
      }

      return own(target, toDisplay(index))
    }

    case 'star': {
      const target = evaluateNode(node.target, context)

      if (Array.isArray(target))
        return target

      if (target && typeof target === 'object')
        return Object.values(target) as ExpressionValue

      return []
    }

    case 'call': {
      if (!FUNCTIONS.has(node.name.toLowerCase()))
        throw new ExpressionError(`\`${node.name}\` is not a function in this language`, 0)

      return callFunction(node.name, node.args.map(arg => evaluateNode(arg, context)), context)
    }

    case 'not':
      return !toBoolean(evaluateNode(node.operand, context))

    case 'binary': {
      const left = evaluateNode(node.left, context)

      /*
       * `&&` and `||` return an operand rather than a boolean, the way
       * JavaScript does and unlike most template languages. People rely on it:
       * `${{ inputs.name || 'default' }}` is the idiom for a fallback.
       */
      if (node.operator === '&&')
        return toBoolean(left) ? evaluateNode(node.right, context) : left

      if (node.operator === '||')
        return toBoolean(left) ? left : evaluateNode(node.right, context)

      const right = evaluateNode(node.right, context)

      switch (node.operator) {
        case '==':
          return looseEquals(left, right)
        case '!=':
          return !looseEquals(left, right)
        case '<':
          return compare(left, right, (one, two) => one < two)
        case '<=':
          return compare(left, right, (one, two) => one <= two)
        case '>':
          return compare(left, right, (one, two) => one > two)
        case '>=':
          return compare(left, right, (one, two) => one >= two)
        default:
          throw new ExpressionError(`\`${node.operator}\` is not an operator here`, 0)
      }
    }
  }
}

/**
 * A property of the object itself, never of its prototype.
 *
 * `thing.toString` must be null rather than a function. The grammar cannot call
 * anything outside the closed function list, so returning one is not an escape
 * on its own - but a value that leaks a host function into a comparison or a
 * rendered string is the first half of an escape, and there is no reading of
 * `toString` in a workflow that means the host's.
 */
function own(target: unknown, name: string): ExpressionValue {
  if (!target || typeof target !== 'object')
    return null

  return Object.hasOwn(target as object, name)
    ? (((target as any)[name] ?? null) as ExpressionValue)
    : null
}

function compare(left: unknown, right: unknown, decide: (one: number, two: number) => boolean): boolean {
  const one = toNumber(left)
  const two = toNumber(right)

  // NaN compares false in every direction, which is the same answer people get
  // from the language they already know.
  if (Number.isNaN(one) || Number.isNaN(two))
    return false

  return decide(one, two)
}

/* -------------------------------------------------------------------- API */

/**
 * Evaluate one expression against a context.
 *
 * Never throws: a workflow with a broken condition should show the reason on
 * its run rather than take down whatever was walking the file.
 */
export function evaluateExpression(source: string, context: ExpressionContext = {}): EvaluationResult {
  try {
    const node = parse(tokenize(source))

    return { ok: true, value: evaluateNode(node, context), error: null }
  }
  catch (error) {
    return {
      ok: false,
      value: null,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * The status functions, which decide whether a condition carries an implied
 * `success()`.
 *
 * Matched on the name followed by its parenthesis, so a context value called
 * `steps.always.outputs.x` is not mistaken for the function.
 */
const STATUS_FUNCTIONS = /\b(?:success|always|cancelled|failure)\s*\(/i

/**
 * Whether a job or step with this `if:` should run.
 *
 * Three rules that are not obvious and all matter:
 *
 * - **An `if:` is an expression whether or not it is wrapped in `${{ }}`.**
 *   `if: github.ref == 'refs/heads/main'` and `if: ${{ ... }}` are the same
 *   thing, which is why a bare string cannot be read as a literal.
 * - **A condition that names no status function carries an implied
 *   `success() &&`**, and no condition at all means `success()`. This is
 *   Actions' most surprising documented rule and it is load-bearing: without
 *   it, every step after a failing one runs, because a step with no `if:`
 *   would be unconditionally true. `if: always()` exists precisely to ask for
 *   the absence of the implied check, and a workflow that writes it is telling
 *   you the default is the other way.
 * - **A condition that cannot be evaluated does not run the step.** The other
 *   direction runs somebody's deployment because their condition had a typo.
 */
export function shouldRun(condition: string | null | undefined, context: ExpressionContext = {}): { run: boolean, reason: string } {
  const text = String(condition ?? '').trim()

  /*
   * The status of whatever this belongs to. Absent means nothing has reported
   * yet, which is a success - the same answer `success()` gives, written out
   * rather than special-cased, so a job decided at dispatch behaves the way a
   * step decided mid-run does.
   */
  const status = String((context.job as any)?.status ?? 'success')
  const failed = status === 'failure' || status === 'cancelled'

  if (!text) {
    return failed
      ? { run: false, reason: `the job is ${status}, and this step has no \`if:\` asking to run anyway` }
      : { run: true, reason: 'no condition' }
  }

  const inner = text.startsWith('${{') && text.endsWith('}}')
    ? text.slice(3, -2).trim()
    : text

  if (failed && !STATUS_FUNCTIONS.test(inner)) {
    return {
      run: false,
      reason: `the job is ${status}, and \`${inner}\` names no status function - Actions implies \`success() &&\``,
    }
  }

  const result = evaluateExpression(inner, context)

  if (!result.ok)
    return { run: false, reason: result.error ?? 'the condition could not be read' }

  return {
    run: toBoolean(result.value),
    reason: toBoolean(result.value) ? `\`${inner}\` is true` : `\`${inner}\` is false`,
  }
}

/**
 * Fill `${{ ... }}` in a string, leaving what it cannot evaluate as written.
 *
 * The same direction as everywhere else here: an expression this does not
 * understand stays visible rather than becoming an empty string somebody has
 * to explain.
 */
export function interpolate(source: string, context: ExpressionContext = {}): string {
  return source.replace(/\$\{\{([\s\S]*?)\}\}/g, (whole, inner) => {
    const result = evaluateExpression(String(inner), context)

    return result.ok ? toDisplay(result.value) : whole
  })
}

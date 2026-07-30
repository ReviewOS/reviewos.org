/**
 * The search query language: `is:open author:chris label:"needs design" -label:wontfix rebase`.
 *
 * A real tokenizer rather than a regex, because the two things people actually
 * do to a search box both break the regex version: quoting a value that
 * contains a space, and negating a qualifier. A regex that handles neither
 * silently searches for the literal text `label:"needs design"` and returns
 * nothing, which reads as "there are no results" rather than "the query was
 * not understood".
 *
 * Pure: this turns a string into a structure. Applying it to a database, and
 * enforcing what the reader is allowed to see, is the caller's job — visibility
 * is never left to the query, because a query is user input.
 */

export interface Qualifier {
  key: string
  value: string
  /** True for `-label:wontfix`: the result must NOT match. */
  negated: boolean
  /** Set for `comments:>10`, `created:<2026-01-01`. */
  operator?: '>' | '<' | '>=' | '<='
}

export interface ParsedQuery {
  /** Free text, in the order it was written. */
  terms: string[]
  qualifiers: Qualifier[]
  /** Terms that were quoted, which must match as a phrase. */
  phrases: string[]
}

interface Token {
  text: string
  /** True only when the quote opened the token, which is what makes it a phrase. */
  quoted: boolean
}

/**
 * Split a query into tokens, honouring quotes and backslash escapes.
 *
 * An unterminated quote takes the rest of the string, which is what somebody
 * mid-typing means, rather than discarding their query.
 */
function tokenize(input: string): Token[] {
  const tokens: Token[] = []
  let current = ''
  let quote: '"' | '\'' | null = null
  let quoted = false
  let sawQuote = false
  let escaped = false

  const push = () => {
    if (current.length > 0 || sawQuote)
      tokens.push({ text: current, quoted })
    current = ''
    quoted = false
    sawQuote = false
  }

  for (const character of input) {
    if (escaped) {
      current += character
      escaped = false
      continue
    }

    if (character === '\\') {
      escaped = true
      continue
    }

    if (quote) {
      if (character === quote) {
        quote = null
        continue
      }
      current += character
      continue
    }

    if (character === '"' || character === '\'') {
      quote = character
      sawQuote = true
      // Only a quote that opens the token makes it a phrase. A quote after a
      // qualifier's colon — `label:"needs design"` — is quoting the value, and
      // treating that whole token as a phrase turns the filter into a text
      // search that matches nothing.
      if (current.length === 0)
        quoted = true
      continue
    }

    if (character === ' ' || character === '\t' || character === '\n') {
      push()
      continue
    }

    current += character
  }

  push()

  return tokens
}

/** Qualifiers this forge understands. Anything else is treated as free text. */
export const KNOWN_QUALIFIERS = [
  'is',
  'in',
  'type',
  'state',
  'author',
  'assignee',
  'mentions',
  'commenter',
  'involves',
  'reviewer',
  'review',
  'label',
  'milestone',
  'repo',
  'org',
  'user',
  'language',
  'created',
  'updated',
  'closed',
  'merged',
  'comments',
  'stars',
  'forks',
  'base',
  'head',
  'draft',
  'archived',
  'sort',
] as const

export function parseQuery(input: string): ParsedQuery {
  const terms: string[] = []
  const phrases: string[] = []
  const qualifiers: Qualifier[] = []

  for (const token of tokenize(input)) {
    let text = token.text
    let negated = false

    if (!token.quoted && text.startsWith('-') && text.length > 1) {
      negated = true
      text = text.slice(1)
    }

    const separator = token.quoted ? -1 : text.indexOf(':')

    // A quoted token is always text, so searching for a literal `a:b` is
    // possible by quoting it.
    if (separator > 0) {
      const key = text.slice(0, separator).toLowerCase()
      let value = text.slice(separator + 1)

      if ((KNOWN_QUALIFIERS as readonly string[]).includes(key)) {
        let operator: Qualifier['operator']

        const comparison = /^(>=|<=|>|<)/.exec(value)
        if (comparison) {
          operator = comparison[1] as Qualifier['operator']
          value = value.slice(comparison[1]!.length)
        }

        // `label:` with nothing after it is somebody mid-type, not a filter
        // for the empty label.
        if (value.length > 0) {
          qualifiers.push(operator ? { key, value, negated, operator } : { key, value, negated })
          continue
        }
      }
    }

    if (text.length === 0)
      continue

    if (token.quoted)
      phrases.push(text)
    else
      terms.push(negated ? `-${text}` : text)
  }

  return { terms, qualifiers, phrases }
}

/** Every value given for a qualifier, in order. Several `label:` narrow the result. */
export function valuesFor(query: ParsedQuery, key: string, negated = false): string[] {
  return query.qualifiers
    .filter(qualifier => qualifier.key === key && qualifier.negated === negated)
    .map(qualifier => qualifier.value)
}

/** The free-text part, phrases included, as one string for the search engine. */
export function freeText(query: ParsedQuery): string {
  return [...query.terms, ...query.phrases.map(phrase => `"${phrase}"`)].join(' ')
}

export type SortField = 'best' | 'newest' | 'oldest' | 'updated' | 'comments' | 'stars' | 'forks'

/**
 * The sort a query asks for.
 *
 * Unknown sorts fall back to relevance rather than erroring: a mistyped sort
 * should still return results.
 */
export function sortFor(query: ParsedQuery): { field: SortField, direction: 'asc' | 'desc' } {
  const raw = valuesFor(query, 'sort')[0]
  if (!raw)
    return { field: 'best', direction: 'desc' }

  const [name, direction] = raw.toLowerCase().split('-')

  const known: Record<string, SortField> = {
    created: 'newest',
    newest: 'newest',
    oldest: 'oldest',
    updated: 'updated',
    comments: 'comments',
    stars: 'stars',
    forks: 'forks',
  }

  const field = known[name ?? ''] ?? 'best'

  if (field === 'oldest')
    return { field: 'oldest', direction: 'asc' }

  return { field, direction: direction === 'asc' ? 'asc' : 'desc' }
}

/**
 * Turn a query back into a string.
 *
 * Used by the interface when it adds or removes a filter chip: the box must
 * still show something the user could have typed.
 */
export function stringifyQuery(query: ParsedQuery): string {
  const parts: string[] = []

  for (const qualifier of query.qualifiers) {
    const value = /[\s"']/.test(qualifier.value) ? `"${qualifier.value}"` : qualifier.value
    parts.push(`${qualifier.negated ? '-' : ''}${qualifier.key}:${qualifier.operator ?? ''}${value}`)
  }

  parts.push(...query.terms)
  parts.push(...query.phrases.map(phrase => `"${phrase}"`))

  return parts.join(' ')
}

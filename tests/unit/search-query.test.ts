// The search query language.
//
// The two things people do that break a regex-based parser are quoting a value
// with a space in it and negating a qualifier, and both fail silently: the
// query becomes a literal text search that returns nothing, which reads as "no
// results" rather than "not understood". Those cases lead here.

import { describe, expect, test } from 'bun:test'
import { freeText, parseQuery, sortFor, stringifyQuery, valuesFor } from '../../app/Actions/Search/query'

describe('parseQuery', () => {
  test('reads free text', () => {
    expect(parseQuery('rebase crash').terms).toEqual(['rebase', 'crash'])
  })

  test('reads a qualifier', () => {
    expect(parseQuery('is:open').qualifiers).toEqual([{ key: 'is', value: 'open', negated: false }])
  })

  test('reads several qualifiers alongside text', () => {
    const query = parseQuery('is:open author:chris rebase')

    expect(query.qualifiers).toHaveLength(2)
    expect(query.terms).toEqual(['rebase'])
  })

  test('reads a quoted value containing a space', () => {
    const query = parseQuery('label:"needs design"')

    expect(valuesFor(query, 'label')).toEqual(['needs design'])
  })

  test('reads a single-quoted value', () => {
    expect(valuesFor(parseQuery("label:'needs design'"), 'label')).toEqual(['needs design'])
  })

  test('reads a negated qualifier', () => {
    const query = parseQuery('-label:wontfix')

    expect(query.qualifiers[0]).toEqual({ key: 'label', value: 'wontfix', negated: true })
  })

  test('separates negated from plain values of the same key', () => {
    const query = parseQuery('label:bug -label:wontfix')

    expect(valuesFor(query, 'label')).toEqual(['bug'])
    expect(valuesFor(query, 'label', true)).toEqual(['wontfix'])
  })

  test('reads a comparison operator', () => {
    const query = parseQuery('comments:>10')

    expect(query.qualifiers[0]).toEqual({ key: 'comments', value: '10', negated: false, operator: '>' })
  })

  test('reads the two-character operators', () => {
    expect(parseQuery('stars:>=100').qualifiers[0]!.operator).toBe('>=')
    expect(parseQuery('comments:<=2').qualifiers[0]!.operator).toBe('<=')
  })

  test('an unknown qualifier is text, not a filter', () => {
    // Otherwise searching for `http://example.com` becomes a filter on `http`.
    const query = parseQuery('nonsense:value')

    expect(query.qualifiers).toEqual([])
    expect(query.terms).toEqual(['nonsense:value'])
  })

  test('a quoted qualifier-looking string is a phrase', () => {
    const query = parseQuery('"is:open"')

    expect(query.qualifiers).toEqual([])
    expect(query.phrases).toEqual(['is:open'])
  })

  test('a qualifier with nothing after the colon is ignored', () => {
    // Somebody mid-type, not a filter for the empty label.
    const query = parseQuery('label:')

    expect(query.qualifiers).toEqual([])
  })

  test('keeps a phrase separate from loose terms', () => {
    const query = parseQuery('"exact phrase" loose')

    expect(query.phrases).toEqual(['exact phrase'])
    expect(query.terms).toEqual(['loose'])
  })

  test('an unterminated quote takes the rest, rather than losing the query', () => {
    expect(parseQuery('label:"needs design').qualifiers[0]!.value).toBe('needs design')
  })

  test('a backslash escapes a quote', () => {
    expect(parseQuery('"say \\"hi\\""').phrases).toEqual(['say "hi"'])
  })

  test('a lone hyphen is text, not a negation of nothing', () => {
    expect(parseQuery('-').terms).toEqual(['-'])
  })

  test('a negated free term keeps its marker', () => {
    expect(parseQuery('-crash').terms).toEqual(['-crash'])
  })

  test('qualifier keys are case insensitive', () => {
    expect(parseQuery('IS:open').qualifiers[0]!.key).toBe('is')
  })

  test('qualifier values keep their case, since handles and labels do', () => {
    expect(valuesFor(parseQuery('author:Chris'), 'author')).toEqual(['Chris'])
  })

  test('collapses runs of whitespace', () => {
    expect(parseQuery('  a    b  ').terms).toEqual(['a', 'b'])
  })

  test('an empty query parses to nothing', () => {
    expect(parseQuery('')).toEqual({ terms: [], qualifiers: [], phrases: [] })
  })

  test('a colon inside a value survives', () => {
    // `base:refs/heads/main` has to keep its slashes and the value's colon.
    expect(valuesFor(parseQuery('base:refs/heads/main'), 'base')).toEqual(['refs/heads/main'])
  })

  test('a leading colon is text', () => {
    expect(parseQuery(':open').terms).toEqual([':open'])
  })
})

describe('valuesFor', () => {
  test('returns every value for a repeated qualifier', () => {
    expect(valuesFor(parseQuery('label:bug label:urgent'), 'label')).toEqual(['bug', 'urgent'])
  })

  test('returns nothing for an absent qualifier', () => {
    expect(valuesFor(parseQuery('is:open'), 'author')).toEqual([])
  })
})

describe('freeText', () => {
  test('joins terms and re-quotes phrases', () => {
    expect(freeText(parseQuery('is:open rebase "exact phrase"'))).toBe('rebase "exact phrase"')
  })

  test('is empty for a query that is only filters', () => {
    expect(freeText(parseQuery('is:open author:chris'))).toBe('')
  })
})

describe('sortFor', () => {
  test('defaults to relevance', () => {
    expect(sortFor(parseQuery('rebase'))).toEqual({ field: 'best', direction: 'desc' })
  })

  test('reads a sort qualifier', () => {
    expect(sortFor(parseQuery('sort:comments')).field).toBe('comments')
  })

  test('reads a direction', () => {
    expect(sortFor(parseQuery('sort:stars-asc')).direction).toBe('asc')
    expect(sortFor(parseQuery('sort:stars-desc')).direction).toBe('desc')
  })

  test('oldest sorts ascending, whatever else is written', () => {
    expect(sortFor(parseQuery('sort:oldest'))).toEqual({ field: 'oldest', direction: 'asc' })
  })

  test('an unknown sort falls back rather than erroring', () => {
    expect(sortFor(parseQuery('sort:nonsense')).field).toBe('best')
  })
})

describe('stringifyQuery', () => {
  test('round-trips a query with filters and text', () => {
    const original = 'is:open author:chris rebase'

    expect(stringifyQuery(parseQuery(original))).toBe(original)
  })

  test('re-quotes a value that needs it', () => {
    expect(stringifyQuery(parseQuery('label:"needs design"'))).toBe('label:"needs design"')
  })

  test('keeps a negation', () => {
    expect(stringifyQuery(parseQuery('-label:wontfix'))).toBe('-label:wontfix')
  })

  test('keeps an operator', () => {
    expect(stringifyQuery(parseQuery('comments:>10'))).toBe('comments:>10')
  })

  test('parsing its own output gives the same query', () => {
    const query = parseQuery('is:open -label:"wont fix" comments:>=5 "exact phrase" text')

    expect(parseQuery(stringifyQuery(query))).toEqual(query)
  })
})

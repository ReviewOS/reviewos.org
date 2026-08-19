// The trigram index, and the one property it has to have.
//
// The index narrows and `git grep` decides, so the index may be wrong in
// exactly one direction: it may offer a file that turns out not to match
// (costing a grep), and it may never withhold one that does (costing a result
// nobody sees). Most of what is asserted here is that second direction.

import { describe, expect, test } from 'bun:test'
import {
  addDocument,
  candidates,
  candidatesFromText,
  decodeShard,
  decodeSummary,
  emptyShard,
  encodeShard,
  queryTrigrams,
  summaryMightHold,
  summaryOf,
  trigrams,
} from '../../app/Actions/CodeIndex/trigram'

describe('trigrams', () => {
  test('are the sliding windows of three bytes, folded', () => {
    expect([...trigrams('abcd')].sort()).toEqual(['abc', 'bcd'])
    expect([...trigrams('ABCD')].sort()).toEqual(['abc', 'bcd'])
  })

  test('are distinct, so a repeated string does not weigh more', () => {
    expect(trigrams('aaaa').size).toBe(1)
  })

  test('a string shorter than a gram has none', () => {
    expect(trigrams('ab').size).toBe(0)
  })

  test('split bytes rather than characters, because git grep searches bytes', () => {
    // A two-character emoji is eight bytes and therefore six trigrams. Indexing
    // by code point would build an index that agrees with itself and disagrees
    // with the grep that produces the actual answer.
    expect(trigrams('🙂🙂').size).toBeGreaterThan(1)
  })
})

describe('what a query can be narrowed by', () => {
  test('a literal is its own trigrams', () => {
    expect(queryTrigrams('search')).not.toBeNull()
  })

  test('a query too short to have one cannot narrow, and says so', () => {
    // Null rather than an empty set: an empty set of required trigrams reads as
    // "every file qualifies" to one caller and "no file does" to another, and
    // the second finds nothing.
    expect(queryTrigrams('ab')).toBeNull()
  })

  test('an alternation refuses to narrow rather than narrowing wrongly', () => {
    // `foo|bar` matches a file holding only `bar`, which has none of `foo`'s
    // trigrams. Narrowing on either would hide half the results.
    expect(queryTrigrams('foo|bar', true)).toBeNull()
  })

  test('an optional run refuses too', () => {
    // `colou?r` matches `color`, which does not contain `our`.
    expect(queryTrigrams('colou?r', true)).toBeNull()
  })

  test('a quantifier over a class still narrows by the literal beside it', () => {
    // The shape people actually type. Refusing it would decline to help on most
    // real regex searches.
    const grams = queryTrigrams('^\\s*function handleRequest', true)

    expect(grams).not.toBeNull()
    expect([...grams!]).toContain('han')
  })

  test('a regex of only metacharacters cannot narrow', () => {
    expect(queryTrigrams('^.$', true)).toBeNull()
  })
})

describe('candidates', () => {
  const shard = emptyShard('main', 'abc123')
  addDocument(shard, 'src/cart.ts', 'function addToCart(item) { return item }')
  addDocument(shard, 'src/user.ts', 'function findUser(id) { return id }')
  addDocument(shard, 'README.md', 'A shop.')

  test('offers the files that hold every trigram of the query', () => {
    expect(candidates(shard, trigrams('addToCart'))).toEqual(['src/cart.ts'])
  })

  test('offers both when both could match', () => {
    expect(candidates(shard, trigrams('function')).sort()).toEqual(['src/cart.ts', 'src/user.ts'])
  })

  test('answers nothing only when a trigram appears in no file at all', () => {
    // The one case the index may answer on its own, and the common one across
    // an instance: an identifier that simply is not there.
    expect(candidates(shard, trigrams('parseTelemetry'))).toEqual([])
  })

  test('no required trigrams means every file, not no files', () => {
    expect(candidates(shard, new Set()).length).toBe(3)
  })
})

describe('a shard on disk', () => {
  test('survives a round trip', () => {
    const shard = emptyShard('main', 'deadbeef')
    addDocument(shard, 'a.ts', 'const alpha = 1')
    addDocument(shard, 'b.ts', 'const beta = 2')
    shard.skipped = 4

    const back = decodeShard(encodeShard(shard))

    expect(back).not.toBeNull()
    expect(back!.ref).toBe('main')
    expect(back!.commit).toBe('deadbeef')
    expect(back!.skipped).toBe(4)
    expect(back!.paths).toEqual(['a.ts', 'b.ts'])
    expect(candidates(back!, trigrams('alpha'))).toEqual(['a.ts'])
  })

  test('holds trigrams containing bytes that would break a line', () => {
    // A newline, a space and a tab are ordinary bytes in source code, and all
    // three would corrupt a line-oriented format written naively.
    const shard = emptyShard('main', 'x')
    addDocument(shard, 'a.ts', 'a\nb\tc d')

    const back = decodeShard(encodeShard(shard))

    expect(back).not.toBeNull()
    expect(candidates(back!, trigrams('b\tc'))).toEqual(['a.ts'])
  })

  test('an unrecognised format is rebuilt rather than half-read', () => {
    expect(decodeShard('# something else\n')).toBeNull()
    expect(decodeShard('')).toBeNull()
  })
})

describe('the summary at the head of a shard', () => {
  const shard = emptyShard('main', 'c0ffee')
  addDocument(shard, 'src/cart.ts', 'function addToCart(item) {}')

  test('says no with certainty and yes with a maybe', () => {
    const bitmap = summaryOf(shard)

    expect(summaryMightHold(bitmap, trigrams('addToCart'))).toBe(true)
    // A trigram of a word nothing in the shard contains.
    expect(summaryMightHold(bitmap, trigrams('quixotic'))).toBe(false)
  })

  test('is readable from a prefix of the file, which is the point of it', () => {
    const text = encodeShard(shard)
    // The first four lines and the bitmap: no file table, no postings.
    const prefix = text.slice(0, 80_000)
    const summary = decodeSummary(prefix)

    expect(summary).not.toBeNull()
    expect(summary!.commit).toBe('c0ffee')
    expect(summaryMightHold(summary!.bitmap, trigrams('addToCart'))).toBe(true)
  })

  test('a truncated read decodes to nothing rather than to an empty map', () => {
    // The dangerous failure: a short bitmap tests as "bit not set" for
    // everything, which would exclude every repository from every search.
    expect(decodeSummary(encodeShard(shard).slice(0, 200))).toBeNull()
  })
})

describe('reading candidates without decoding the whole shard', () => {
  const shard = emptyShard('main', 'abc')
  addDocument(shard, 'src/cart.ts', 'function addToCart(item) {}')
  addDocument(shard, 'src/user.ts', 'function findUser(id) {}')
  const text = encodeShard(shard)

  test('agrees with the full decode', () => {
    expect(candidatesFromText(text, trigrams('addToCart'))).toEqual(['src/cart.ts'])
    expect(candidatesFromText(text, trigrams('function'))!.sort()).toEqual(['src/cart.ts', 'src/user.ts'])
  })

  test('a trigram with no posting line at all means nothing matches', () => {
    expect(candidatesFromText(text, trigrams('parseTelemetry'))).toEqual([])
  })

  test('an empty query returns every path rather than none', () => {
    expect(candidatesFromText(text, new Set())!.length).toBe(2)
  })

  test('refuses a file it does not recognise', () => {
    expect(candidatesFromText('nonsense', trigrams('abc'))).toBeNull()
  })
})

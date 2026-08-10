// Searching a repository's code.
//
// Two things are worth pinning here and they are not the obvious one. Not
// "does grep find the word" - git does that - but **what arguments it is asked
// with**, because a pattern is user input arriving at a program with its own
// flags, and **how its output is read**, because the separators it uses also
// occur in paths and in code.

import { describe, expect, test } from 'bun:test'
import { parseMatches, pathspecs, searchArgs } from '../../app/Actions/Browse/search'

describe('what git is asked', () => {
  test('a literal search is fixed-strings, not a regex', () => {
    /*
     * The default that matters. Somebody searching for `foo(bar)` or `a.b.c`
     * means those characters; as a regex the first is a group and the second is
     * three wildcards, so the results are wrong in the way that looks like the
     * code is not there.
     */
    expect(searchArgs({ pattern: 'a.b.c', ref: 'main' })).toContain('--fixed-strings')
  })

  test('and asking for a regex gets one', () => {
    const args = searchArgs({ pattern: 'foo.*bar', ref: 'main', regex: true })

    expect(args).toContain('--extended-regexp')
    expect(args).not.toContain('--fixed-strings')
  })

  test('the pattern goes behind -e, so a flag-shaped one is a pattern', () => {
    /*
     * Without `-e`, searching for `--help` prints git's help into the page and
     * searching for `-P` quietly switches the regex engine. There is no shell
     * here, so this is not injection - it is git reading its own flags, which
     * is the same problem with a different name.
     */
    const args = searchArgs({ pattern: '--help', ref: 'main' })

    expect(args[args.indexOf('-e') + 1]).toBe('--help')
  })

  test('paths go after --, so a path-shaped one is a path', () => {
    const args = searchArgs({ pattern: 'x', ref: 'main', paths: ['src'] })
    const separator = args.indexOf('--')

    expect(separator).toBeGreaterThan(-1)
    expect(args.slice(separator + 1)).toEqual(['src'])
  })

  test('the ref comes before the paths', () => {
    // Reversed, git reads the ref as a path and finds nothing - a search that
    // returns no results on a repository that plainly contains the word.
    const args = searchArgs({ pattern: 'x', ref: 'main', paths: ['src'] })

    expect(args.indexOf('main')).toBeLessThan(args.indexOf('--'))
  })

  test('context is bounded', () => {
    // Ten either side is already more than a result row can show, and an
    // unbounded one is a caller asking for the whole file per match.
    expect(searchArgs({ pattern: 'x', ref: 'main', context: 500 })).toContain('--context=10')
    expect(searchArgs({ pattern: 'x', ref: 'main', context: -5 }).some(one => one.startsWith('--context'))).toBe(false)
  })

  test('case-insensitive by default, because that is what people mean', () => {
    expect(searchArgs({ pattern: 'x', ref: 'main' })).toContain('--ignore-case')
    expect(searchArgs({ pattern: 'x', ref: 'main', caseSensitive: true })).not.toContain('--ignore-case')
  })
})

describe('narrowing by path and language', () => {
  test('a language becomes its extensions', () => {
    expect(pathspecs({ pattern: 'x', ref: 'main', language: 'typescript' })).toEqual(['*.ts', '*.tsx', '*.mts', '*.cts'])
  })

  test('an unknown language narrows nothing rather than everything', () => {
    // Returning an impossible pathspec would answer "no results" for a
    // repository that has them, which reads as the search being broken.
    expect(pathspecs({ pattern: 'x', ref: 'main', language: 'cobol', paths: ['src'] })).toEqual(['src'])
  })

  test('a language and a path narrow together, not apart', () => {
    /*
     * `git grep` treats multiple pathspecs as alternatives, so passing `src`
     * and `*.ts` returns every TypeScript file in the repository *and* every
     * file under `src` - the opposite of narrowing, and not what anybody asking
     * for "TypeScript under src" expects.
     */
    expect(pathspecs({ pattern: 'x', ref: 'main', language: 'go', paths: ['src'] })).toEqual(['src/**/*.go'])
  })

  test('a path naming a file is left alone', () => {
    expect(pathspecs({ pattern: 'x', ref: 'main', language: 'go', paths: ['main.go'] })).toEqual(['main.go'])
  })

  test('a magic pathspec is refused', () => {
    // `:(exclude)` and friends are git's own syntax, and one arriving from a
    // query string should be a path rather than an instruction.
    expect(pathspecs({ pattern: 'x', ref: 'main', paths: [':(exclude)src', 'app'] })).toEqual(['app'])
  })
})

describe('reading what git printed', () => {
  test('a match is path, line, text', () => {
    expect(parseMatches('src/cart.ts:42:const total = 1')).toEqual([
      { path: 'src/cart.ts', line: 42, text: 'const total = 1', before: [], after: [] },
    ])
  })

  test('a colon in the code does not become part of the path', () => {
    /*
     * The separator occurs in the thing it separates, which is why this is
     * parsed leftmost-twice rather than split. `path.split(':')` gives a path
     * of `src/cart.ts`, a line of `42`, and a text of `const a` - losing
     * everything after the colon in the code.
     */
    const matches = parseMatches('src/cart.ts:42:const a = { b: 1 }')

    expect(matches[0]!.path).toBe('src/cart.ts')
    expect(matches[0]!.text).toBe('const a = { b: 1 }')
  })

  test('a colon in the path survives too', () => {
    /*
     * git escapes neither separator, so both occur in real paths. Split at the
     * first two colons this reads a path of `src/weird` and a line of
     * `name.ts`, fails, and drops a genuine match - so the split is chosen by
     * what is between the separators being a line number.
     */
    const matches = parseMatches('src/weird:name.ts:7:x')

    expect(matches[0]!.path).toBe('src/weird:name.ts')
    expect(matches[0]!.line).toBe(7)
    expect(matches[0]!.text).toBe('x')
  })

  test('and a line of code that looks like output does not confuse it', () => {
    // The text here contains its own `:12:` pair. The leftmost valid split
    // wins, which is the one git actually wrote.
    const matches = parseMatches('src/a.ts:7:log("b.ts:12:oops")')

    expect(matches[0]!.path).toBe('src/a.ts')
    expect(matches[0]!.line).toBe(7)
    expect(matches[0]!.text).toBe('log("b.ts:12:oops")')
  })

  test('context lines land on the right side of their match', () => {
    /*
     * `git grep --context` interleaves them, and a leading line arrives before
     * the match it belongs to. Attached to the wrong side, a result reads as
     * though the code above it is below it - which is worse than no context,
     * because it is confidently wrong.
     */
    const output = [
      'src/cart.ts-40-function total() {',
      'src/cart.ts-41-  // add up',
      'src/cart.ts:42:  return sum',
      'src/cart.ts-43-}',
    ].join('\n')

    const [match] = parseMatches(output)

    expect(match!.line).toBe(42)
    expect(match!.before).toEqual(['function total() {', '  // add up'])
    expect(match!.after).toEqual(['}'])
  })

  test('a separator starts a new run', () => {
    const output = [
      'a.ts-1-before',
      'a.ts:2:hit',
      '--',
      'b.ts-9-other',
      'b.ts:10:hit',
    ].join('\n')

    const matches = parseMatches(output)

    expect(matches.length).toBe(2)
    // Without the separator resetting, `other` would be trailing context on the
    // first match as well as leading context on the second.
    expect(matches[0]!.after).toEqual([])
    expect(matches[1]!.before).toEqual(['other'])
  })

  test('the cap is honoured', () => {
    // A one-character search matches every line in the repository, and a
    // response carrying them is a page that does not render.
    const output = Array.from({ length: 50 }, (_, index) => `a.ts:${index + 1}:x`).join('\n')

    expect(parseMatches(output, 10).length).toBe(10)
  })

  test('and empty output is no matches rather than a failure', () => {
    expect(parseMatches('')).toEqual([])
  })
})

describe('the ref prefix git adds', () => {
  test('comes off the path', () => {
    /*
     * `git grep <pattern> main` prints `main:src/cart.ts:3:...`, because it is
     * reporting a path inside a tree object rather than in a working
     * directory. Left on, every result path is wrong by a prefix and every link
     * built from one is a 404 - and it only appears when a ref is passed, which
     * is always here and never in the shell where somebody would notice.
     */
    const matches = parseMatches('main:src/cart.ts:3:return items', 200, 'main')

    expect(matches[0]!.path).toBe('src/cart.ts')
  })

  test('and a path that merely starts with the ref name is left alone', () => {
    // `mainly/thing.ts` is not `main:` and must survive intact.
    const matches = parseMatches('mainly/thing.ts:1:x', 200, 'main')

    expect(matches[0]!.path).toBe('mainly/thing.ts')
  })

  test('a ref with a slash in it works too', () => {
    const matches = parseMatches('fix/rounding:src/a.ts:9:x', 200, 'fix/rounding')

    expect(matches[0]!.path).toBe('src/a.ts')
  })
})

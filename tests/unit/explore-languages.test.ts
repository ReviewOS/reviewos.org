// What a repository is written in.
//
// Every decision here is about not being confidently wrong. A breakdown is read
// as a fact about a project - it appears on the card, it decides what "browse
// by language" returns - and the ways it goes wrong all produce a number that
// looks authoritative and is not.

import { describe, expect, test } from 'bun:test'
import { breakdown, countsTowardsLanguage, languageOf, parseTree } from '../../app/Actions/Explore/languages'

describe('what counts', () => {
  test('vendored code does not', () => {
    /*
     * A repository that checks in its dependencies is not written in whatever
     * they are written in - and it would say so with total confidence, because
     * `node_modules` outweighs everything a person wrote.
     */
    expect(countsTowardsLanguage('node_modules/left-pad/index.js')).toBe(false)
    expect(countsTowardsLanguage('vendor/github.com/x/y.go')).toBe(false)
  })

  test('including deep inside a monorepo', () => {
    // `packages/api/node_modules` is no more the repository's code than the one
    // at the root would be.
    expect(countsTowardsLanguage('packages/api/node_modules/x/index.js')).toBe(false)
  })

  test('build output does not', () => {
    expect(countsTowardsLanguage('dist/bundle.js')).toBe(false)
    expect(countsTowardsLanguage('target/debug/thing.rs')).toBe(false)
  })

  test('lock files do not', () => {
    // Enormous, machine-written, read by nobody. `bun.lock` alone would make
    // half this instance's repositories "JSON".
    expect(countsTowardsLanguage('bun.lock')).toBe(false)
    expect(countsTowardsLanguage('packages/api/pnpm-lock.yaml')).toBe(false)
  })

  test('and ordinary source does', () => {
    expect(countsTowardsLanguage('src/cart.ts')).toBe(true)
    expect(countsTowardsLanguage('app/Actions/Explore/languages.ts')).toBe(true)
  })
})

describe('naming a language', () => {
  test('from an extension', () => {
    expect(languageOf('src/cart.ts')).toBe('TypeScript')
    expect(languageOf('main.go')).toBe('Go')
    expect(languageOf('resources/views/explore.stx')).toBe('STX')
  })

  test('from the whole name, for the files that have no extension', () => {
    // `Dockerfile` and `Makefile` are how a repository declares itself, and an
    // extension-only table misses both.
    expect(languageOf('Dockerfile')).toBe('Dockerfile')
    expect(languageOf('deploy/Dockerfile.production')).toBe('Dockerfile')
    expect(languageOf('Makefile')).toBe('Makefile')
  })

  test('a dotfile has no extension to read', () => {
    expect(languageOf('.gitignore')).toBeNull()
    expect(languageOf('.env')).toBeNull()
  })

  test('and an unknown extension is unknown rather than guessed', () => {
    /*
     * The long tail is where misidentifications live - `.ts` is TypeScript here
     * and Qt Linguist elsewhere - and guessing on volume is how a Go repository
     * comes out as Perl.
     */
    expect(languageOf('data.parquet')).toBeNull()
    expect(languageOf('photo.jpg')).toBeNull()
  })
})

describe('the breakdown', () => {
  test('is by bytes, not by files', () => {
    /*
     * The decision that matters. Forty small YAML files and one large Go
     * program is a Go repository; counting files says it is YAML, and
     * configuration outnumbers source in most modern projects.
     */
    const files = [
      ...Array.from({ length: 40 }, (_, index) => ({ path: `config/${index}.yml`, bytes: 100 })),
      { path: 'main.go', bytes: 50_000 },
    ]

    expect(breakdown(files)[0]!.language).toBe('Go')
  })

  test('percentages are of identified code, so they add up', () => {
    /*
     * A breakdown whose numbers do not add to a hundred is one nobody trusts
     * twice, and "43% Other" is not information anybody can act on - so
     * unidentified files leave the numerator rather than being pooled.
     */
    const files = [
      { path: 'a.ts', bytes: 750 },
      { path: 'b.go', bytes: 250 },
      { path: 'photo.jpg', bytes: 9_000_000 },
    ]

    const result = breakdown(files)

    expect(result.map(one => one.percent)).toEqual([75, 25])
    expect(result.reduce((sum, one) => sum + one.percent, 0)).toBe(100)
  })

  test('largest first, and ties broken by name so two runs agree', () => {
    // Either order is defensible for a tie; what is not is picking differently
    // on two runs, which is what an unstable sort over a Map's iteration order
    // would do. Ascending by name, so `Go` precedes `TypeScript`.
    const result = breakdown([{ path: 'b.go', bytes: 100 }, { path: 'a.ts', bytes: 100 }])

    expect(result.map(one => one.language)).toEqual(['Go', 'TypeScript'])
    expect(breakdown([{ path: 'a.ts', bytes: 100 }, { path: 'b.go', bytes: 100 }]).map(one => one.language))
      .toEqual(['Go', 'TypeScript'])
  })

  test('a repository of images and lock files has no breakdown at all', () => {
    // Rather than a breakdown of nothing, or one where every entry is zero.
    expect(breakdown([{ path: 'photo.jpg', bytes: 5000 }, { path: 'bun.lock', bytes: 90_000 }])).toEqual([])
  })
})

describe('reading git ls-tree', () => {
  test('takes the size and the path', () => {
    const output = '100644 blob e69de29bb2d1d6434b8b29ae775ad8c2e48c5391     420\tsrc/cart.ts'

    expect(parseTree(output)).toEqual([{ path: 'src/cart.ts', bytes: 420 }])
  })

  test('a path with spaces survives, because the tab is the separator', () => {
    /*
     * The size column is right-aligned with a variable number of spaces, so
     * splitting on whitespace loses any path containing one - and "My
     * Documents" style paths are ordinary in repositories that started life on
     * a desktop.
     */
    const output = '100644 blob abc123     12\tdocs/design notes.md'

    expect(parseTree(output)).toEqual([{ path: 'docs/design notes.md', bytes: 12 }])
  })

  test('a submodule is skipped rather than counted as zero', () => {
    // A submodule is `commit` with a size of `-`, and `Number('-')` is NaN -
    // which would become a zero-byte entry for a language it is not written in.
    const output = '160000 commit abc123       -\tvendor/thing'

    expect(parseTree(output)).toEqual([])
  })

  test('and empty output is an empty tree', () => {
    expect(parseTree('')).toEqual([])
  })
})

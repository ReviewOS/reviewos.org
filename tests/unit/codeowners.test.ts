/**
 * `CODEOWNERS`, and the rules a homegrown matcher gets wrong.
 *
 * The file is almost always copied in from somewhere else, so reading it
 * differently from GitHub is not a design choice - it is assigning the wrong
 * people quietly. Every case below is one where a plausible implementation and
 * the real rule disagree, which is exactly where a copied file goes wrong.
 */

import { describe, expect, test } from 'bun:test'
import { matchesPattern, ownersForPaths, ownersOf, parseCodeowners } from '../../app/Actions/Pull/codeowners'

describe('parseCodeowners', () => {
  test('reads a pattern and its owners', () => {
    expect(parseCodeowners('*.ts @alice @bob')).toEqual([
      { pattern: '*.ts', owners: ['alice', 'bob'] },
    ])
  })

  test('drops comments and blank lines', () => {
    const rules = parseCodeowners(`
# who owns what
*.ts @alice

  # indented comment
docs/ @bob
`)

    expect(rules.map(rule => rule.pattern)).toEqual(['*.ts', 'docs/'])
  })

  test('a trailing comment is not part of the owner list', () => {
    expect(parseCodeowners('*.ts @alice # she wrote it')).toEqual([
      { pattern: '*.ts', owners: ['alice'] },
    ])
  })

  test('an email address is an owner, and simply matches nobody here', () => {
    expect(parseCodeowners('*.ts alice@example.com')[0]!.owners).toEqual(['alice@example.com'])
  })

  test('a team is carried through rather than dropped', () => {
    // Dropping it would ask fewer people than the file says, silently.
    expect(parseCodeowners('*.ts @acme/platform')[0]!.owners).toEqual(['acme/platform'])
  })

  /**
   * A pattern with no owners releases the path. Dropping the line would let an
   * earlier rule win something its author deliberately unset.
   */
  test('a pattern with no owners is a rule, not noise', () => {
    const rules = parseCodeowners('*.ts @alice\ngenerated.ts')

    expect(rules).toHaveLength(2)
    expect(rules[1]).toEqual({ pattern: 'generated.ts', owners: [] })
  })
})

describe('matchesPattern', () => {
  test('a pattern with no slash matches at any depth', () => {
    // The one people get wrong most: `*.ts` is not top-level only.
    expect(matchesPattern('*.ts', 'a.ts')).toBe(true)
    expect(matchesPattern('*.ts', 'src/deep/a.ts')).toBe(true)
  })

  test('a leading slash anchors to the root', () => {
    expect(matchesPattern('/docs/', 'docs/a.md')).toBe(true)
    expect(matchesPattern('/docs/', 'src/docs/a.md')).toBe(false)
  })

  test('a trailing slash is a directory and everything under it', () => {
    expect(matchesPattern('docs/', 'docs/a.md')).toBe(true)
    expect(matchesPattern('docs/', 'docs/deep/a.md')).toBe(true)
    // And not a file that happens to be called docs.
    expect(matchesPattern('docs/', 'docs')).toBe(false)
  })

  /**
   * `*` stops at a slash and `**` does not. Conflating them is how `src/*`
   * comes to match `src/a/b.ts`, which is a file its owner never agreed to own.
   */
  test('one star does not cross a slash and two do', () => {
    expect(matchesPattern('src/*', 'src/a.ts')).toBe(true)
    expect(matchesPattern('src/*', 'src/deep/a.ts')).toBe(false)
    expect(matchesPattern('src/**', 'src/deep/a.ts')).toBe(true)
  })

  test('`**/` also matches nothing at all', () => {
    expect(matchesPattern('**/a.ts', 'a.ts')).toBe(true)
    expect(matchesPattern('**/a.ts', 'src/deep/a.ts')).toBe(true)
  })

  test('a bare path matches the file and, as a prefix, what is under it', () => {
    expect(matchesPattern('src/app.ts', 'src/app.ts')).toBe(true)
    expect(matchesPattern('src/app.ts', 'src/app.ts.map')).toBe(false)
  })

  test('a dot in a pattern is a dot, not any character', () => {
    expect(matchesPattern('a.ts', 'axts')).toBe(false)
  })

  test('a lone star owns everything', () => {
    expect(matchesPattern('*', 'anything/at/all.ts')).toBe(true)
  })
})

describe('ownersOf', () => {
  const rules = parseCodeowners(`
* @fallback
*.ts @typescript
src/critical/ @security
`)

  /**
   * The rule that surprises people, and the reason a copied file has to be read
   * exactly: **the last match wins**, not the first and not all of them. A file
   * with a catch-all at the bottom is one where the catch-all owns everything,
   * which is why people put it at the top.
   */
  test('the last matching rule wins, not the first', () => {
    expect(ownersOf(rules, 'src/critical/keys.ts')).toEqual(['security'])
    expect(ownersOf(rules, 'src/other/thing.ts')).toEqual(['typescript'])
    expect(ownersOf(rules, 'README.md')).toEqual(['fallback'])
  })

  test('a path nothing matches has no owner', () => {
    expect(ownersOf(parseCodeowners('docs/ @bob'), 'src/a.ts')).toEqual([])
  })

  /**
   * A later rule naming nobody releases the path rather than deferring to an
   * earlier one. Falling back would put an owner on a file somebody explicitly
   * took the owner off.
   */
  test('a later rule with no owners releases the path', () => {
    const released = parseCodeowners('*.ts @alice\ngenerated.ts')

    expect(ownersOf(released, 'a.ts')).toEqual(['alice'])
    expect(ownersOf(released, 'generated.ts')).toEqual([])
  })
})

describe('ownersForPaths', () => {
  const rules = parseCodeowners(`
*.ts @typescript
docs/ @writer
src/critical/ @security @typescript
`)

  test('everybody the change asks for, once each', () => {
    expect(ownersForPaths(rules, ['src/critical/a.ts', 'docs/b.md', 'src/c.ts']))
      .toEqual(['security', 'typescript', 'writer'])
  })

  test('in the order the diff reads, not alphabetically', () => {
    // The owner of the file somebody actually came to change is at the top.
    expect(ownersForPaths(rules, ['docs/b.md', 'src/c.ts'])).toEqual(['writer', 'typescript'])
  })

  test('the same person named twice is asked once', () => {
    expect(ownersForPaths(rules, ['a.ts', 'b.ts'])).toEqual(['typescript'])
  })

  test('a change nothing owns asks nobody', () => {
    expect(ownersForPaths(rules, ['README.md'])).toEqual([])
  })

  test('no rules is no owners rather than a crash', () => {
    expect(ownersForPaths([], ['a.ts'])).toEqual([])
  })
})

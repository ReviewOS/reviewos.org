// The per-repository language override, read from `.gitattributes`.
//
// Detection by name and extension is right almost always. The exceptions are
// the ones no rule can know - a `.h` that is C++, a house extension for a
// template language, a generated directory that should read as plain text -
// and the repository is the only place that knows.
//
// `linguist-language` rather than a name of our own: it is what every
// repository that has ever cared already carries, and what a mirror brings
// across untouched.

import { describe, expect, test } from 'bun:test'
import { declaredLanguage, forgetLanguageRules, languageRulesFor, matchesPattern, parseLanguageRules } from '../../app/Actions/Browse/attributes'

describe('reading the attributes', () => {
  test('takes the language attributes and leaves everything else alone', () => {
    // A real `.gitattributes` is mostly about line endings, diff drivers and
    // export rules, none of which are this module's business.
    const rules = parseLanguageRules(`
      * text=auto
      *.h linguist-language=C++
      *.lock linguist-generated=true
      *.md diff=markdown
      docs/*.stx linguist-language=HTML
    `)

    expect(rules.map(rule => [rule.pattern, rule.language])).toEqual([
      ['*.h', 'c++'],
      ['docs/*.stx', 'html'],
    ])
  })

  test('reads GitLab\'s spelling of the same idea', () => {
    expect(parseLanguageRules('*.pp gitlab-language=ruby')[0]?.language).toBe('ruby')
  })

  test('comments and blank lines are not rules', () => {
    expect(parseLanguageRules('# *.h linguist-language=C++\n\n')).toEqual([])
  })

  test('a quoted pattern keeps its spaces', () => {
    const rules = parseLanguageRules('"my docs/*.md" linguist-language=Markdown')

    expect(rules[0]?.pattern).toBe('my docs/*.md')
    expect(rules[0]?.language).toBe('markdown')
  })

  test('both spellings of turning it off produce an unset', () => {
    // A repository that turns the override off for a subtree means it, and the
    // page has to be able to tell that from "no rule matched".
    const rules = parseLanguageRules('vendor/* -linguist-language\ngenerated/* linguist-language=false')

    expect(rules.map(rule => rule.language)).toEqual(['', ''])
  })
})

describe('matching a path', () => {
  test('a pattern with no slash matches at any depth, which is why `*.h` works', () => {
    expect(matchesPattern('*.h', 'src/deep/thing.h')).toBe(true)
    expect(matchesPattern('*.h', 'thing.h')).toBe(true)
    expect(matchesPattern('*.h', 'thing.c')).toBe(false)
  })

  test('a slash anchors it', () => {
    expect(matchesPattern('docs/*.md', 'docs/guide.md')).toBe(true)
    expect(matchesPattern('docs/*.md', 'app/docs/guide.md')).toBe(false)
    expect(matchesPattern('/README.md', 'README.md')).toBe(true)
    expect(matchesPattern('/README.md', 'docs/README.md')).toBe(false)
  })

  test('`*` stops at a segment boundary and `**` crosses it', () => {
    expect(matchesPattern('src/*.ts', 'src/deep/thing.ts')).toBe(false)
    expect(matchesPattern('src/**/*.ts', 'src/deep/thing.ts')).toBe(true)
  })

  test('a directory pattern covers what is under it', () => {
    expect(matchesPattern('vendor/', 'vendor/left-pad/index.js')).toBe(true)
    expect(matchesPattern('vendor/', 'vendored.js')).toBe(false)
  })

  test('and a dot is a dot rather than any character', () => {
    // `*.h` compiled naively matches `thingXh`, which is the sort of wrongness
    // nobody notices until a file is coloured as a language it is not.
    expect(matchesPattern('*.h', 'thingXh')).toBe(false)
  })
})

describe('deciding a file\'s language', () => {
  const rules = parseLanguageRules(`
    *.h linguist-language=C++
    vendor/** -linguist-language
    src/legacy/*.h linguist-language=C
  `)

  test('the repository wins where it has an opinion', () => {
    expect(declaredLanguage(rules, 'src/engine.h')).toBe('c++')
  })

  test('and the last matching rule wins, which is git\'s own order', () => {
    expect(declaredLanguage(rules, 'src/legacy/compat.h')).toBe('c')
  })

  test('an unset is an answer, not an absence', () => {
    // Falling back to "whatever the last set rule said" would make turning the
    // override off impossible to express.
    expect(declaredLanguage(rules, 'vendor/thing.h')).toBeNull()
  })

  test('and a path nothing matches leaves detection to decide', () => {
    expect(declaredLanguage(rules, 'src/main.ts')).toBeNull()
  })
})

describe('loading them from a repository', () => {
  test('a repository without the file has no rules, which is the common case', async () => {
    forgetLanguageRules()

    const rules = await languageRulesFor('/repo.git', 'main', async () => ({ ok: false, text: null }))

    expect(rules).toEqual([])
  })

  test('and the read happens once for a diff of any size', async () => {
    forgetLanguageRules()

    let reads = 0
    const read = async () => {
      reads += 1

      return { ok: true, text: '*.h linguist-language=C++' }
    }

    await languageRulesFor('/repo.git', 'abc123', read)
    await languageRulesFor('/repo.git', 'abc123', read)

    expect(reads).toBe(1)
  })

  test('but a different ref is a different answer', async () => {
    forgetLanguageRules()

    let reads = 0
    const read = async () => {
      reads += 1

      return { ok: true, text: '*.h linguist-language=C++' }
    }

    await languageRulesFor('/repo.git', 'abc123', read)
    await languageRulesFor('/repo.git', 'def456', read)

    expect(reads).toBe(2)
  })

  test('and the cache lets go, because a ref moves', async () => {
    forgetLanguageRules()

    let reads = 0
    const read = async () => {
      reads += 1

      return { ok: true, text: '*.h linguist-language=C++' }
    }

    await languageRulesFor('/repo.git', 'main', read, 1_000)
    await languageRulesFor('/repo.git', 'main', read, 1_000 + 60_000)

    expect(reads).toBe(2)
  })
})

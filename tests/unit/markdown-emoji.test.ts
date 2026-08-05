// Emoji shortcodes, and the reaction names that share their table.
//
// The interesting cases are all the same case: text that looks like a shortcode
// and is not one. A colon is punctuation in far more places than it is a
// delimiter, so a scanner that is eager here rewrites timestamps, ratios,
// namespaced identifiers and URLs.

import { describe, expect, test } from 'bun:test'
import { EMOJI, emojiFor, isReaction, REACTIONS, scanEmoji } from '../../app/Actions/Markdown/emoji'
import { renderMarkdown } from '../../app/Actions/Markdown/render'

describe('the table', () => {
  test('has a character for every reaction, so the two agree', () => {
    for (const reaction of REACTIONS)
      expect(emojiFor(reaction)).toBeTruthy()
  })

  test('names a reaction only from the fixed set', () => {
    expect(isReaction('rocket')).toBe(true)
    expect(isReaction('shipit')).toBe(false)
    expect(isReaction('')).toBe(false)
    expect(isReaction(null)).toBe(false)
  })

  test('reads a name in any case', () => {
    expect(emojiFor('TADA')).toBe(emojiFor('tada'))
  })

  test('has no name that maps to an empty character', () => {
    for (const [name, character] of Object.entries(EMOJI))
      expect(character.length, name).toBeGreaterThan(0)
  })
})

describe('scanning', () => {
  test('finds a shortcode and says where it is', () => {
    expect(scanEmoji('ship it :rocket: now')).toEqual([
      { value: '🚀', index: 8, length: 8 },
    ])
  })

  test('finds the two that are not words', () => {
    expect(scanEmoji(':+1: :-1:').map(found => found.value)).toEqual(['👍', '👎'])
  })

  test('leaves a name the table does not have', () => {
    expect(scanEmoji('a :flurb: b')).toEqual([])
  })

  test('leaves a time alone', () => {
    expect(scanEmoji('at 10:30:00')).toEqual([])
  })

  test('leaves a colon inside a word alone', () => {
    expect(scanEmoji('path:heart:end')).toEqual([])
    expect(scanEmoji('a::heart::b')).toEqual([])
  })
})

describe('rendering', () => {
  test('replaces a shortcode in prose', () => {
    expect(renderMarkdown('ship it :rocket:')).toBe('<p>ship it 🚀</p>')
  })

  test('leaves a shortcode inside code as the text somebody wrote', () => {
    expect(renderMarkdown('write `:rocket:` for it')).toContain('<code>:rocket:</code>')
  })

  test('leaves a shortcode inside a fence alone', () => {
    expect(renderMarkdown('```\n:rocket:\n```')).toContain(':rocket:')
  })

  test('replaces a shortcode in link text, where a reference would not be linked', () => {
    const html = renderMarkdown('[:tada: released](https://example.com)', {
      owner: 'reviewos',
      repository: 'core',
    })

    expect(html).toContain('>🎉 released</a>')
  })

  test('replaces a shortcode next to a reference without disturbing it', () => {
    const html = renderMarkdown('fixed #12 :tada:', { owner: 'reviewos', repository: 'core' })

    expect(html).toContain('href="/reviewos/core/issue/12"')
    expect(html).toContain('🎉')
  })
})

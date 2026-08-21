/**
 * A theme colours the page, not only the code.
 *
 * The library ships sixteen themes and can import anybody's VS Code file, and
 * every one of them is a `Theme` - so the page's own background, text, border
 * and muted values come from `themeChrome` alongside the token colours. A page
 * where the code is Nord and the frame is our greys is two surfaces pretending
 * to be one, and it reads as a bug rather than as a choice.
 *
 * What a theme is deliberately not allowed to set is checked here too, because
 * that is the part a future change would quietly widen: the accent, the review
 * states, and the diff's own add and remove palette, which is a separate reader
 * preference with its own colour-vision-deficiency variants. A theme
 * overwriting it would silently undo a choice made for a reason.
 */

import { describe, expect, test } from 'bun:test'
import { getTheme, importThemeFromJson, themes } from 'ts-syntax-highlighter'
import { syntaxThemeCss, themeChoices, themeId, themeVariables } from '../../app/Actions/Browse/themeCss'

/** The declarations of one variable block, as a map. */
function declarations(css: string): Map<string, string> {
  const found = new Map<string, string>()

  for (const part of css.split(';')) {
    const colon = part.indexOf(':')
    if (colon > 0)
      found.set(part.slice(0, colon).trim(), part.slice(colon + 1).trim())
  }

  return found
}

describe('the picker offers what the library ships', () => {
  test('every shipped theme is a choice', () => {
    expect(themeChoices().length).toBe(themes.length)
  })

  test('a choice carries what a picker needs to say', () => {
    const nord = themeChoices().find(choice => choice.id === 'nord')!

    expect(nord.name).toBe('Nord')
    expect(nord.type).toBe('dark')
  })

  test('the six built for colour-vision deficiency are among them', () => {
    const ids = themeChoices().map(choice => choice.id)

    expect(ids).toContain('deuteranopia-dark')
    expect(ids).toContain('deuteranopia-light')
    expect(ids).toContain('tritanopia-dark')
    expect(ids).toContain('tritanopia-light')
    expect(ids).toContain('monochrome-dark')
    expect(ids).toContain('monochrome-light')
  })
})

describe('a theme sets the chrome as well as the code', () => {
  const nord = getTheme('nord')!
  const values = declarations(themeVariables(nord))

  test('the page background is the theme background', () => {
    expect(values.get('--bg')).toBe(nord.colors['editor.background'])
  })

  test('the page text is the theme foreground', () => {
    expect(values.get('--text')).toBe(nord.colors['editor.foreground'])
  })

  test('the values themeChrome derives are all present', () => {
    for (const name of ['--bg', '--surface', '--line', '--text', '--muted', '--gutter'])
      expect(values.has(name)).toBe(true)
  })

  test('every token class the page renders has a colour', () => {
    for (const name of ['keyword', 'string', 'comment', 'numeric', 'function', 'type', 'variable', 'punctuation'])
      expect(values.has(`--t-${name}`)).toBe(true)
  })

  test('what stays ours stays ours', () => {
    // The accent is the product's, the review states mean something a theme
    // author never chose, and the diff palette is a separate accessibility
    // preference. None of them may be set from here.
    for (const name of ['--accent', '--accent-text', '--ok', '--bad', '--warn', '--add-bg', '--del-bg'])
      expect(values.has(name)).toBe(false)
  })
})

describe('the rules that go in the document', () => {
  const css = syntaxThemeCss()

  test('there is one rule per theme, keyed on the reader\'s choice', () => {
    expect(css.split('\n').length).toBe(themes.length)

    for (const theme of themes)
      expect(css).toContain(`:root[data-syntax-theme='${themeId(theme.name)}']`)
  })

  test('nothing in it can close the style element it sits in', () => {
    // It is interpolated raw into a `<style>` in the layout, so a colour that
    // somehow contained markup would end the stylesheet and start an element.
    expect(css).not.toContain('<')
    expect(css).not.toContain('</style')
  })

  test('nothing in it can be re-read as a template', () => {
    // stx interpolations are `{{ }}`; a generated block containing one would be
    // evaluated rather than printed.
    expect(css).not.toContain('{{')
  })

  test('it is small enough to be worth inlining rather than fetching', () => {
    expect(css.length).toBeLessThan(24 * 1024)
  })
})

describe('a theme somebody imported from their editor', () => {
  /**
   * The case the box is actually about. A VS Code theme is JSON with an
   * `editor.background` and a pile of `tokenColors`, and the whole point of
   * `importTheme` is that it becomes the same `Theme` a shipped one is - so it
   * goes through exactly the same mapping and themes the page the same way.
   */
  const imported = importThemeFromJson(JSON.stringify({
    name: 'Somebody\'s Editor',
    type: 'dark',
    colors: {
      'editor.background': '#101820',
      'editor.foreground': '#e6edf3',
    },
    tokenColors: [
      { scope: 'comment', settings: { foreground: '#7d8590', fontStyle: 'italic' } },
      { scope: ['string', 'string.quoted'], settings: { foreground: '#a5d6ff' } },
      { scope: 'keyword', settings: { foreground: '#ff7b72' } },
      { scope: 'constant.numeric', settings: { foreground: '#79c0ff' } },
    ],
  }))

  test('it becomes the same kind of theme a shipped one is', () => {
    expect(imported.name).toBe('Somebody\'s Editor')
    expect(imported.type).toBe('dark')
  })

  test('the page wears its background, not ours', () => {
    const values = declarations(themeVariables(imported))

    expect(values.get('--bg')).toBe('#101820')
    expect(values.get('--text')).toBe('#e6edf3')
  })

  test('the chrome it never stated is derived rather than left empty', () => {
    const values = declarations(themeVariables(imported))

    // The file gave two colours. A page needs six, and a hole in a colour
    // scheme renders as an unstyled element rather than as a missing value.
    expect(values.get('--surface')).toBeTruthy()
    expect(values.get('--line')).toBeTruthy()
    expect(values.get('--muted')).toBeTruthy()
  })

  test('its token colours reach the classes the page renders', () => {
    const values = declarations(themeVariables(imported))

    expect(values.get('--t-string')).toBe('#a5d6ff')
    expect(values.get('--t-keyword')).toBe('#ff7b72')
    expect(values.get('--t-numeric')).toBe('#79c0ff')
    expect(values.get('--t-comment')).toBe('#7d8590')
    expect(values.get('--t-comment-style')).toBe('italic')
  })
})

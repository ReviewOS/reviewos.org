/**
 * A syntax theme, as CSS the page can wear.
 *
 * The tokens on this page are semantic classes - `t-keyword`, `t-string` - and
 * their colours are custom properties, which is what makes switching a theme
 * free: nothing is tokenized again, nothing is fetched, a stylesheet's worth of
 * values changes and the browser recolours. That much was already true, with
 * one palette written by hand in the layout.
 *
 * What is new is where the values come from. `ts-syntax-highlighter` ships
 * sixteen themes and can import anybody's VS Code or TextMate file, and both of
 * those are `Theme` objects with the same shape - so a theme becomes a block of
 * declarations and the page wears whichever one the reader chose.
 *
 * ## The chrome comes from the theme too
 *
 * A page where the code is Nord and the frame around it is our own greys is two
 * surfaces pretending to be one, and it looks like a bug rather than a choice.
 * `themeChrome` in the library derives the five values a UI needs - background,
 * foreground, surface, border, muted, selection - from whatever the theme
 * stated, filling in what it did not rather than leaving holes. Those become
 * the page's own variables, so choosing a theme themes the page.
 *
 * Deliberately *not* everything: the accent, the review states (`--ok`,
 * `--bad`, `--warn`) and the diff's add and remove surfaces stay ours. A
 * theme's author never chose "the colour of a failing check", and the diff
 * palette is a separate reader preference with its own colour-vision-deficiency
 * variants - letting a theme overwrite it would silently undo that choice.
 */

import type { Theme } from 'ts-syntax-highlighter'
import { getTheme, themeChrome, themes } from 'ts-syntax-highlighter'

/** A theme as a picker needs it: what to store, what to show, what to say. */
export interface ThemeChoice {
  /** The value stored in preferences and written to `data-syntax-theme`. */
  id: string
  name: string
  type: 'light' | 'dark'
  description: string | null
}

/** Lower-cased and hyphenated, which is what a data attribute can hold. */
export function themeId(name: string): string {
  return name.toLowerCase().replace(/\s+/g, '-')
}

/**
 * The themes a reader may choose, in the order they are offered.
 *
 * Straight from the library rather than a list here, because a list here is a
 * list that goes stale the next time the library ships one.
 */
export function themeChoices(): ThemeChoice[] {
  return themes.map(theme => ({
    id: themeId(theme.name),
    name: theme.name,
    type: theme.type,
    description: theme.description ?? null,
  }))
}

/**
 * Which token class a theme's scope belongs to.
 *
 * The same eleven classes `highlight.ts` normalizes to, resolved here from the
 * scope side: a theme names scopes, and the page names classes. Longest match
 * wins, so `keyword.operator` colours operators rather than keywords.
 */
const CLASS_BY_SCOPE: Array<[string, string]> = [
  ['keyword.operator', 'operator'],
  ['constant.numeric', 'numeric'],
  ['entity.name.function', 'function'],
  ['support.function', 'function'],
  ['entity.name.tag', 'tag'],
  ['entity.other.attribute-name', 'attribute'],
  ['support.type.property-name', 'attribute'],
  ['entity.name.type', 'type'],
  ['entity.name.class', 'type'],
  ['storage.type', 'keyword'],
  ['storage.modifier', 'keyword'],
  ['punctuation', 'punctuation'],
  ['variable', 'variable'],
  ['constant', 'numeric'],
  ['comment', 'comment'],
  ['string', 'string'],
  ['keyword', 'keyword'],
]

function classFor(scope: string): string | null {
  for (const [prefix, name] of CLASS_BY_SCOPE) {
    if (scope === prefix || scope.startsWith(`${prefix}.`))
      return name
  }

  return null
}

/** Every token class a theme colours, with the first colour that claimed it. */
function tokenColours(theme: Theme): Map<string, { color: string, italic: boolean }> {
  const found = new Map<string, { color: string, italic: boolean }>()

  for (const entry of theme.tokenColors) {
    const colour = entry.settings.foreground
    if (!colour)
      continue

    const scopes = Array.isArray(entry.scope) ? entry.scope : [entry.scope]
    const italic = (entry.settings.fontStyle ?? '').includes('italic')

    for (const scope of scopes) {
      const name = classFor(scope)

      // First writer wins, so a theme that colours `keyword` and then
      // `keyword.control` keeps the general answer for the general class.
      if (name && !found.has(name))
        found.set(name, { color: colour, italic })
    }
  }

  return found
}

/**
 * The declarations for one theme, with no selector around them.
 *
 * Separated from `themeRule` because the imported case needs the same values
 * inside a `:root` written at runtime, and two copies of this mapping is how
 * an imported theme comes to look subtly unlike a shipped one.
 */
export function themeVariables(theme: Theme): string {
  const chrome = themeChrome(theme)
  const tokens = tokenColours(theme)
  const lines: string[] = []

  const set = (name: string, value: string): void => {
    lines.push(`--${name}:${value}`)
  }

  set('bg', chrome.background)
  set('surface', chrome.surface)
  set('surface-tint', chrome.surface)
  set('line', chrome.border)
  set('line-strong', chrome.border)
  set('text', chrome.foreground)
  set('muted', chrome.muted)
  set('gutter', chrome.surface)

  for (const [name, token] of tokens)
    set(`t-${name}`, token.color)

  // A comment is italic in nearly every theme and it is the one font style the
  // page carries, so it is a variable rather than a rule per theme.
  set('t-comment-style', tokens.get('comment')?.italic ? 'italic' : 'normal')

  return lines.join(';')
}

/** One theme as a rule, keyed on the attribute the reader's choice writes. */
export function themeRule(theme: Theme): string {
  return `:root[data-syntax-theme='${themeId(theme.name)}']{${themeVariables(theme)}}`
}

let cached: string | null = null

/**
 * Every shipped theme, as rules, built once.
 *
 * All of them, in the document, rather than a stylesheet per theme fetched when
 * chosen. Sixteen themes is a few kilobytes of declarations, and the
 * alternative is a network round trip between the reader choosing a theme and
 * the page wearing it - or worse, a page that renders in one theme and repaints
 * in another a frame later, which is exactly the flash the colour-scheme choice
 * is applied before first paint to avoid.
 */
export function syntaxThemeCss(): string {
  if (cached === null)
    cached = themes.map(themeRule).join('\n')

  return cached
}

/** A shipped theme by the id a preference holds, or null. */
export function themeById(id: string): Theme | null {
  return getTheme(id) ?? null
}

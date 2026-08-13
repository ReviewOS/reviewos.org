// The palette, and whether the three surfaces still agree about it.
//
// The landing page, the marketing layout and the application layout each
// declare the same tokens, by copy rather than by import. That arrangement is
// fine until it isn't: a colour is nudged on the marketing page, the
// application keeps the old one, and the two halves of the product drift apart
// one hex at a time - with nothing failing, because both files are valid CSS.
//
// So the agreement is a test.

import { describe, expect, test } from 'bun:test'
import { conflicts, groupTokens, parseTokens, renderDesign, sharedTokens } from '../../app/Docs/tokens'

const STYLED = [
  'resources/views/index.stx',
  'resources/views/layouts/marketing.stx',
  'resources/views/layouts/app.stx',
]

async function declarations() {
  const parsed = await Promise.all(STYLED.map(async path => parseTokens(await Bun.file(path).text(), path)))

  return parsed.flat()
}

describe('reading a stylesheet out of a template', () => {
  const source = `
    <meta name="theme-color" content="#0c1113" media="(prefers-color-scheme: dark)">
    <style>
      /* A comment with a ---- rule in it. */
      :root {
        --bg: #fbfbfa;
        --accent: #0f6d72;
      }

      @media (prefers-color-scheme: dark) {
        :root {
          --bg: #0c1113;
          --accent: #4ec5c9;
        }
      }

      :root[data-cvd="deuteranopia"] {
        --accent: #1f6feb;
      }

      .panel {
        --accent: #000000;
        border: 1px solid var(--accent);
      }
    </style>
  `

  const parsed = parseTokens(source, 'probe.stx')

  test('finds the palette in both themes', () => {
    expect(parsed.filter(token => token.theme === 'light').map(token => token.name)).toEqual(['--bg', '--accent'])
    expect(parsed.filter(token => token.theme === 'dark').map(token => token.value)).toEqual(['#0c1113', '#4ec5c9'])
  })

  /*
   * These are `.stx` files, so everything before the first rule is HTML - and
   * the head carries `media="(prefers-color-scheme: dark)"` on a theme-color
   * tag. Reading the whole buffer as a selector made every file's first `:root`
   * look like it sat inside the dark query, and the light palette vanished.
   */
  test('a meta tag mentioning the dark query does not make the page dark', () => {
    expect(parsed.some(token => token.theme === 'light')).toBe(true)
  })

  test('a comment containing dashes is not a token', () => {
    expect(parsed.map(token => token.name)).not.toContain('----')
  })

  test('a colour-vision variant is not the palette, and neither is a component override', () => {
    // `:root[data-cvd="…"]` is an alternate palette for a reader who needs one,
    // and a component setting a token for itself is a local decision. Counting
    // either as a disagreement would make the check unusable.
    expect(parsed.filter(token => token.name === '--accent').map(token => token.value)).toEqual(['#0f6d72', '#4ec5c9'])
  })

  test('groups are per token and theme, not per token', () => {
    // `--accent` is two different colours on purpose. Comparing them to each
    // other would report the dark theme as a bug.
    const groups = groupTokens(parsed).filter(group => group.name === '--accent')

    expect(groups).toHaveLength(2)
    expect(groups.every(group => group.values.length === 1)).toBe(true)
  })
})

describe('the three surfaces', () => {
  test('agree on every token they share', async () => {
    // The failure this catches: `--accent` nudged on the marketing page and not
    // in the application, which nothing else reports because both files are
    // valid CSS.
    const disagreements = conflicts(await declarations()).map(group => ({
      token: group.name,
      theme: group.theme,
      values: group.values,
      files: group.declarations.map(declaration => declaration.file),
    }))

    expect(disagreements).toEqual([])
  })

  test('and share enough of one for the check to mean something', async () => {
    // A refactor that renamed the tokens apart would leave nothing shared, so
    // the test above would pass by having nothing to compare.
    expect(sharedTokens(await declarations()).length).toBeGreaterThan(20)
  })
})

describe('the committed page', () => {
  test('is what the generator produces today', async () => {
    const body = renderDesign(await declarations(), 'from the stylesheets that declare it')

    expect(await Bun.file('docs/design.md').text()).toBe(body)
  })

  test('and records the values rather than describing them', async () => {
    const page = await Bun.file('docs/design.md').text()

    expect(page).toContain('| `--accent` | `#0f6d72` |')
    expect(page).toContain('## Colour, dark')
    expect(page).toContain('Geist Mono')
  })
})

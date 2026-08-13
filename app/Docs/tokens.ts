/**
 * The design tokens, read out of the stylesheets that declare them.
 *
 * Three surfaces carry the same palette: the landing page, the marketing
 * layout, and the application layout. They agree today because somebody copied
 * the values, which is exactly the arrangement that stops being true - a colour
 * is nudged on the marketing page, the application keeps the old one, and the
 * two halves of the product drift apart one hex at a time.
 *
 * Rather than a refactor that hoists a thousand lines of scoped CSS into a
 * shared file, the agreement is *checked*: a token declared in more than one
 * place must have the same value in all of them, in both themes, and a test
 * fails when it does not. The page this module renders is the record.
 *
 * Both halves matter. The check without the record is a rule nobody can read;
 * the record without the check is a document that goes stale the first time
 * somebody is in a hurry.
 */

/** One custom property, as one file declares it for one theme. */
export interface TokenDeclaration {
  name: string
  value: string
  theme: 'light' | 'dark'
  file: string
}

/**
 * Custom properties from a file's stylesheet, per theme.
 *
 * "Dark" is anything inside a `prefers-color-scheme: dark` block; everything
 * else is the light default. Nested at-rules are not tracked in general -
 * these three files use one dark block each, and a parser that handled every
 * possible nesting would be more machinery than the thing it checks.
 */
export function parseTokens(source: string, file: string): TokenDeclaration[] {
  const declarations: TokenDeclaration[] = []

  // Comments first, and not by regex over the whole file for fun: a comment
  // containing a rule of dashes reads as a custom property otherwise, and the
  // first version of this parser dutifully reported one.
  const text = String(source ?? '').replace(/\/\*[\s\S]*?\*\//g, '')

  /** What each open block is: the selector or at-rule that introduced it. */
  const stack: string[] = []
  let pending = ''
  let index = 0

  const inDark = (): boolean => stack.some(entry => entry.includes('prefers-color-scheme') && entry.includes('dark'))

  /*
   * Only `:root` counts as a palette declaration.
   *
   * `:root[data-cvd="deuteranopia"]` is an alternate palette for a reader who
   * needs one, and a component that overrides a token for itself is making a
   * local decision. Neither is a disagreement about what the product looks
   * like, which is what this module is for.
   */
  const inRoot = (): boolean => stack.length > 0 && stack[stack.length - 1]?.trim() === ':root'

  while (index < text.length) {
    const character = text[index]

    if (character === '{') {
      /*
       * The last line only.
       *
       * These are `.stx` files, so everything before the first rule is HTML -
       * and the head carries `media="(prefers-color-scheme: dark)"` on a
       * theme-color meta tag. Keeping the whole buffer made the first `:root`
       * in every file look like it sat inside a dark media query, and the
       * light palette vanished.
       */
      const selector = pending.split('\n').map(line => line.trim()).filter(Boolean).at(-1) ?? ''

      stack.push(selector)
      pending = ''
      index += 1
      continue
    }

    if (character === '}') {
      stack.pop()
      pending = ''
      index += 1
      continue
    }

    if (character === ';') {
      pending = ''
      index += 1
      continue
    }

    if (character === '-' && text.startsWith('--', index) && inRoot()) {
      const end = text.indexOf(';', index)

      if (end === -1)
        break

      const [name = '', ...rest] = text.slice(index, end).split(':')
      const value = rest.join(':').trim()

      if (value) {
        declarations.push({
          name: name.trim(),
          value,
          theme: inDark() ? 'dark' : 'light',
          file,
        })
      }

      pending = ''
      index = end + 1
      continue
    }

    pending += character
    index += 1
  }

  return declarations
}

/** `--accent` in light, from three files: one entry, three declarations. */
export interface TokenGroup {
  name: string
  theme: 'light' | 'dark'
  declarations: TokenDeclaration[]
  /** Every distinct value. More than one is a disagreement. */
  values: string[]
}

export function groupTokens(declarations: TokenDeclaration[]): TokenGroup[] {
  const groups = new Map<string, TokenGroup>()

  for (const declaration of declarations) {
    const key = `${declaration.theme} ${declaration.name}`
    const group = groups.get(key) ?? { name: declaration.name, theme: declaration.theme, declarations: [], values: [] }

    group.declarations.push(declaration)

    if (!group.values.includes(declaration.value))
      group.values.push(declaration.value)

    groups.set(key, group)
  }

  return [...groups.values()]
}

/**
 * Tokens two surfaces spell differently.
 *
 * This is the list a test asserts is empty. A token only one file declares is
 * not a conflict - the diff viewer's colours have no business on the marketing
 * page - so only shared names are compared.
 */
export function conflicts(declarations: TokenDeclaration[]): TokenGroup[] {
  return groupTokens(declarations).filter(group => group.declarations.length > 1 && group.values.length > 1)
}

/** Tokens more than one surface declares, which is what "agree" is about. */
export function sharedTokens(declarations: TokenDeclaration[]): TokenGroup[] {
  return groupTokens(declarations)
    .filter(group => new Set(group.declarations.map(declaration => declaration.file)).size > 1)
    .sort((left, right) => left.name.localeCompare(right.name) || left.theme.localeCompare(right.theme))
}

function tokenTable(groups: TokenGroup[], theme: 'light' | 'dark'): string[] {
  const rows = groups
    .filter(group => group.theme === theme)
    .map(group => `| \`${group.name}\` | \`${group.values[0]}\` | ${group.declarations.length} |`)

  if (rows.length === 0)
    return []

  return ['| Token | Value | Declared in |', '|---|---|---|', ...rows, '']
}

/**
 * The design reference.
 *
 * Colours from the stylesheets, so the page cannot claim a value nothing uses.
 * The type scale is prose rather than a table of tokens, because it genuinely
 * is prose: sizes are set per component and the useful thing to record is which
 * role gets which treatment, not a list of pixel values a reader has to map
 * back to something they can see.
 */
export function renderDesign(declarations: TokenDeclaration[], at: string): string {
  const shared = sharedTokens(declarations)
  const files = [...new Set(declarations.map(declaration => declaration.file))].sort()

  const out: string[] = [
    '# Design',
    '',
    '<!-- Generated by `buddy docs:reference`. Edits here are overwritten; change the stylesheet. -->',
    '',
    'The palette and the type scale, so the marketing page and the application agree about what this',
    'product looks like. The colours below are read out of the stylesheets that declare them, which',
    'is the only way a page like this stays true: a written-down palette is a palette that describes',
    'last month.',
    '',
    `Declared in ${files.map(file => `\`${file}\``).join(', ')}.`,
    '',
    `*Generated ${at}.*`,
    '',
    '## The rule',
    '',
    'A token more than one surface declares must have the same value in all of them, in both themes.',
    '`tests/unit/design-tokens.test.ts` fails when it does not, which is the part that keeps this',
    'page honest: two copies of a palette agree right up until somebody is in a hurry.',
    '',
    'A token only one surface declares is not a disagreement. The diff viewer\'s added and removed',
    'line colours have no business on a marketing page, and a marketing gradient has none in a code',
    'review.',
    '',
    '## Colour, light',
    '',
    ...tokenTable(shared, 'light'),
    '## Colour, dark',
    '',
    'Not a filter over the light palette. Dark is designed rather than derived: the same hue at the',
    'same lightness reads heavier on a dark ground, so the accent lifts and the text drops short of',
    'white to keep a page from vibrating.',
    '',
    ...tokenTable(shared, 'dark'),
    '## Type',
    '',
    'Geist for interface and copy, Geist Mono for code, diffs, shas and anything a reader might need',
    'to compare character by character.',
    '',
    '- **Display**, the landing hero: `clamp(2.6rem, 6.4vw, 4.4rem)`, tight tracking. It is the only',
    '  place on the site that shouts.',
    '- **Section heading**: `clamp(1.9rem, 3.6vw, 2.6rem)`. Fluid rather than stepped, so a phone',
    '  gets a proportional heading rather than the desktop one squeezed.',
    '- **Body**: 16px on the marketing pages, 15px in the application. The application is denser on',
    '  purpose - it is read for hours, at a screen\'s distance, next to code.',
    '- **Code and diff rows**: 12.5px to 13.5px monospace, with the gutter a size smaller than the',
    '  line it numbers so the numbers recede.',
    '- **Labels and pills**: 12px to 13px, medium weight, never uppercase in the application. Small',
    '  capitals are a marketing device; in a list of pull requests they slow reading down.',
    '',
    '## Shape',
    '',
    'Panels take the larger radius, controls the smaller, and status pills are the only fully round',
    'thing on the page. Shadows are one hairline in light and none in dark, because a shadow on a',
    'dark ground is a smudge.',
    '',
  ]

  return `${out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`
}

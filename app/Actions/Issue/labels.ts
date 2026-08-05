/**
 * Labels: the set every repository starts with, and the rules for the ones
 * people add afterwards.
 *
 * The defaults are the vocabulary a project uses before it has invented its
 * own, and they matter more than they look: an empty label list means the first
 * triager has to design a taxonomy before they can file anything.
 */

export interface LabelDefinition {
  name: string
  color: string
  description: string
}

/** Created with every repository. Colours are six hex digits, no leading hash. */
export const DEFAULT_LABELS: readonly LabelDefinition[] = [
  { name: 'bug', color: 'd73a4a', description: 'Something is not working' },
  { name: 'enhancement', color: 'a2eeef', description: 'A new feature or request' },
  { name: 'documentation', color: '0075ca', description: 'Improvements or additions to documentation' },
  { name: 'good first issue', color: '7057ff', description: 'A good place to start' },
  { name: 'help wanted', color: '008672', description: 'Extra attention is needed' },
  { name: 'question', color: 'd876e3', description: 'Further information is requested' },
  { name: 'duplicate', color: 'cfd3d7', description: 'This already exists' },
  { name: 'wontfix', color: 'ffffff', description: 'This will not be worked on' },
]

/**
 * A label name, or null when it cannot be used.
 *
 * Names are compared case insensitively but stored as typed, so `Bug` and `bug`
 * cannot both exist while somebody who prefers capitals still gets capitals.
 */
export function normalizeLabelName(raw: string): string | null {
  const trimmed = raw.trim().replace(/\s+/g, ' ')

  if (trimmed.length === 0 || trimmed.length > 50)
    return null

  // A comma would break every label filter that takes a list.
  if (trimmed.includes(','))
    return null

  return trimmed
}

/** Whether two label names collide, which is a case-insensitive question. */
export function labelNamesCollide(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase()
}

/**
 * A colour as six lowercase hex digits, or null.
 *
 * Accepts the leading hash and the three-digit short form, because both are
 * what people paste in.
 */
export function normalizeColor(raw: string): string | null {
  const value = raw.trim().replace(/^#/, '').toLowerCase()

  if (/^[0-9a-f]{6}$/.test(value))
    return value

  if (/^[0-9a-f]{3}$/.test(value))
    return value.split('').map(character => character + character).join('')

  return null
}

/**
 * The colour to actually paint with: six hex digits, always.
 *
 * A label's colour goes into a `style` attribute, which is the one place in
 * this product where a stored string becomes CSS. `normalizeColor` guards the
 * write path, but a value can arrive from somewhere else - a mirrored
 * repository, a restored dump, a seeder whose faker returned `rgb(13, 45, 67)`
 * where six hex digits were expected, which is exactly what happened. That
 * value interpolated straight into `background: #…` ends the declaration at the
 * comma and continues the attribute with whatever follows.
 *
 * So nothing reaches a style attribute without coming through here, and what
 * cannot be read falls back to grey. A label the wrong shade is a cosmetic
 * problem; a label that can write CSS is not.
 */
export const FALLBACK_LABEL_COLOR = 'd4c5f9'

export function labelColor(raw: unknown): string {
  return normalizeColor(String(raw ?? '')) ?? FALLBACK_LABEL_COLOR
}

/**
 * Whether label text should be black or white on this background.
 *
 * Decided on perceived lightness (CIE L*) rather than raw luminance. The two
 * agree on obvious colours and disagree exactly where it matters: a mid red
 * like `d73a4a` sits within a rounding error of the point where contrast
 * against black and against white are equal, so a luminance threshold flips it
 * on a colour a shade either way. L* spreads that region out and puts the
 * decision where an eye would put it.
 *
 * Channel weights are the sRGB ones: a saturated green and a saturated blue of
 * the same numeric value need opposite text.
 */
export function labelTextColor(hex: string): 'black' | 'white' {
  const color = normalizeColor(hex)
  if (!color)
    return 'black'

  const channel = (offset: number): number => {
    const value = Number.parseInt(color.slice(offset, offset + 2), 16) / 255

    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  }

  const luminance = 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4)
  const lightness = luminance > 0.008856
    ? 116 * luminance ** (1 / 3) - 16
    : luminance * 903.3

  return lightness > 50 ? 'black' : 'white'
}

/**
 * The picture a badge is: a two-part pill, drawn rather than fetched.
 *
 * Separate from the endpoint because the drawing is the part worth testing on
 * its own - a badge that renders the state in the wrong half, or that breaks
 * out of its own box because a workflow is called something long, is a bug
 * every README on the instance shows at once.
 *
 * **No external font, no external anything.** A badge is served into somebody
 * else's page; everything it needs is inside it. The font stack is the one
 * shields.io settled on, and the widths below are measured against it rather
 * than assumed - a wrong width is text spilling past the edge of the pill,
 * which is the only way this renders visibly wrong.
 */

/** What a badge says in its coloured half. */
export interface BadgeState {
  /** The word: `passing`, `failing`, `no runs`. */
  message: string
  /** One of the six below, chosen by `stateFor`. */
  colour: string
}

/** The colours, named rather than repeated as hex. */
export const BADGE_COLOURS = {
  green: '#3fb950',
  red: '#f85149',
  yellow: '#d29922',
  blue: '#3b82f6',
  grey: '#6e7681',
  slate: '#414954',
} as const

/**
 * A run's state, as a badge says it.
 *
 * The vocabulary is deliberately not the run's own. `succeeded` is what the API
 * says and `passing` is what a badge says, because a badge is read at a glance
 * by somebody who has never used this forge and every other badge on that page
 * says `passing`.
 */
export function stateFor(state: string | null | undefined): BadgeState {
  switch (String(state ?? '')) {
    case 'succeeded':
      return { message: 'passing', colour: BADGE_COLOURS.green }
    case 'failed':
      return { message: 'failing', colour: BADGE_COLOURS.red }
    case 'cancelled':
    case 'cancelling':
      return { message: 'cancelled', colour: BADGE_COLOURS.grey }
    case 'running':
      return { message: 'running', colour: BADGE_COLOURS.blue }
    case 'queued':
    case 'waiting':
    case 'paused':
      return { message: 'pending', colour: BADGE_COLOURS.yellow }
    case 'skipped':
      return { message: 'skipped', colour: BADGE_COLOURS.grey }
    default:
      /*
       * Everything else is `unknown`, and this is the answer for a repository
       * that does not exist, one the reader may not see, and one that has never
       * run this workflow. Identical on purpose: a badge that said "private"
       * would confirm a private repository exists to anybody who guessed a
       * name, and a 404 would do the same through a broken image.
       */
      return { message: 'unknown', colour: BADGE_COLOURS.grey }
  }
}

/**
 * How wide a string is in the 11px font the badge draws with.
 *
 * Measured per character rather than assumed uniform, because `passing` and
 * `illiiil` are the same length and not the same width, and a badge sized by
 * character count clips one and pads the other. The table is coarse - five
 * classes - which is enough: the error is a pixel of padding, not text outside
 * the pill.
 */
export function widthOf(text: string): number {
  let width = 0

  for (const character of text) {
    if ('ijltI.,:;\'`|!'.includes(character))
      width += 3.2
    else if ('fr()[]{}/\\-'.includes(character))
      width += 4.6
    else if ('mwMW@'.includes(character))
      width += 10
    else if (character === ' ')
      width += 3.5
    else if (character >= 'A' && character <= 'Z')
      width += 8
    else
      width += 6.6
  }

  return Math.ceil(width)
}

/** The pill, as SVG, with both halves sized to their own text. */
export function renderBadge(input: { label: string, state: BadgeState }): string {
  const padding = 10
  const label = clean(input.label)
  const message = clean(input.state.message)

  const labelWidth = widthOf(label) + padding * 2
  const messageWidth = widthOf(message) + padding * 2
  const total = labelWidth + messageWidth

  /*
   * Each half's text is drawn twice: once in near-black a pixel lower, once in
   * white over it. That is the shadow every badge has, and it is what keeps
   * white text readable on the yellow fill.
   */
  const text = (content: string, centre: number): string => `
    <text x="${centre}" y="15" fill="#010101" fill-opacity=".3">${content}</text>
    <text x="${centre}" y="14">${content}</text>`

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${total}" height="20" role="img" aria-label="${label}: ${message}">
  <title>${label}: ${message}</title>
  <linearGradient id="s" x2="0" y2="100%">
    <stop offset="0" stop-color="#bbb" stop-opacity=".1"/>
    <stop offset="1" stop-opacity=".1"/>
  </linearGradient>
  <clipPath id="r"><rect width="${total}" height="20" rx="3" fill="#fff"/></clipPath>
  <g clip-path="url(#r)">
    <rect width="${labelWidth}" height="20" fill="${BADGE_COLOURS.slate}"/>
    <rect x="${labelWidth}" width="${messageWidth}" height="20" fill="${input.state.colour}"/>
    <rect width="${total}" height="20" fill="url(#s)"/>
  </g>
  <g fill="#fff" text-anchor="middle" font-family="Verdana,DejaVu Sans,Geneva,sans-serif" font-size="11">${text(label, labelWidth / 2)}${text(message, labelWidth + messageWidth / 2)}
  </g>
</svg>`
}

/**
 * A string safe to put inside SVG, and short enough to fit.
 *
 * The label comes from a workflow's name, which comes from a file anybody who
 * can push may edit - so this is not tidying, it is the boundary. Control
 * characters go, everything that could close a tag is escaped, and the result
 * is cut to a length that keeps a badge a badge.
 */
function clean(value: string): string {
  return value
    .replace(/[\x00-\x1F\x7F]/g, '')
    .slice(0, 40)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

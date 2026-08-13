/**
 * Turning a build's colours into something a page can show.
 *
 * A test runner's output is not decorated for fun: red is the failure, green is
 * the pass, and dim is the part you skip. Stripping it makes a log a person has
 * to read word by word, and keeping the escape bytes as text makes it worse -
 * `[0;31m` in front of every line is noise nobody can turn off.
 *
 * So the escapes are parsed and rendered as spans, and everything else is
 * escaped as text. **The output of this function is HTML**, which is the one
 * dangerous sentence in the file: every branch below either emits a tag this
 * module wrote or text it escaped, and nothing from the log ever reaches the
 * page unescaped.
 *
 * Only SGR (`ESC [ … m`) is understood. Cursor movement, screen clearing and
 * the rest describe a terminal that does not exist here; they are dropped
 * rather than rendered, because a log that redraws itself is a log nobody can
 * scroll back through anyway.
 */

/**
 * The escape character, written as a code point rather than typed.
 *
 * A literal control character in source is invisible in a diff, survives a
 * round trip through an editor only by luck, and is the sort of thing a
 * well-meaning formatter strips - at which point this module silently stops
 * recognising any colour at all and every log renders as plain text with
 * nothing to show for it.
 */
const ESCAPE = String.fromCharCode(27)

/** The eight, and their bright forms, as CSS custom properties a theme can set. */
const COLOURS: Record<number, string> = {
  30: 'black',
  31: 'red',
  32: 'green',
  33: 'yellow',
  34: 'blue',
  35: 'magenta',
  36: 'cyan',
  37: 'white',
  90: 'bright-black',
  91: 'bright-red',
  92: 'bright-green',
  93: 'bright-yellow',
  94: 'bright-blue',
  95: 'bright-magenta',
  96: 'bright-cyan',
  97: 'bright-white',
}

interface Style {
  colour: string
  background: string
  bold: boolean
  dim: boolean
  italic: boolean
  underline: boolean
}

const NOTHING: Style = { colour: '', background: '', bold: false, dim: false, italic: false, underline: false }

/** HTML-escaped, including quotes: this text ends up inside attributes too. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** Apply one SGR parameter to a style, the way a terminal would. */
export function applyCode(style: Style, code: number): Style {
  if (code === 0)
    return { ...NOTHING }

  if (code === 1)
    return { ...style, bold: true }

  if (code === 2)
    return { ...style, dim: true }

  if (code === 3)
    return { ...style, italic: true }

  if (code === 4)
    return { ...style, underline: true }

  // The "off" codes. A build that turns bold off mid-line means it, and a
  // renderer that only understands `0` leaves the rest of the line shouting.
  if (code === 22)
    return { ...style, bold: false, dim: false }

  if (code === 23)
    return { ...style, italic: false }

  if (code === 24)
    return { ...style, underline: false }

  if (code === 39)
    return { ...style, colour: '' }

  if (code === 49)
    return { ...style, background: '' }

  const colour = COLOURS[code]
  if (colour)
    return { ...style, colour }

  // Backgrounds are the foreground codes plus ten.
  const background = COLOURS[code - 10]
  if (background && (code >= 40 && code <= 47 || code >= 100 && code <= 107))
    return { ...style, background }

  return style
}

function classesFor(style: Style): string {
  const classes: string[] = []

  if (style.colour)
    classes.push(`ansi-${style.colour}`)
  if (style.background)
    classes.push(`ansi-bg-${style.background}`)
  if (style.bold)
    classes.push('ansi-bold')
  if (style.dim)
    classes.push('ansi-dim')
  if (style.italic)
    classes.push('ansi-italic')
  if (style.underline)
    classes.push('ansi-underline')

  return classes.join(' ')
}

/**
 * A URL in build output, as a link.
 *
 * Worth doing because half of what a failing build prints is a link to
 * something - a report, a preview deployment, a stack trace's source. Worth
 * doing carefully because the text came off a machine running somebody's code:
 * only `http` and `https`, never `javascript:` or `data:`, and the href is
 * escaped exactly like the text around it.
 *
 * `rel="noreferrer nofollow noopener"`: a link out of somebody else's build
 * output should not carry this instance's page in a referrer header, and should
 * not be a link this instance vouches for.
 */
function linkify(escaped: string): string {
  return escaped.replace(/https?:&#x2F;&#x2F;[^\s<]+|https?:\/\/[^\s<"']+/g, (match) => {
    const trimmed = match.replace(/[.,;:)\]]+$/, '')
    const trailing = match.slice(trimmed.length)

    return `<a href="${trimmed}" rel="noreferrer nofollow noopener">${trimmed}</a>${trailing}`
  })
}

/**
 * One line of build output, as HTML.
 *
 * Escaped first, then decorated: the order is the whole safety argument. Escape
 * after adding tags and the tags are escaped too; decorate before escaping and
 * the log's own angle brackets become markup.
 */
export function renderAnsi(text: string, options: { link?: boolean } = {}): string {
  const source = String(text ?? '')
  let style: Style = { ...NOTHING }
  let out = ''
  let buffer = ''

  const flush = (): void => {
    if (!buffer)
      return

    const escaped = escapeHtml(buffer)
    const body = options.link === false ? escaped : linkify(escaped)
    const classes = classesFor(style)

    out += classes ? `<span class="${classes}">${body}</span>` : body
    buffer = ''
  }

  for (let at = 0; at < source.length; at += 1) {
    const character = source[at]

    // ESC [ … m, and nothing else. Anything that is not a colour sequence is
    // dropped whole rather than half-printed.
    if (character === ESCAPE && source[at + 1] === '[') {
      const end = source.indexOf('m', at + 2)
      const terminator = source.slice(at + 2).search(/[A-Za-z]/)

      if (end === -1 || (terminator !== -1 && at + 2 + terminator !== end)) {
        // Some other control sequence: skip to its terminator and forget it.
        if (terminator === -1)
          break

        at = at + 2 + terminator
        continue
      }

      flush()

      const parameters = source.slice(at + 2, end).split(';')

      for (const parameter of parameters) {
        const code = Number(parameter === '' ? '0' : parameter)

        if (Number.isFinite(code))
          style = applyCode(style, code)
      }

      at = end
      continue
    }

    buffer += character
  }

  flush()

  return out
}

/** Whether a line carries any escapes at all, for a caller that wants to skip the work. */
export function hasAnsi(text: string): boolean {
  return new RegExp(`${ESCAPE}\\[`).test(String(text ?? ''))
}

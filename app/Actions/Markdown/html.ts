/**
 * The safe subset of raw HTML that user markdown is allowed to write.
 *
 * READMEs are full of it: a logo centred with `<div align="center">`, a long
 * section folded into `<details>`, a shortcut written as `<kbd>Ctrl</kbd>`.
 * Showing that markup as text, which is what this pipeline did before, makes
 * every mirrored repository's front page look broken.
 *
 * **Nothing here sanitizes a string**, exactly as in `render.ts`. Input is
 * tokenized into tags and text, and the output tag is *built from scratch*:
 * a name that has to be in the allowlist, and only the attributes that name
 * permits, each one validated on its own terms. An attribute nobody listed
 * cannot survive, because there is no code path that copies one. That is why
 * `onclick`, `style`, `id`, `srcset` and everything else nobody thought of are
 * all handled identically without being named: they are simply not built.
 *
 * The tokenizer is the load-bearing half, and it follows the HTML spec's
 * tag-open state rather than a regex. A regex over the output is the version of
 * this that everybody writes and everybody gets wrong: it has to be right about
 * every way a browser can be made to see a tag, and it only has to be wrong
 * once. Reading left to right the way the browser does means the two agree
 * about where a tag starts by construction.
 *
 * ## Balance
 *
 * An unclosed `<details>` would otherwise swallow the rest of the page, and a
 * stray `</div>` would close a container this pipeline does not own. Both are
 * handled, and deliberately not symmetrically:
 *
 * - A close tag is emitted only when this writer opened that element. Anything
 *   else is escaped and shown as text. That is the invariant that keeps
 *   rendered markdown inside its own box: user text cannot close a tag it did
 *   not open.
 * - An element still open at the end of the document is closed for the author.
 *   Escaping it after the fact is not available - it has already been emitted -
 *   and leaving it open is the failure the invariant above exists to prevent.
 */

import { escapeAttribute, escapeText, safeUrl } from './render'

/** One piece of a run: a tag, some text, or something to drop on the floor. */
export type HtmlToken =
  | { kind: 'text', text: string }
  | { kind: 'open', name: string, attributes: Array<[string, string | null]>, selfClosing: boolean }
  | { kind: 'close', name: string }
  /** Comments, doctypes, CDATA and processing instructions. Never rendered. */
  | { kind: 'drop' }

/** `<` starts a tag only when a letter follows, which is the browser's rule too. */
function isAlpha(char: string | undefined): boolean {
  return char !== undefined && ((char >= 'a' && char <= 'z') || (char >= 'A' && char <= 'Z'))
}

function isSpace(char: string | undefined): boolean {
  return char === ' ' || char === '\t' || char === '\n' || char === '\r' || char === '\f'
}

/**
 * Split a string into tags and text.
 *
 * Never throws and never fails: anything that does not parse as a tag comes
 * back as text, which is the same thing a browser does with it. An unterminated
 * `<div` at the end of the input is text, not an open tag, because that is what
 * it renders as.
 */
export function tokenizeHtml(source: string): HtmlToken[] {
  const tokens: HtmlToken[] = []
  let text = ''
  let index = 0

  const flush = (): void => {
    if (text) {
      tokens.push({ kind: 'text', text })
      text = ''
    }
  }

  while (index < source.length) {
    const char = source[index]!

    if (char !== '<') {
      text += char
      index += 1
      continue
    }

    const next = source[index + 1]

    // `<!-- … -->`, `<!DOCTYPE …>`, `<![CDATA[…]]>` and `<?…?>`. All of them
    // run to the first `>` the way a browser's bogus-comment state does, and
    // all of them are dropped rather than escaped: a comment is invisible by
    // intent, and showing its text would be a surprise.
    if (next === '!' || next === '?') {
      const comment = source.startsWith('<!--', index)
      const terminator = comment
        ? source.indexOf('-->', index + 4)
        : source.indexOf('>', index + 2)

      flush()
      tokens.push({ kind: 'drop' })

      // Unterminated, so the rest of the run is inside it and inside it stays -
      // which is the whole point of dropping these rather than escaping them.
      // `<!-- <script>` must not end with the script tag back outside.
      if (terminator < 0)
        return tokens

      index = terminator + (comment ? 3 : 1)
      continue
    }

    const closing = next === '/'
    const nameStart = index + (closing ? 2 : 1)

    if (!isAlpha(source[nameStart])) {
      // `a < b`, `3 <5`, and a lone `</` are all text.
      text += char
      index += 1
      continue
    }

    const parsed = parseTag(source, nameStart, closing)
    if (!parsed) {
      text += char
      index += 1
      continue
    }

    flush()
    tokens.push(parsed.token)
    index = parsed.end
  }

  flush()

  return tokens
}

/** A tag from `nameStart`, or null when there is no `>` to end it. */
function parseTag(
  source: string,
  nameStart: number,
  closing: boolean,
): { token: HtmlToken, end: number } | null {
  let index = nameStart
  while (index < source.length && !isSpace(source[index]) && source[index] !== '/' && source[index] !== '>')
    index += 1

  // Lowercased once, here, so nothing downstream has to remember that `<KBD>`
  // and `<kbd>` are the same element.
  const name = source.slice(nameStart, index).toLowerCase()
  const attributes: Array<[string, string | null]> = []
  let selfClosing = false

  while (index < source.length) {
    while (isSpace(source[index]))
      index += 1

    const char = source[index]

    if (char === undefined)
      return null

    if (char === '>') {
      index += 1
      break
    }

    if (char === '/') {
      selfClosing = true
      index += 1
      continue
    }

    // An attribute name runs to whitespace, `=`, `/` or `>`. A name containing
    // anything else is still a name as far as a browser is concerned, and the
    // allowlist below is what decides whether it means anything.
    const attributeStart = index
    while (
      index < source.length
      && !isSpace(source[index])
      && source[index] !== '='
      && source[index] !== '/'
      && source[index] !== '>'
    ) {
      index += 1
    }

    const attributeName = source.slice(attributeStart, index).toLowerCase()
    if (!attributeName)
      return null

    while (isSpace(source[index]))
      index += 1

    if (source[index] !== '=') {
      // A bare attribute: `<details open>`.
      attributes.push([attributeName, null])
      continue
    }

    index += 1
    while (isSpace(source[index]))
      index += 1

    const quote = source[index]
    let value: string

    if (quote === '"' || quote === '\'') {
      const end = source.indexOf(quote, index + 1)
      if (end < 0)
        return null

      value = source.slice(index + 1, end)
      index = end + 1
    }
    else {
      const start = index
      while (index < source.length && !isSpace(source[index]) && source[index] !== '>')
        index += 1

      value = source.slice(start, index)
    }

    attributes.push([attributeName, value])
  }

  if (index > source.length)
    return null

  return {
    token: closing ? { kind: 'close', name } : { kind: 'open', name, attributes, selfClosing },
    end: index,
  }
}

/** How an attribute's value is checked, and what it becomes. */
type AttributeRule = 'align' | 'url' | 'text' | 'number' | 'direction' | 'boolean'

interface TagRule {
  /** No closing tag, and never pushed onto the balance stack. */
  empty?: boolean
  attributes?: Record<string, AttributeRule>
  /**
   * An attribute without which the element is not worth emitting.
   *
   * An `<a href="javascript:…">` whose URL is rejected would otherwise become a
   * bare `<a>`: still safe, but a piece of text styled as a link that does
   * nothing when clicked. Markdown links already answer this by keeping the
   * text and dropping the anchor, and raw HTML should not answer it differently.
   */
  needs?: string
}

/**
 * The elements user markdown may write, and what each one may carry.
 *
 * Chosen from what READMEs actually contain rather than from what is
 * theoretically harmless. `details` and `summary` are the reason this exists;
 * `div align` and `p align` are how a project centres its logo; the inline set
 * is what people reach for mid-sentence; the table and list elements are here
 * because a repository that writes its feature matrix in HTML would otherwise
 * show a wall of angle brackets.
 *
 * Absent on purpose: `script`, `style`, `iframe`, `object`, `embed`, `form`,
 * `input`, `button`, `svg`, `math`, `link`, `meta`, `base`, and headings.
 * The first group is the obvious one. Headings are excluded because their ids
 * are namespaced in `render.ts` to stop user text colliding with the page's own
 * element names, and a raw `<h2 id>` would be a way around that.
 */
export const ALLOWED_TAGS: Record<string, TagRule> = {
  details: { attributes: { open: 'boolean' } },
  summary: {},

  div: { attributes: { align: 'align', dir: 'direction' } },
  p: { attributes: { align: 'align', dir: 'direction' } },
  span: { attributes: { dir: 'direction' } },
  blockquote: {},

  br: { empty: true },
  hr: { empty: true },

  b: {},
  strong: {},
  i: {},
  em: {},
  u: {},
  s: {},
  del: {},
  ins: {},
  mark: {},
  small: {},
  sub: {},
  sup: {},
  kbd: {},
  samp: {},
  var: {},
  code: {},
  q: {},

  ul: {},
  ol: {},
  li: {},
  dl: {},
  dt: {},
  dd: {},

  table: { attributes: { align: 'align' } },
  thead: {},
  tbody: {},
  tfoot: {},
  tr: {},
  th: { attributes: { align: 'align', colspan: 'number', rowspan: 'number' } },
  td: { attributes: { align: 'align', colspan: 'number', rowspan: 'number' } },
  caption: {},

  a: { attributes: { href: 'url', title: 'text' }, needs: 'href' },
  img: { empty: true, attributes: { src: 'url', alt: 'text', title: 'text', width: 'number', height: 'number' }, needs: 'src' },
}

const ALIGNMENTS = new Set(['left', 'center', 'right', 'justify'])
const DIRECTIONS = new Set(['ltr', 'rtl', 'auto'])

/**
 * One attribute, as it will appear in the tag, or null to leave it out.
 *
 * Everything returns escaped output or nothing. `text` is the only rule that
 * accepts arbitrary input, and it is only reachable for `alt` and `title`,
 * where arbitrary input is the point.
 */
function attribute(name: string, rule: AttributeRule, value: string | null): string | null {
  if (rule === 'boolean')
    return name

  if (value === null)
    return null

  switch (rule) {
    case 'align':
      return ALIGNMENTS.has(value.toLowerCase()) ? `${name}="${value.toLowerCase()}"` : null

    case 'direction':
      return DIRECTIONS.has(value.toLowerCase()) ? `${name}="${value.toLowerCase()}"` : null

    case 'number': {
      // Bounded as well as numeric: a width of a million is a layout attack
      // rather than a typo, and no legitimate README has one.
      const digits = /^\d{1,4}$/.exec(value.trim())

      return digits ? `${name}="${digits[0]}"` : null
    }

    case 'url': {
      // The same check markdown links get, entity decoding and all. There is
      // one answer to "may this be an href" in this pipeline and this is it.
      const url = safeUrl(value)

      return url ? `${name}="${escapeAttribute(url)}"` : null
    }

    case 'text':
      return `${name}="${escapeAttribute(value)}"`
  }
}

/** Whether a link leaves the site, and so needs the `rel` guards. */
function isExternal(url: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith('//')
}

/**
 * What an open tag turns into.
 *
 * Three outcomes rather than two, because "not allowed" and "allowed but
 * useless" want different treatment. `reject` shows the source text, so
 * somebody who writes `<iframe src=…>` can see that it did not work. `elide`
 * drops the tags and keeps what was between them, which is what a rejected
 * `href` should leave behind: the words, not a dead link.
 */
export type BuiltTag =
  | { kind: 'tag', html: string, empty: boolean }
  | { kind: 'elide' }
  | { kind: 'reject' }

export function buildOpenTag(name: string, attributes: Array<[string, string | null]>): BuiltTag {
  const rule = ALLOWED_TAGS[name]
  if (!rule)
    return { kind: 'reject' }

  const parts: string[] = [name]
  const seen = new Set<string>()

  for (const [attributeName, value] of attributes) {
    const attributeRule = rule.attributes?.[attributeName]
    // Duplicates keep the first, which is what a browser does with them.
    if (!attributeRule || seen.has(attributeName))
      continue

    const built = attribute(attributeName, attributeRule, value)
    if (built) {
      seen.add(attributeName)
      parts.push(built)
    }
  }

  // The attribute was written and did not survive validation, so the element
  // has nothing left to do. An element that never carried it at all is a
  // different case - `<a name="x">` is an old-fashioned anchor, not a broken
  // link - and is left alone.
  if (rule.needs && !seen.has(rule.needs) && attributes.some(([key]) => key === rule.needs))
    return { kind: 'elide' }

  // An anchor out of user text gets the same guards a markdown link gets. It is
  // added here rather than declared in the table because it depends on the
  // value, not on the attribute being present.
  if (name === 'a') {
    const href = attributes.find(([attributeName]) => attributeName === 'href')?.[1]
    const url = href ? safeUrl(href) : null
    if (url && isExternal(url))
      parts.push('rel="nofollow noopener noreferrer"')
  }

  // Consistent with markdown images, which have carried this since they were
  // written: a README with thirty badges should not fetch thirty images to
  // show the first paragraph.
  if (name === 'img')
    parts.push('loading="lazy"')

  return { kind: 'tag', html: `<${parts.join(' ')}>`, empty: rule.empty === true }
}

/** How a token's source text reads when it is not allowed through. */
function sourceOf(token: HtmlToken): string {
  if (token.kind === 'close')
    return `</${token.name}>`

  if (token.kind !== 'open')
    return ''

  const attributes = token.attributes
    .map(([name, value]) => (value === null ? name : `${name}="${value}"`))
    .join(' ')

  return `<${token.name}${attributes ? ` ${attributes}` : ''}${token.selfClosing ? ' /' : ''}>`
}

/**
 * A writer that keeps one document's raw HTML balanced.
 *
 * Stateful because balance is: whether `</details>` may be emitted depends on
 * what came before it, and the runs it has to decide about arrive one at a time
 * from the markdown renderer. One writer per render, and `close()` at the end.
 */
export interface HtmlWriter {
  /** One run of text, as HTML. `onText` renders the parts that are not tags. */
  write: (run: string, onText: (text: string) => string) => string
  /** Closers for everything the document left open. Empty when it was balanced. */
  close: () => string
}

export function createHtmlWriter(): HtmlWriter {
  /** Open elements, innermost last. `elided` ones emit no closer. */
  const open: Array<{ name: string, elided: boolean }> = []

  const closeTo = (depth: number): string => {
    let out = ''
    while (open.length > depth) {
      const element = open.pop()!
      if (!element.elided)
        out += `</${element.name}>`
    }

    return out
  }

  return {
    write(run, onText) {
      let out = ''

      for (const token of tokenizeHtml(run)) {
        if (token.kind === 'drop')
          continue

        if (token.kind === 'text') {
          out += onText(token.text)
          continue
        }

        if (token.kind === 'open') {
          const built = buildOpenTag(token.name, token.attributes)

          if (built.kind === 'reject') {
            out += escapeText(sourceOf(token))
            continue
          }

          const empty = built.kind === 'tag' ? built.empty : false
          if (built.kind === 'tag')
            out += built.html

          // `<br/>` is how half the world writes it, and an author closing an
          // element inline meant it to be closed.
          if (!empty && !token.selfClosing)
            open.push({ name: token.name, elided: built.kind === 'elide' })

          continue
        }

        const depth = open.findLastIndex(element => element.name === token.name)
        if (depth < 0) {
          // The invariant: a close tag this writer did not open is text. It is
          // what stops user markup ending the container it was placed in.
          out += escapeText(sourceOf(token))
          continue
        }

        // Everything opened inside it is closed with it, the way a browser
        // resolves `<b><i></b>`.
        out += closeTo(depth)
      }

      return out
    },

    close: () => closeTo(0),
  }
}

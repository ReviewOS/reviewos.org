/**
 * User markdown to HTML.
 *
 * Every issue body, comment, review, release note and repository README goes
 * through here, and all of it is hostile input: anyone who can open an issue,
 * or get a repository mirrored, can choose what this function is handed.
 *
 * **Nothing here sanitizes a string.** The HTML is *constructed*, tag by tag,
 * from the parse tree, out of a closed set of elements and attributes. Text is
 * escaped at the moment it is placed, and a URL is checked before it becomes an
 * attribute. There is no pass that takes attacker-shaped HTML and tries to make
 * it safe, because that pass is the part everybody gets wrong: a regex that
 * looks for `<script>` has to be right about every way a browser can be made to
 * see a tag, and it only has to be wrong once.
 *
 * The parser is Bun's (md4c under the hood), run with raw HTML disabled at the
 * parser level, so `<script>` in a README arrives here as *text* and leaves as
 * `&lt;script&gt;`. That is a deliberate fidelity trade: a README that centres
 * its logo with `<div align="center">` shows that markup instead of obeying it.
 * Supporting a safe subset of raw HTML needs a real HTML tokenizer, which is
 * its own piece of work rather than a flag flipped here.
 */

import { highlightLines } from '../Browse/highlight'
import { scanCommitReferences, scanIssueReferences, scanUserReferences } from './references'

export interface MarkdownContext {
  /** Repository the text belongs to. Without it, `#12` stays plain text. */
  owner?: string | null
  repository?: string | null
  /**
   * Collector for fenced code blocks, set by `renderMarkdownHighlighted`.
   *
   * Highlighting is asynchronous and the parser's callbacks are not, so the
   * blocks are parked here on the way past and their markers filled in once the
   * highlighter has answered.
   */
  codeBlocks?: CodeBlock[]
  /**
   * Prefix for generated heading ids.
   *
   * Headings come from user text, so their ids do too, and an id is a global
   * name on the page: an issue titled "nav" would otherwise be able to collide
   * with the site's own element and steal a `label for=` or an anchor. The
   * prefix keeps user-chosen names in their own namespace.
   */
  headingIdPrefix?: string
}

const DEFAULT_HEADING_PREFIX = 'user-content-'

/** Schemes a link may use. Everything else renders as plain text. */
const SAFE_SCHEMES = new Set(['http', 'https', 'mailto'])

/**
 * Parser options.
 *
 * `noHtmlBlocks` and `noHtmlSpans` are the load-bearing pair: they stop md4c
 * from ever producing a raw-HTML node, so there is no raw HTML to decide about
 * later. The rest is GitHub-flavoured markdown as people expect to write it.
 */
const PARSER_OPTIONS = {
  noHtmlBlocks: true,
  noHtmlSpans: true,
  tables: true,
  strikethrough: true,
  tasklists: true,
  autolinks: true,
  headings: { ids: true },
} as const

/** Text placed between tags. */
export function escapeText(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

/**
 * Text placed inside a double-quoted attribute.
 *
 * Quotes as well, obviously, but also `<`: an unescaped `<` inside an attribute
 * is how mXSS gets started when anything downstream reparses the markup.
 */
export function escapeAttribute(value: string): string {
  return escapeText(value)
    .replaceAll('"', '&quot;')
    .replaceAll('\'', '&#39;')
}

/**
 * Undo HTML entities enough to see what a browser would see in an `href`.
 *
 * The parser hands back the URL exactly as written, so `&#106;avascript:alert(1)`
 * arrives looking harmless while a browser decodes it to `javascript:` and runs
 * it. Decoding numeric and the handful of named entities before the scheme
 * check is what makes the check mean anything.
 */
function decodeEntities(value: string): string {
  return value.replace(/&(#\d+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]{1,31});?/g, (match, body: string) => {
    if (body.startsWith('#')) {
      const code = body[1] === 'x' || body[1] === 'X'
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10)

      return Number.isFinite(code) && code > 0 && code <= 0x10FFFF ? String.fromCodePoint(code) : match
    }

    const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'', colon: ':', tab: '\t', newline: '\n' }

    return named[body.toLowerCase()] ?? match
  })
}

/**
 * The URL to use, or null when the link should not be a link.
 *
 * Relative URLs pass: a README that links to `docs/setup.md` is doing the right
 * thing. An absolute URL has to carry a scheme we allow, checked after entity
 * decoding and after stripping the whitespace and control characters that exist
 * in these strings only to break a check like this one.
 */
export function safeUrl(raw: string): string | null {
  const decoded = decodeEntities(raw).trim()

  // Whitespace and control characters inside a scheme (`java\tscript:`) are
  // ignored by browsers and are never legitimate.
  const collapsed = decoded.replace(/[\u0000-\u0020\u007F-\u009F]/g, '')
  if (!collapsed)
    return null

  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(collapsed)
  if (scheme && !SAFE_SCHEMES.has(scheme[1]!.toLowerCase()))
    return null

  // Emitted as written rather than as decoded: the entity form is what the
  // author typed, and re-encoding is the attribute escaper's job.
  return decoded
}

/** Whether a link leaves the site, and so needs the `rel` guards. */
function isExternal(url: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith('//')
}

function link(href: string, inner: string, title?: string): string {
  const url = safeUrl(href)
  if (!url)
    return inner

  const attributes = [`href="${escapeAttribute(url)}"`]
  if (title)
    attributes.push(`title="${escapeAttribute(title)}"`)
  if (isExternal(url))
    attributes.push('rel="nofollow noopener noreferrer"')

  return `<a ${attributes.join(' ')}>${inner}</a>`
}

/** Emails autolink without a scheme, and need one to be a usable link. */
function withMailto(href: string): string {
  return /^[^\s:@]+@[^\s:@]+\.[^\s:@]+$/.test(href) ? `mailto:${href}` : href
}

/**
 * Turn `#12`, `@handle`, `<https://…>` and bare SHAs in one run of text into
 * links, escaping everything around them.
 *
 * Runs on text nodes only, which is what keeps it out of code: the parser hands
 * code spans and code blocks to their own callbacks, so a `#12` inside
 * backticks never reaches this function.
 */
export function linkifyText(text: string, context: MarkdownContext): string {
  const repository = context.owner && context.repository
    ? `/${encodeURIComponent(context.owner)}/${encodeURIComponent(context.repository)}`
    : null

  interface Span { index: number, length: number, html: string }
  const spans: Span[] = []

  // `<https://example.com>` is a CommonMark autolink, and disabling raw HTML
  // spans is what stops the parser recognising it, so it is recovered here.
  for (const match of text.matchAll(/<((?:https?|mailto):[^\s<>]+)>/gi)) {
    spans.push({
      index: match.index!,
      length: match[0].length,
      html: link(match[1]!, escapeText(match[1]!)),
    })
  }

  for (const found of scanUserReferences(text)) {
    spans.push({
      index: found.index,
      length: found.length,
      html: link(`/${encodeURIComponent(found.value.handle)}`, escapeText(text.slice(found.index, found.index + found.length))),
    })
  }

  if (repository) {
    for (const found of scanIssueReferences(text)) {
      const { owner, repository: name, number } = found.value
      const target = owner && name
        ? `/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`
        : repository

      spans.push({
        index: found.index,
        length: found.length,
        // Singular, matching the detail routes: `/issues` is the list and
        // `/issue/12` is the one issue, the same way `/pulls` and `/pull/12`
        // work.
        html: link(`${target}/issue/${number}`, escapeText(text.slice(found.index, found.index + found.length))),
      })
    }

    for (const found of scanCommitReferences(text)) {
      spans.push({
        index: found.index,
        length: found.length,
        // Shortened the way git does, because a 40-character hex string in the
        // middle of a sentence is unreadable.
        html: link(`${repository}/commits/${found.value}`, `<code>${escapeText(found.value.slice(0, 7))}</code>`),
      })
    }
  }

  return replaceSpans(text, spans)
}

/**
 * Splice spans into text, escaping what is left over.
 *
 * Overlaps are resolved by keeping the earlier span, then the longer one: a SHA
 * scanner and an issue scanner can both claim part of the same run, and two
 * overlapping replacements would produce broken markup rather than a wrong
 * link.
 */
function replaceSpans(text: string, spans: Array<{ index: number, length: number, html: string }>): string {
  if (spans.length === 0)
    return escapeText(text)

  const ordered = [...spans].sort((a, b) => a.index - b.index || b.length - a.length)

  let out = ''
  let cursor = 0

  for (const span of ordered) {
    if (span.index < cursor)
      continue

    out += escapeText(text.slice(cursor, span.index))
    out += span.html
    cursor = span.index + span.length
  }

  return out + escapeText(text.slice(cursor))
}

/** Alignment is a fixed set, so it can be an attribute without escaping games. */
function alignAttribute(align?: string): string {
  return align === 'left' || align === 'center' || align === 'right' ? ` align="${align}"` : ''
}

/**
 * Marks one run of text while the tree is being built.
 *
 * A text run cannot be turned into HTML the moment it arrives, because at that
 * point there is no way to know what encloses it: the parser calls `text`
 * before it calls the `code` or `link` that the run belongs to. Escaping and
 * linkifying immediately produced code blocks escaped twice, and `#12` inside
 * a code sample turned into a link.
 *
 * So each run is parked and replaced by a marker, and every callback that cares
 * resolves the markers it was handed the way its own element needs them. The
 * markers use characters that are stripped from the input, so nothing a user
 * writes can be mistaken for one.
 */
const RUN_MARKER = /\u0001(\d+)\u0002/g

/** One fenced block, on its way to the highlighter. */
export interface CodeBlock {
  language: string | null
  code: string
}

/**
 * The stand-in a fenced block leaves behind while it waits to be highlighted.
 *
 * Same trick as the text runs, and safe for the same reason: the marker
 * characters are stripped from the input, so nothing a user writes can forge
 * one, and the surrounding HTML is ours.
 */
const BLOCK_MARKER = /\u0003(\d+)\u0004/g

function blockMarker(index: number): string {
  return `\u0003${index}\u0004`
}

/**
 * Render markdown to HTML that is safe to place in a page.
 *
 * The return value is trusted output and is meant to be emitted raw
 * (`{!! … !!}` in a template). That is the whole point of the function, and the
 * reason it is the only thing allowed to produce HTML from user text.
 */
export function renderMarkdown(source: string, context: MarkdownContext = {}): string {
  if (!source)
    return ''

  const prefix = context.headingIdPrefix ?? DEFAULT_HEADING_PREFIX

  // NUL is dropped because browsers treat it inconsistently inside markup, and
  // the marker characters because otherwise a body could forge a marker.
  const input = source
    .replaceAll('\0', '')
    .replaceAll('\u0001', '')
    .replaceAll('\u0002', '')
    .replaceAll('\u0003', '')
    .replaceAll('\u0004', '')

  const runs: string[] = []
  const park = (value: string): string => `\u0001${runs.push(value) - 1}\u0002`
  const resolve = (children: string, how: (run: string) => string): string =>
    children.replace(RUN_MARKER, (_, index: string) => how(runs[Number(index)] ?? ''))

  /** Text as written, escaped. For code, and for anything going in an attribute. */
  const plain = (children: string): string => resolve(children, escapeText)
  /** Text with its references linked. For prose. */
  const prose = (children: string): string => resolve(children, run => linkifyText(run, context))
  /** Text as written, unescaped, for a caller that will escape it itself. */
  const raw = (children: string): string => resolve(children, run => run)

  const html = Bun.markdown.render(input, {
    text: park,

    heading: (children, meta) => {
      const id = meta.id ? ` id="${escapeAttribute(prefix + meta.id)}"` : ''
      const level = Math.min(Math.max(meta.level, 1), 6)

      return `<h${level}${id}>${children}</h${level}>`
    },

    paragraph: children => `<p>${children}</p>`,
    blockquote: children => `<blockquote>${children}</blockquote>`,
    hr: () => '<hr>',

    strong: children => `<strong>${children}</strong>`,
    emphasis: children => `<em>${children}</em>`,
    strikethrough: children => `<del>${children}</del>`,

    // Code stays as written: escaped, never linkified. `fixes #12` in a shell
    // sample is an example, not a reference.
    codespan: children => `<code>${plain(children)}</code>`,
    code: (children, meta) => {
      const language = meta?.language && /^[\w+#.-]{1,30}$/.test(meta.language)
        ? meta.language.toLowerCase()
        : null

      const attribute = language ? ` class="language-${escapeAttribute(language)}"` : ''
      const body = context.codeBlocks
        ? blockMarker(context.codeBlocks.push({ language, code: raw(children) }) - 1)
        : plain(children)

      return `<pre><code${attribute}>${body}</code></pre>`
    },

    list: (children, meta) => {
      if (!meta.ordered)
        return `<ul>${children}</ul>`

      const start = meta.start && meta.start !== 1 ? ` start="${Math.trunc(meta.start)}"` : ''

      return `<ol${start}>${children}</ol>`
    },
    listItem: (children, meta) => {
      if (typeof meta.checked !== 'boolean')
        return `<li>${children}</li>`

      const checked = meta.checked ? ' checked' : ''

      // Disabled, because ticking it has to write back to the markdown source,
      // which is an action rather than a rendering concern.
      return `<li class="task-item"><input type="checkbox" disabled${checked}>${children}</li>`
    },

    table: children => `<table>${children}</table>`,
    thead: children => `<thead>${children}</thead>`,
    tbody: children => `<tbody>${children}</tbody>`,
    tr: children => `<tr>${children}</tr>`,
    th: (children, meta) => `<th${alignAttribute(meta?.align)}>${children}</th>`,
    td: (children, meta) => `<td${alignAttribute(meta?.align)}>${children}</td>`,

    // Link text is escaped rather than linkified: a `#12` inside a link would
    // otherwise become an anchor nested in an anchor, which is not valid HTML
    // and renders as a mess.
    link: (children, meta) => link(withMailto(meta.href), plain(children), meta.title),
    image: (children, meta) => {
      // The alt text arrives as the image's children, not in the metadata.
      const alt = raw(children)
      const url = safeUrl(meta.src)
      if (!url)
        return escapeText(alt)

      const title = meta.title ? ` title="${escapeAttribute(meta.title)}"` : ''

      return `<img src="${escapeAttribute(url)}" alt="${escapeAttribute(alt)}"${title} loading="lazy">`
    },

    // Unreachable while raw HTML is disabled at the parser, and dropped rather
    // than trusted if that ever changes.
    html: () => '',
  }, PARSER_OPTIONS)

  // Everything still carrying a marker is prose, and gets its references.
  return prose(html)
}

/**
 * Render markdown, with the code fences highlighted.
 *
 * The same highlighter the file browser and the diff use, so a snippet quoted
 * in an issue and the file it came from are coloured the same way. Sharing it
 * is the point: two highlighters disagreeing about what a keyword looks like is
 * the sort of thing nobody reports and everybody notices.
 *
 * Asynchronous because highlighting is, and the parser's callbacks are not: the
 * blocks are collected on the way past and their markers filled in afterwards.
 * `renderMarkdown` stays synchronous for the callers that do not need this.
 */
export async function renderMarkdownHighlighted(source: string, context: MarkdownContext = {}): Promise<string> {
  const codeBlocks: CodeBlock[] = []
  const html = renderMarkdown(source, { ...context, codeBlocks })

  if (codeBlocks.length === 0)
    return html

  const rendered = await Promise.all(codeBlocks.map(block => highlightBlock(block)))

  return html.replace(BLOCK_MARKER, (_, index: string) => rendered[Number(index)] ?? '')
}

/**
 * One block, as highlighted HTML.
 *
 * Falls back to the escaped source for a language the highlighter does not
 * know, which is most of what people paste. Nothing here throws: showing code
 * uncoloured is always better than showing an error where the code was.
 */
async function highlightBlock(block: CodeBlock): Promise<string> {
  const code = block.code.replace(/\n$/, '')

  if (!block.language)
    return escapeText(code)

  // `highlightLines` takes a path, because that is what the file browser has.
  // A fence has a language instead, and the extension table is keyed by both.
  const lines = await highlightLines(code.split('\n'), `fence.${block.language}`)

  return lines
    .map(tokens => tokens.map(token => `<span class="t-${token.type}">${escapeText(token.content)}</span>`).join(''))
    .join('\n')
}

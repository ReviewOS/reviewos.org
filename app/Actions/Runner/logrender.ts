/**
 * A structured log, as the markup a run screen shows.
 *
 * Server-rendered, like the diff: the log is usually finished by the time
 * anybody opens it, and assembling it in the browser would mean the page is
 * blank until a second request lands.
 *
 * **Everything here returns HTML**, and every piece of text inside it has been
 * through `renderAnsi`, which escapes before it decorates. Nothing from a job's
 * output reaches the page as markup - the bytes came off a machine executing
 * hostile code, and a log that can write a `<script>` tag is a log that owns the
 * page it is displayed on.
 */

import type { LogEvent } from './logevents'
import { groupEvents } from './logevents'
import { escapeHtml, renderAnsi } from './ansi'

export interface RenderOptions {
  /**
   * Show the time each line was printed.
   *
   * Off by default: a timestamp on every line is a column of numbers most
   * readers do not want, and the ones who do are usually chasing something
   * specific. The events carry them either way, so this is a display choice
   * rather than a storage one.
   */
  timestamps?: boolean

  /**
   * The job this log belongs to, which turns every line into a link target.
   *
   * Absent means no ids, which is right for anything rendering a log outside a
   * run page: an id is a global name, and two logs on one page would collide.
   */
  jobId?: number

  /**
   * Where the bytes of an image event actually live, by artifact name.
   *
   * A resolver rather than a rule, because this file knows nothing about which
   * artifacts a run produced and should not: the caller has already read them,
   * and a renderer that queried the database per line would be a log page that
   * costs one round trip per screenshot.
   *
   * A name that is not in the map renders as a line saying so. That is the case
   * where a job printed an image event for an artifact it never uploaded, or
   * one that has expired, and a broken image with no explanation is the worst
   * of the three ways to answer it.
   */
  images?: Record<string, { src: string, caption?: string }>
}

/** `14:32:07`, in the reader's terms rather than the runner's timezone. */
function clockOf(at: string): string {
  const parsed = Date.parse(at)

  if (!Number.isFinite(parsed))
    return ''

  return new Date(parsed).toISOString().slice(11, 19)
}

/**
 * One image the job produced, shown where it printed it.
 *
 * `loading="lazy"` because a log with forty screenshots in it is a page that
 * would otherwise fetch forty images before the reader has scrolled to the
 * first, and the failure is usually at the bottom.
 *
 * No width or height is asserted: the bytes came off somebody's build and the
 * dimensions this server would have to state are ones it has not measured. The
 * stylesheet caps the rendered size instead, which is the property that matters
 * - an image a build can make fill the screen is one it can use to hide the
 * output around it.
 */
function renderImage(event: LogEvent, options: RenderOptions, line?: number): string {
  const anchor = options.jobId && line ? ` id="log-${options.jobId}-${line}"` : ''
  const name = String(event.artifact ?? '')
  const found = options.images?.[name]
  const alt = event.text || `image from artifact ${name}`

  if (!found) {
    /*
     * Said in words rather than shown as a broken image. An artifact that
     * expired is the common case and it is not an error: the log is old, the
     * bytes were kept for as long as the instance keeps them, and the reader
     * needs to know that rather than to see a torn-page icon.
     */
    return `<div${anchor} class="log-image-missing log-line"><span class="log-text">`
      + `[image: ${escapeHtml(alt)} - artifact <code>${escapeHtml(name)}</code> is not available]`
      + `</span></div>`
  }

  const caption = found.caption ?? event.text

  return `<figure${anchor} class="log-image">`
    + `<a href="${escapeHtml(found.src)}" class="log-image-link">`
    + `<img src="${escapeHtml(found.src)}" alt="${escapeHtml(alt)}" loading="lazy" decoding="async">`
    + `</a>`
    + (caption ? `<figcaption class="log-image-caption">${escapeHtml(caption)}</figcaption>` : '')
    + `</figure>`
}

/** One line: its time, its stream, and its text with colour and links. */
function renderLine(event: LogEvent, options: RenderOptions, line?: number): string {
  const time = options.timestamps && event.at
    ? `<span class="log-time">${escapeHtml(clockOf(event.at))}</span>`
    : ''

  /*
   * An id per line, so a link can point at one.
   *
   * The whole value of searching a log is landing on the line rather than on
   * the job that contains it, and a fragment is the only way to do that without
   * script. Prefixed with the job, because a run has several logs and an id is
   * a global name on the page.
   */
  const anchor = options.jobId && line
    ? ` id="log-${options.jobId}-${line}"`
    : ''

  // The stream is a class rather than a prefix, so a reader can dim stdout or
  // colour stderr without the text itself carrying a marker somebody's build
  // could have printed.
  return `<div${anchor} class="log-line log-${event.stream === 'stderr' ? 'stderr' : 'stdout'}">${time}<span class="log-text">${renderAnsi(event.text)}</span></div>`
}

/**
 * The whole log, grouped the way the job asked.
 *
 * A group is a `<details>`, which is the one collapsible element that works
 * with no script at all - the run screen carries almost none, and a fold that
 * needs JavaScript is a fold that does not exist for a reader who blocked it.
 *
 * **Open when it failed, closed otherwise.** A job that groups its output is
 * usually grouping the parts nobody reads; the exception is the group the
 * failure is in, and a reader who has to open six folds to find it would rather
 * have had none. `failed` is passed in rather than guessed from the text: the
 * job's state is a fact this server has, and searching output for the word
 * "error" is how a green build gets a red group.
 */
export function renderLog(events: readonly LogEvent[], options: RenderOptions & { failed?: boolean } = {}): string {
  if (events.length === 0)
    return ''

  const groups = groupEvents(events)

  /*
   * Line numbers run across the whole log rather than per group, because that
   * is the number a search reports and a reader counts: a fold is a way of
   * showing output, not a second numbering of it.
   */
  let number = 0

  return groups.map((group) => {
    const body = group.lines
      .map(line => (line.type === 'image' ? renderImage(line, options, ++number) : renderLine(line, options, ++number)))
      .join('')

    if (!group.grouped)
      return body

    // The last group of a failed job is the one somebody came for: a build
    // that stops does so inside whatever it was doing.
    const isLast = groups.at(-1) === group
    const open = options.failed && isLast ? ' open' : ''

    return `<details class="log-group"${open}>`
      + `<summary class="log-group-name">${renderAnsi(group.name, { link: false })}</summary>`
      + `<div class="log-group-body">${body}</div>`
      + `</details>`
  }).join('')
}

/**
 * Plain text as lines, so one renderer serves both forms.
 *
 * A log stored before events existed, or sent by a runner that does not use
 * them, still wants colour and links - and having two renderers would mean the
 * older half of a job's output looked different from the newer half.
 */
export function eventsFromText(text: string, stream: 'stdout' | 'stderr' = 'stdout'): LogEvent[] {
  const body = String(text ?? '')

  if (!body)
    return []

  // A trailing newline is a line ending, not an empty line: splitting without
  // this adds a blank row to the end of every log.
  const lines = body.replace(/\n$/, '').split('\n')

  return lines.map(line => ({ type: 'line' as const, text: line, at: '', stream }))
}

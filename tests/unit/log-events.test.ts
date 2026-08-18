// A job's output as events: what is accepted, how it folds, and what it renders
// as.
//
// The parsing half is validation of what a machine running hostile code sent,
// so the interesting cases are the malformed ones. The grouping half decides
// what somebody sees when a build fails inside a group it never got to close -
// which is the case that matters, because that group is the one they came for.

import { describe, expect, test } from 'bun:test'
import { eventsAsText, groupEvents, MAX_EVENTS_PER_APPEND, parseEvents } from '../../app/Actions/Runner/logevents'
import { eventsFromText, renderLog } from '../../app/Actions/Runner/logrender'
import { MAX_INLINE_IMAGE_BYTES, RENDERABLE_IMAGE_TYPES, sniffImage } from '../../app/Actions/Workflow/LogImageAction'

const line = (text: string, over: Record<string, unknown> = {}) => ({ type: 'line', text, ...over })

describe('reading what a runner sent', () => {
  test('keeps the three event types and the fields each carries', () => {
    const events = parseEvents([
      { type: 'group', text: 'Install' },
      { type: 'line', text: 'bun install', at: '2026-08-13T10:00:00.000Z', stream: 'stderr' },
      { type: 'endgroup' },
    ])

    expect(events).toHaveLength(3)
    expect(events[1]).toEqual({
      type: 'line',
      text: 'bun install',
      at: '2026-08-13T10:00:00.000Z',
      stream: 'stderr',
    })
  })

  /*
   * A newer runner sending an event type this server has not learned is the
   * ordinary state of a fleet mid-upgrade. Refusing the whole append would lose
   * the lines around it - which are the ones somebody is waiting to read.
   */
  test('drops an event type it does not know rather than refusing the append', () => {
    const events = parseEvents([
      line('before'),
      { type: 'annotation', text: 'from the future' },
      line('after'),
    ])

    expect(events.map(event => event.text)).toEqual(['before', 'after'])
  })

  test('a timestamp that is not a date is dropped, never replaced with now', () => {
    // Inventing one would produce a duration nobody could tell from a real
    // measurement.
    expect(parseEvents([line('x', { at: 'yesterday' })])[0]!.at).toBe('')
    expect(parseEvents([line('x')])[0]!.at).toBe('')
  })

  test('an unknown stream is stdout, because that is what output is', () => {
    expect(parseEvents([line('x', { stream: 'console' })])[0]!.stream).toBe('stdout')
  })

  test('anything that is not an array of objects is nothing', () => {
    for (const sent of [null, 'lines', 42, { type: 'line' }, [null, 'x', 7]])
      expect(parseEvents(sent as any)).toEqual([])
  })

  test('a blank line is a line, because builds print them', () => {
    expect(parseEvents([line('')])).toHaveLength(1)
  })

  test('and one append cannot be unbounded', () => {
    const many = Array.from({ length: MAX_EVENTS_PER_APPEND + 500 }, (_, at) => line(`line ${at}`))

    expect(parseEvents(many)).toHaveLength(MAX_EVENTS_PER_APPEND)
  })
})

describe('the text beside the structure', () => {
  test('is what a plain-text reader would have seen', () => {
    const events = parseEvents([
      { type: 'group', text: 'Install' },
      line('bun install'),
      { type: 'endgroup' },
      line('done'),
    ])

    expect(eventsAsText(events)).toBe('Install\nbun install\ndone\n')
  })
})

describe('folding', () => {
  test('lines land in the group that was open', () => {
    const groups = groupEvents(parseEvents([
      line('before'),
      { type: 'group', text: 'Build' },
      line('compiling'),
      { type: 'endgroup' },
      line('after'),
    ]))

    expect(groups.map(group => [group.name, group.lines.map(l => l.text)])).toEqual([
      ['', ['before']],
      ['Build', ['compiling']],
      ['', ['after']],
    ])
  })

  /*
   * The case that matters. A build that fails inside a group never gets to
   * close it, and treating that as malformed - flattening it, or dropping the
   * group - hides the failure inside a wall of lines.
   */
  test('a group nobody closed still holds its lines', () => {
    const groups = groupEvents(parseEvents([
      { type: 'group', text: 'Test' },
      line('1 failing'),
    ]))

    expect(groups).toHaveLength(1)
    expect(groups[0]!.name).toBe('Test')
    expect(groups[0]!.lines).toHaveLength(1)
  })

  test('a stray endgroup is ignored rather than losing what follows', () => {
    // The job closed something it never opened, which is a bug in their script
    // and not a reason to lose their output.
    const groups = groupEvents(parseEvents([{ type: 'endgroup' }, line('still here')]))

    expect(groups.flatMap(group => group.lines.map(l => l.text))).toEqual(['still here'])
  })

  test('an empty group is kept, because "it ran and printed nothing" is a fact', () => {
    const groups = groupEvents(parseEvents([{ type: 'group', text: 'Lint' }, { type: 'endgroup' }]))

    expect(groups.map(group => group.name)).toEqual(['Lint'])
  })
})

describe('rendering', () => {
  test('a group is a details element, so folding needs no script', () => {
    const html = renderLog(parseEvents([
      { type: 'group', text: 'Install' },
      line('bun install'),
    ]))

    expect(html).toContain('<details class="log-group"')
    expect(html).toContain('<summary class="log-group-name">Install</summary>')
  })

  /*
   * A job that groups its output is usually grouping the parts nobody reads.
   * The exception is the group the failure is in, and a reader who has to open
   * six folds to find it would rather have had none.
   */
  test('the last group of a failed job is open', () => {
    const events = parseEvents([
      { type: 'group', text: 'Install' },
      line('fine'),
      { type: 'endgroup' },
      { type: 'group', text: 'Test' },
      line('1 failing'),
    ])

    const failed = renderLog(events, { failed: true })
    const passed = renderLog(events, { failed: false })

    expect(failed.split('<details').at(-1)).toContain('open')
    expect(passed).not.toContain(' open')
  })

  test('timestamps are a display choice, not a storage one', () => {
    const events = parseEvents([line('x', { at: '2026-08-13T14:32:07.000Z' })])

    expect(renderLog(events, { timestamps: true })).toContain('14:32:07')
    expect(renderLog(events)).not.toContain('14:32:07')
  })

  test('stderr is a class, not a prefix somebody could have printed', () => {
    expect(renderLog(parseEvents([line('boom', { stream: 'stderr' })]))).toContain('log-stderr')
  })

  test('markup in the output is text, in a line and in a group name alike', () => {
    const html = renderLog(parseEvents([
      { type: 'group', text: '<script>alert(1)</script>' },
      line('<img onerror=alert(1)>'),
    ]))

    expect(html).not.toContain('<script>')
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;script&gt;')
  })

  test('plain text renders through the same path, so old output looks the same', () => {
    // Two renderers would mean the half of a job's log stored before events
    // existed looked different from the half after.
    const html = renderLog(eventsFromText('one\ntwo\n'))

    expect(html.match(/log-line/g)).toHaveLength(2)
  })

  test('and a trailing newline is a line ending rather than an empty line', () => {
    expect(eventsFromText('only\n')).toHaveLength(1)
  })
})

/*
 * Images, which are the one thing in a log that is not text.
 *
 * The whole feature is a content policy: a build that can put a picture on a
 * page a colleague opens is a build that can put a tracking pixel there, or an
 * SVG that runs. So the event names an artifact of its own run, never a URL,
 * and the renderer shows only what the caller resolved.
 */
describe('images', () => {
  test('need an artifact, and one without is dropped rather than shown as text', () => {
    const events = parseEvents([
      { type: 'image', text: 'the failing screen', artifact: 'screenshot.png' },
      // No artifact: a caption with nothing under it is not an image, and
      // rendering it as a line would put a stray sentence in the output.
      { type: 'image', text: 'nothing to show' },
    ])

    expect(events).toHaveLength(1)
    expect(events[0]!.artifact).toBe('screenshot.png')
    expect(events[0]!.text).toBe('the failing screen')
  })

  test('carry no URL, whatever the runner sends', () => {
    const [event] = parseEvents([
      { type: 'image', text: 'x', artifact: 'shot.png', src: 'https://elsewhere.example/pixel.gif', url: 'https://elsewhere.example/p.gif' },
    ])

    // The only address a log can name is an artifact of its own run. Anything
    // else would be a request the reader's browser makes to somebody else's
    // server every time the page opens.
    expect(JSON.stringify(event)).not.toContain('elsewhere.example')
  })

  test('read as a sentence in the plain-text form', () => {
    // `curl` of a log should say what was there rather than leave a gap.
    const text = eventsAsText(parseEvents([{ type: 'image', text: 'diff of the render', artifact: 'render.png' }]))

    expect(text).toContain('[image: diff of the render')
    expect(text).toContain('render.png')
  })

  test('render as a figure when the caller resolved the artifact', () => {
    const events = parseEvents([{ type: 'image', text: 'the failing screen', artifact: 'shot.png' }])
    const html = renderLog(events, { images: { 'shot.png': { src: '/api/repos/workflow-runs/log-image?artifact=shot.png' } } })

    expect(html).toContain('<figure')
    expect(html).toContain('loading="lazy"')
    expect(html).toContain('alt="the failing screen"')
    expect(html).toContain('/api/repos/workflow-runs/log-image?artifact=shot.png')
  })

  test('and say so in words when it is gone, rather than showing a broken image', () => {
    // An expired artifact is the common case and it is not an error: the log is
    // old, the bytes were kept for as long as this instance keeps them.
    const html = renderLog(parseEvents([{ type: 'image', text: 'the failing screen', artifact: 'shot.png' }]), { images: {} })

    expect(html).not.toContain('<img')
    expect(html).toContain('is not available')
    expect(html).toContain('shot.png')
  })

  test('escape their alt text like everything else off a machine', () => {
    const html = renderLog(
      parseEvents([{ type: 'image', text: '"><script>alert(1)</script>', artifact: 'shot.png' }]),
      { images: { 'shot.png': { src: '/x' } } },
    )

    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })

  test('and fold with the lines around them', () => {
    const html = renderLog(parseEvents([
      { type: 'group', text: 'Visual tests' },
      { type: 'line', text: 'comparing' },
      { type: 'image', text: 'diff', artifact: 'shot.png' },
      { type: 'endgroup' },
    ]), { images: { 'shot.png': { src: '/x' } } })

    // A screenshot printed inside a group belongs to that group: it is content,
    // not a marker.
    expect(html.indexOf('<figure')).toBeGreaterThan(html.indexOf('log-group-body'))
  })
})

/*
 * What may be rendered in place.
 *
 * The download endpoint hands artifacts over as attachments because the bytes
 * came off a machine running somebody's build. This is the one path that does
 * not, so what it will and will not serve is the whole of the decision.
 */
describe('the bytes a log will show', () => {
  const bytes = (...values: number[]) => new Uint8Array([...values, ...Array.from({ length: 16 }, () => 0)])

  test('are identified by their first bytes rather than by what the uploader said', () => {
    expect(sniffImage(bytes(0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A))).toBe('image/png')
    expect(sniffImage(bytes(0xFF, 0xD8, 0xFF, 0xE0))).toBe('image/jpeg')
    expect(sniffImage(bytes(0x47, 0x49, 0x46, 0x38, 0x39, 0x61))).toBe('image/gif')
    expect(sniffImage(new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50, 0, 0]))).toBe('image/webp')
  })

  test('and SVG is refused, whatever it contains', () => {
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')

    // The one image format that is a document: rendering it in place means
    // running it, and no amount of sanitising makes that a picture.
    expect(sniffImage(svg)).toBeNull()
  })

  test('and anything else is nothing, including a file that lies about itself', () => {
    expect(sniffImage(new TextEncoder().encode('#!/bin/sh\nrm -rf /\n'))).toBeNull()
    expect(sniffImage(new Uint8Array([1, 2, 3]))).toBeNull()
    expect(sniffImage(new Uint8Array())).toBeNull()
  })

  test('with a size somebody can actually open', () => {
    // A hundred-megabyte PNG is not a screenshot, and a log page that fetches
    // one is a page nobody can read.
    expect(MAX_INLINE_IMAGE_BYTES).toBeLessThanOrEqual(16 * 1024 * 1024)
    expect(RENDERABLE_IMAGE_TYPES).not.toContain('image/svg+xml')
  })
})

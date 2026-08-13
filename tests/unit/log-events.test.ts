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

// What the checks tab says, and where a check's findings land in the diff.
//
// The rollup has its own tests and answers one question: may this merge. These
// cover the other one - what a person reads - and the cases that separate the
// two. A cancelled check and a failed check both block, and telling somebody
// their check "failed" when a newer push cancelled it sends them to read a log
// that says nothing.

import { describe, expect, test } from 'bun:test'
import {
  durationBetween,
  entryForMissing,
  entryFromRun,
  entryFromStatus,
  labelFor,
  labelForStatus,
  newestPerName,
} from '../../app/Actions/Checks/panel'
import { annotationsByLine, annotationsForLine, renderAnnotations } from '../../app/Actions/Pull/annotations'

const HEAD = 'a'.repeat(40)
const OLD = 'b'.repeat(40)

function run(overrides: Record<string, unknown> = {}): any {
  return {
    name: 'build',
    status: 'completed',
    conclusion: 'success',
    attempt: 1,
    head_sha: HEAD,
    started_at: '2026-08-12T10:00:00.000Z',
    completed_at: '2026-08-12T10:01:30.000Z',
    ...overrides,
  }
}

describe('the word a reader gets', () => {
  test('separates the ways a check can end', () => {
    expect(labelFor('completed', 'success').label).toBe('Passed')
    expect(labelFor('completed', 'failure').label).toBe('Failed')
    expect(labelFor('completed', 'cancelled').label).toBe('Cancelled')
    expect(labelFor('completed', 'timed_out').label).toBe('Timed out')
    expect(labelFor('completed', 'skipped').label).toBe('Skipped')
    expect(labelFor('queued', '').label).toBe('Queued')
    expect(labelFor('in_progress', '').label).toBe('Running')
  })

  /*
   * Cancelled and timed out both roll up as failures - nothing looked at the
   * code - and they are different things to be told. One means push again, the
   * other means the check needs a longer budget or a faster machine.
   */
  test('and does not call a cancellation a failure', () => {
    expect(labelFor('completed', 'cancelled').tone).toBe('muted')
    expect(labelFor('completed', 'timed_out').tone).toBe('bad')
  })

  test('a completed run with no conclusion says so rather than inventing one', () => {
    const { label, tone } = labelFor('completed', '')

    expect(label).toContain('without a conclusion')
    expect(tone).toBe('warn')
  })

  test('a commit status has three states and no conclusion', () => {
    expect(labelForStatus('success').label).toBe('Passed')
    expect(labelForStatus('pending').label).toBe('Running')
    expect(labelForStatus('error').label).toBe('Failed')
  })
})

describe('how long it took', () => {
  test('reads in the units somebody waits in', () => {
    expect(durationBetween('2026-08-12T10:00:00Z', '2026-08-12T10:00:09Z')).toBe('9s')
    expect(durationBetween('2026-08-12T10:00:00Z', '2026-08-12T10:01:30Z')).toBe('1m 30s')
    expect(durationBetween('2026-08-12T10:00:00Z', '2026-08-12T10:02:00Z')).toBe('2m')
    expect(durationBetween('2026-08-12T10:00:00Z', '2026-08-12T11:30:00Z')).toBe('1h 30m')
  })

  // A check that has not finished has no duration, and "0s" is a lie about a
  // check that has been running for twenty minutes.
  test('and is empty when one end is missing or the pair is nonsense', () => {
    expect(durationBetween('2026-08-12T10:00:00Z', null)).toBe('')
    expect(durationBetween(null, '2026-08-12T10:00:00Z')).toBe('')
    expect(durationBetween('2026-08-12T10:05:00Z', '2026-08-12T10:00:00Z')).toBe('')
  })
})

describe('a report about a commit that has been replaced', () => {
  test('is labelled with the commit it was about', () => {
    const entry = entryFromRun(run({ head_sha: OLD }), { required: new Set(['build']), headSha: HEAD })

    expect(entry.stale).toBe(true)
    expect(entry.staleSha).toBe(OLD)
    expect(entry.label).toContain('on an earlier commit')
    // Never green: the tick would be about code nobody is merging.
    expect(entry.tone).toBe('muted')
  })

  test('and a report on the head is not', () => {
    const entry = entryFromRun(run(), { required: new Set(), headSha: HEAD })

    expect(entry.stale).toBe(false)
    expect(entry.label).toBe('Passed')
    expect(entry.duration).toBe('1m 30s')
  })
})

describe('choosing what to show per name', () => {
  test('a later attempt replaces the earlier one', () => {
    const first = entryFromRun(run({ attempt: 1, conclusion: 'failure' }), { required: new Set(), headSha: HEAD })
    const second = entryFromRun(run({ attempt: 2, conclusion: 'success' }), { required: new Set(), headSha: HEAD })

    expect(newestPerName([first, second])[0]?.label).toBe('Passed')
    // Order in never decides the answer: a page that showed a different result
    // depending on row ids is worse than one that is wrong consistently.
    expect(newestPerName([second, first])[0]?.label).toBe('Passed')
  })

  test('a report on this commit beats a newer-looking one on an older commit', () => {
    const stale = entryFromRun(run({ attempt: 9, head_sha: OLD }), { required: new Set(), headSha: HEAD })
    const current = entryFromRun(run({ attempt: 1, conclusion: 'failure' }), { required: new Set(), headSha: HEAD })

    expect(newestPerName([stale, current])[0]?.stale).toBe(false)
  })

  test('required checks come first, then whatever is unhappy', () => {
    const entries = [
      entryFromRun(run({ name: 'zeta' }), { required: new Set(), headSha: HEAD }),
      entryFromRun(run({ name: 'alpha', conclusion: 'failure' }), { required: new Set(), headSha: HEAD }),
      entryFromStatus({ context: 'lint', state: 'success' }, new Set(['lint'])),
    ]

    expect(newestPerName(entries).map(entry => entry.name)).toEqual(['lint', 'alpha', 'zeta'])
  })
})

describe('a required check nothing has ever reported', () => {
  // The case a branch rule exists for, and the one every forge renders as an
  // empty row somebody scrolls past.
  test('says so in words rather than being absent', () => {
    const entry = entryForMissing('security/scan')

    expect(entry.label).toBe('Has never reported')
    expect(entry.required).toBe(true)
    expect(entry.state).toBe('pending')
  })
})

describe('annotations on the diff', () => {
  const items = [
    { path: 'src/a.ts', startLine: 10, endLine: 14, side: 'right', level: 'failure', title: 'Unused', message: 'x is never read' },
    { path: 'src/a.ts', startLine: 3, endLine: 3, side: 'left', level: 'warning', title: '', message: 'about the old line' },
  ]

  test('a range is placed once, on the line the eye has reached', () => {
    const index = annotationsByLine(items)

    expect(annotationsForLine(index, 'src/a.ts', { oldLine: null, newLine: 14 })).toHaveLength(1)
    // Not repeated across the range: five rows would be five findings, and a
    // reviewer counting them gets a number the tool never reported.
    expect(annotationsForLine(index, 'src/a.ts', { oldLine: null, newLine: 12 })).toHaveLength(0)
  })

  test('a left-side finding lands on the old line, not the new one', () => {
    const index = annotationsByLine(items)

    expect(annotationsForLine(index, 'src/a.ts', { oldLine: 3, newLine: null })).toHaveLength(1)
    // The failure this rule exists to prevent: a finding about a deleted line
    // printed under the line that replaced it.
    expect(annotationsForLine(index, 'src/a.ts', { oldLine: null, newLine: 3 })).toHaveLength(0)
  })

  test('another file is another file', () => {
    const index = annotationsByLine(items)

    expect(annotationsForLine(index, 'src/b.ts', { oldLine: null, newLine: 14 })).toEqual([])
  })

  test('the markup says the level, the range, and escapes what the tool sent', () => {
    const html = renderAnnotations([
      { path: 'a.ts', startLine: 10, endLine: 14, side: 'right', level: 'failure', title: '<b>t</b>', message: 'a & b' },
    ])

    expect(html).toContain('Error')
    expect(html).toContain('lines 10 to 14')
    expect(html).toContain('&lt;b&gt;t&lt;/b&gt;')
    expect(html).toContain('a &amp; b')
  })

  test('and nothing at all when there is nothing to say', () => {
    expect(renderAnnotations([])).toBe('')
  })
})

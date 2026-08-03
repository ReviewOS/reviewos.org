/**
 * An issue's history.
 *
 * An issue is a history, not a body with comments underneath it. None of it is
 * recoverable from the rows those changes wrote: an issue's `state` says it is
 * open now, never that it was closed on Tuesday by somebody who changed their
 * mind.
 *
 * The wording lives here rather than in the template so the pull request
 * timeline cannot word the same event differently from the issue one, and so a
 * reader never meets an event that renders as nothing at all.
 */

import { describe, expect, test } from 'bun:test'
import { entryIcon, entryRow, entrySentence } from '../../app/Actions/Issue/timeline'

const KINDS = [
  'closed',
  'reopened',
  'renamed',
  'labeled',
  'unlabeled',
  'assigned',
  'unassigned',
  'milestoned',
  'demilestoned',
  'locked',
  'unlocked',
  'referenced',
  'merged',
] as const

const SUBJECT = { type: 'issue' as const, id: 12 }

describe('entryRow', () => {
  test('carries the subject, the kind and the actor', () => {
    expect(entryRow(SUBJECT, 'closed', 7)).toMatchObject({
      subject_type: 'issue',
      subject_id: 12,
      kind: 'closed',
      actor_id: 7,
    })
  })

  test('accepts no actor, for an event nobody local caused', () => {
    expect(entryRow(SUBJECT, 'closed', null).actor_id).toBeNull()
  })

  test('trims the detail text', () => {
    expect(entryRow(SUBJECT, 'labeled', 1, { text: '  needs triage  ' }).subject_text).toBe('needs triage')
  })

  /** A label name arrives from a form and a title from a request body. */
  test('bounds the detail text to the column', () => {
    const row = entryRow(SUBJECT, 'renamed', 1, { previous: 'x'.repeat(400) })

    expect(String(row.previous_text)).toHaveLength(255)
  })

  test('stores an empty detail as absent rather than as an empty string', () => {
    const row = entryRow(SUBJECT, 'closed', 1, { text: '   ' })

    expect(row.subject_text).toBeNull()
  })

  test('leaves unset details null', () => {
    const row = entryRow(SUBJECT, 'closed', 1)

    expect(row.subject_text).toBeNull()
    expect(row.previous_text).toBeNull()
    expect(row.reference_number).toBeNull()
  })

  test('carries a cross reference', () => {
    expect(entryRow(SUBJECT, 'referenced', 1, { reference: 41 }).reference_number).toBe(41)
  })

  test('records against a pull request as readily as an issue', () => {
    expect(entryRow({ type: 'pull_request', id: 3 }, 'merged', 1).subject_type).toBe('pull_request')
  })
})

describe('entrySentence', () => {
  /**
   * The one property that matters: no kind may render as nothing. A blank line
   * in a history reads as "something happened here and we lost it".
   */
  test('says something for every kind the model allows', () => {
    for (const kind of KINDS)
      expect(entrySentence(kind, { text: 'x', previous: 'y', reference: 1 }).trim().length).toBeGreaterThan(0)
  })

  test('reads as a fragment following a name', () => {
    expect(entrySentence('closed')).toBe('closed this')
    expect(entrySentence('reopened')).toBe('reopened this')
    expect(entrySentence('merged')).toBe('merged this')
  })

  test('names what a label change was about', () => {
    expect(entrySentence('labeled', { text: 'bug' })).toBe('added the bug label')
    expect(entrySentence('unlabeled', { text: 'bug' })).toBe('removed the bug label')
  })

  test('names who was assigned', () => {
    expect(entrySentence('assigned', { text: 'chris' })).toBe('assigned chris')
    expect(entrySentence('unassigned', { text: 'chris' })).toBe('unassigned chris')
  })

  /** "removed this from 1.0" says more than "removed this". */
  test('names the milestone on the way out as well as in', () => {
    expect(entrySentence('milestoned', { text: '1.0' })).toBe('added this to 1.0')
    expect(entrySentence('demilestoned', { text: '1.0' })).toBe('removed this from 1.0')
  })

  test('gives a rename its old title', () => {
    expect(entrySentence('renamed', { previous: 'Old name' })).toContain('Old name')
  })

  /** A record written before the detail was captured still has to read. */
  test('stays a sentence when the detail is missing', () => {
    expect(entrySentence('renamed')).toBe('renamed this from its previous title')
    expect(entrySentence('labeled')).toBe('added the  label')
  })

  test('points a cross reference at the number that caused it', () => {
    expect(entrySentence('referenced', { reference: 41 })).toBe('referenced this in #41')
  })
})

describe('entryIcon', () => {
  test('gives every kind an icon', () => {
    for (const kind of KINDS)
      expect(entryIcon(kind)).toMatch(/^i-hugeicons-/)
  })

  /** Opposites share an icon, so the row reads by its words rather than its glyph. */
  test('pairs the two halves of a change', () => {
    expect(entryIcon('labeled')).toBe(entryIcon('unlabeled'))
    expect(entryIcon('assigned')).toBe(entryIcon('unassigned'))
    expect(entryIcon('milestoned')).toBe(entryIcon('demilestoned'))
  })

  test('distinguishes closing from reopening', () => {
    expect(entryIcon('closed')).not.toBe(entryIcon('reopened'))
  })
})

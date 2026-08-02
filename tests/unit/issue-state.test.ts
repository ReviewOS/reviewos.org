// Issue state transitions.
//
// Four different things close an issue (the button, the API, a closing keyword
// on push, a merged pull request), so the rules have to behave the same however
// they are reached, including when the issue is already closed.

import { describe, expect, test } from 'bun:test'
import { CLOSE_REASONS, issueStateLabel, issueStatePill, mayComment, normalizeCloseReason, transitionIssue } from '../../app/Actions/Issue/state'

const open = { state: 'open' as const, locked: false }
const closed = { state: 'closed' as const, locked: false }

describe('transitionIssue', () => {
  test('closing an open issue closes it as completed by default', () => {
    const result = transitionIssue(open, 'close')

    expect(result).toEqual({ ok: true, state: 'closed', reason: 'completed' })
  })

  test('a close reason is kept', () => {
    const result = transitionIssue(open, 'close', 'not_planned')

    expect(result.ok && result.reason).toBe('not_planned')
  })

  test('an unknown close reason is refused rather than silently dropped', () => {
    const result = transitionIssue(open, 'close', 'because')

    expect(result.ok).toBe(false)
    expect(result.ok === false && result.status).toBe(422)
  })

  test('closing an already closed issue changes nothing', () => {
    // A rebase that repeats `fixes #12` must not rewrite who closed it.
    const result = transitionIssue(closed, 'close')

    expect(result).toEqual({ ok: true, state: 'closed', reason: null })
  })

  test('reopening clears the reason', () => {
    const result = transitionIssue(closed, 'reopen')

    expect(result).toEqual({ ok: true, state: 'open', reason: null })
  })

  test('reopening an open issue is harmless', () => {
    expect(transitionIssue(open, 'reopen').ok).toBe(true)
  })

  test('a locked issue refuses both transitions', () => {
    const locked = { state: 'open' as const, locked: true }

    expect(transitionIssue(locked, 'close').ok).toBe(false)
    expect(transitionIssue(locked, 'reopen').ok).toBe(false)
  })

  test('a locked issue reports the status a client can act on', () => {
    const result = transitionIssue({ state: 'open', locked: true }, 'close')

    expect(result.ok === false && result.status).toBe(423)
  })

  test('every documented reason is accepted', () => {
    for (const reason of CLOSE_REASONS)
      expect(transitionIssue(open, 'close', reason).ok).toBe(true)
  })
})

describe('normalizeCloseReason', () => {
  test('accepts a known reason', () => {
    expect(normalizeCloseReason('duplicate')).toBe('duplicate')
  })

  test('is case insensitive', () => {
    expect(normalizeCloseReason('NOT_PLANNED')).toBe('not_planned')
  })

  test('treats absent as absent, not as an error value', () => {
    expect(normalizeCloseReason(null)).toBeNull()
    expect(normalizeCloseReason(undefined)).toBeNull()
    expect(normalizeCloseReason('')).toBeNull()
  })

  test('rejects anything else', () => {
    expect(normalizeCloseReason('wontfix')).toBeNull()
  })
})

describe('mayComment', () => {
  test('anyone may comment on an unlocked issue', () => {
    expect(mayComment({ locked: false, isMaintainer: false })).toBe(true)
  })

  test('a lock holds against a contributor', () => {
    expect(mayComment({ locked: true, isMaintainer: false })).toBe(false)
  })

  test('a maintainer may still add a closing note', () => {
    expect(mayComment({ locked: true, isMaintainer: true })).toBe(true)
  })
})

describe('issueStateLabel', () => {
  test('an open issue reads as open, whatever reason is stored', () => {
    expect(issueStateLabel('open', null)).toBe('Open')
    expect(issueStateLabel('open', 'completed')).toBe('Open')
  })

  test('says why an issue was closed', () => {
    // "Closed as not planned" and "Closed" are different outcomes for whoever
    // opened it, and the reason is usually what they came back to check.
    expect(issueStateLabel('closed', 'completed')).toBe('Closed')
    expect(issueStateLabel('closed', 'not_planned')).toBe('Closed as not planned')
    expect(issueStateLabel('closed', 'duplicate')).toBe('Closed as duplicate')
  })

  test('falls back to plain closed for a missing or unknown reason', () => {
    expect(issueStateLabel('closed', null)).toBe('Closed')
    expect(issueStateLabel('closed', 'wontfix')).toBe('Closed')
  })
})

describe('issueStatePill', () => {
  test('open is open', () => {
    expect(issueStatePill('open', null)).toBe('open')
  })

  test('a completed close gets the closed colour', () => {
    expect(issueStatePill('closed', 'completed')).toBe('closed')
    expect(issueStatePill('closed', null)).toBe('closed')
  })

  test('a close that was not a completion is not coloured like one', () => {
    expect(issueStatePill('closed', 'not_planned')).toBe('draft')
    expect(issueStatePill('closed', 'duplicate')).toBe('draft')
  })
})

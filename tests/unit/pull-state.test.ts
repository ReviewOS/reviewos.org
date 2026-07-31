// Pull request state transitions.
//
// The state a pull request has that an issue does not is `merged`, and it is
// terminal. Most of what is checked here is that nothing reopens a pull request
// whose changes are already in the base, because everything downstream (the
// diff, the merge box, the stack) assumes an open pull request still proposes
// something.

import { describe, expect, test } from 'bun:test'
import {
  editPullRequest,
  mayEdit,
  mayTransition,
  transitionDraft,
  transitionPullRequest,
} from '../../app/Actions/Pull/state'

const open = { state: 'open' as const, draft: false, headExists: true }
const closed = { state: 'closed' as const, draft: false, headExists: true }
const merged = { state: 'merged' as const, draft: false, headExists: true }

describe('transitionPullRequest', () => {
  test('closing an open pull request closes it', () => {
    expect(transitionPullRequest(open, 'close')).toEqual({ ok: true, state: 'closed', changed: true })
  })

  test('closing an already closed pull request changes nothing', () => {
    // A retried request must not rewrite who closed it and when.
    expect(transitionPullRequest(closed, 'close')).toEqual({ ok: true, state: 'closed', changed: false })
  })

  test('reopening a closed pull request opens it', () => {
    expect(transitionPullRequest(closed, 'reopen')).toEqual({ ok: true, state: 'open', changed: true })
  })

  test('reopening an open pull request changes nothing', () => {
    expect(transitionPullRequest(open, 'reopen')).toEqual({ ok: true, state: 'open', changed: false })
  })

  test('a merged pull request cannot be closed', () => {
    const result = transitionPullRequest(merged, 'close')

    expect(result.ok).toBe(false)
    expect(result.ok === false && result.status).toBe(409)
  })

  test('a merged pull request cannot be reopened', () => {
    const result = transitionPullRequest(merged, 'reopen')

    expect(result.ok).toBe(false)
    expect(result.ok === false && result.status).toBe(409)
  })

  test('reopening needs a head branch that still exists', () => {
    // Deleting the branch after closing is the common case, and reopening onto
    // nothing would leave a pull request with no diff and no way back.
    const result = transitionPullRequest({ ...closed, headExists: false }, 'reopen')

    expect(result.ok).toBe(false)
    expect(result.ok === false && result.status).toBe(409)
  })

  test('a missing head branch does not block closing', () => {
    expect(transitionPullRequest({ ...open, headExists: false }, 'close').ok).toBe(true)
  })
})

describe('transitionDraft', () => {
  test('marking an open pull request ready clears the draft flag', () => {
    expect(transitionDraft({ ...open, draft: true }, 'ready')).toEqual({ ok: true, draft: false, changed: true })
  })

  test('marking an already ready pull request ready changes nothing', () => {
    expect(transitionDraft(open, 'ready')).toEqual({ ok: true, draft: false, changed: false })
  })

  test('an open pull request can be converted back to a draft', () => {
    expect(transitionDraft(open, 'draft')).toEqual({ ok: true, draft: true, changed: true })
  })

  test('a closed pull request has no meaningful draft state', () => {
    const result = transitionDraft(closed, 'ready')

    expect(result.ok).toBe(false)
    expect(result.ok === false && result.status).toBe(409)
  })

  test('a merged pull request has no meaningful draft state', () => {
    expect(transitionDraft(merged, 'draft').ok).toBe(false)
  })
})

describe('who may act', () => {
  test('the author may close their own pull request without triage rights', () => {
    expect(mayTransition({ isAuthor: true, canClose: false })).toBe(true)
  })

  test('a triager may close somebody else\'s', () => {
    expect(mayTransition({ isAuthor: false, canClose: true })).toBe(true)
  })

  test('nobody else may', () => {
    expect(mayTransition({ isAuthor: false, canClose: false })).toBe(false)
  })

  test('editing is narrower than closing', () => {
    // Triage is enough to close, but rewriting the description changes what the
    // reviewers below it were responding to.
    expect(mayEdit({ isAuthor: false, canEditAny: false })).toBe(false)
    expect(mayEdit({ isAuthor: true, canEditAny: false })).toBe(true)
    expect(mayEdit({ isAuthor: false, canEditAny: true })).toBe(true)
  })
})

describe('editPullRequest', () => {
  const subject = { state: 'open' as const, headBranch: 'feature/x' }

  test('an omitted field is left alone', () => {
    expect(editPullRequest(subject, { title: 'New title' })).toEqual({
      ok: true,
      changes: { title: 'New title' },
    })
  })

  test('an empty body clears it, because absent and empty are different', () => {
    expect(editPullRequest(subject, { body: '' })).toEqual({ ok: true, changes: { body: '' } })
  })

  test('an empty title is refused', () => {
    const result = editPullRequest(subject, { title: '   ' })

    expect(result.ok).toBe(false)
    expect(result.ok === false && result.status).toBe(422)
  })

  test('the base cannot be retargeted onto the head', () => {
    const result = editPullRequest(subject, { base: 'feature/x' })

    expect(result.ok).toBe(false)
    expect(result.ok === false && result.status).toBe(422)
  })

  test('retargeting the base is otherwise allowed', () => {
    expect(editPullRequest(subject, { base: 'develop' })).toEqual({
      ok: true,
      changes: { base_branch: 'develop' },
    })
  })

  test('a merged pull request cannot be edited', () => {
    const result = editPullRequest({ state: 'merged', headBranch: 'feature/x' }, { title: 'New' })

    expect(result.ok).toBe(false)
    expect(result.ok === false && result.status).toBe(409)
  })
})

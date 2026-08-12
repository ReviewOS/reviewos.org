import { describe, expect, it } from 'bun:test'
import {
  pingPayload,
  subscribes,
  WEBHOOK_EVENTS,
  webhookPayload,
} from '../../app/Webhooks/payloads'

/**
 * This file is a contract test, not a unit test.
 *
 * People build against these shapes, so the assertions below are deliberately
 * about field *names* rather than behaviour. A test that reads as pedantic is
 * the point: renaming a field should fail here loudly, because the alternative
 * is finding out from somebody whose CI broke.
 */

const subject = {
  actorId: 7,
  actorHandle: 'chris',
  repositoryId: 3,
  owner: 'acme',
  repository: 'api',
  subjectType: 'pull_request' as const,
  subjectId: 42,
  number: 12,
  title: 'Make the thing faster',
}

const at = '2026-08-07T12:00:00.000Z'

describe('the envelope, which every payload shares', () => {
  const body = webhookPayload('pr:opened', subject, at)

  it('names the event and when it was built', () => {
    expect(body.event).toBe('pr:opened')
    expect(body.delivered_at).toBe(at)
  })

  it('carries the repository, with the field receivers route on', () => {
    expect(body.repository).toEqual({ full_name: 'acme/api', owner: 'acme', name: 'api', id: 3 })
  })

  it('carries who caused it', () => {
    expect(body.sender).toEqual({ handle: 'chris', id: 7 })
  })

  it('sender is null rather than absent when nothing caused it', () => {
    // A receiver that assumes a sender crashes on the day one is missing.
    // Present-and-null is checkable; absent is a surprise.
    const anonymous = webhookPayload('release:published', { ...subject, actorId: 0 } as any, at)

    expect(anonymous.sender).toBeNull()
  })
})

describe('the subject, which is the same shape for every event', () => {
  it('so a receiver can find the number without knowing nine field names', () => {
    const body = webhookPayload('pr:opened', subject, at)

    expect(body.subject).toEqual({
      type: 'pull_request',
      id: 42,
      number: 12,
      title: 'Make the thing faster',
      url: '/acme/api/pull/12',
    })
  })

  it('an issue points at the issue', () => {
    const body = webhookPayload('issue:opened', { ...subject, subjectType: 'issue' } as any, at)

    expect(body.subject.type).toBe('issue')
    expect(body.subject.url).toBe('/acme/api/issue/12')
  })

  it('a repository-level event has a null number and the repository URL', () => {
    const body = webhookPayload('release:published', {
      ...subject,
      subjectType: 'repository',
      number: undefined,
      detail: 'v1.2.0',
    } as any, at)

    expect(body.subject.number).toBeNull()
    expect(body.subject.url).toBe('/acme/api')
    expect(body.tag).toBe('v1.2.0')
  })

  it('the URL is a path, not a full one', () => {
    // The host is the receiver's to know, and a stored absolute URL is one that
    // is wrong the day somebody puts the forge behind a different name.
    expect(webhookPayload('pr:merged', subject, at).subject.url.startsWith('/')).toBe(true)
  })
})

describe('action, so a receiver switches on one field', () => {
  it('is set for every event this product sends', () => {
    for (const event of WEBHOOK_EVENTS) {
      const body = webhookPayload(event, subject, at)

      expect(body.action).toBeTruthy()
      expect(body.action).not.toBe(event)
    }
  })

  it('distinguishes the two things that can happen to a pull request', () => {
    expect(webhookPayload('pr:merged', subject, at).action).toBe('merged')
    expect(webhookPayload('pr:closed', subject, at).action).toBe('closed')
  })
})

describe('what a check reported', () => {
  const check = {
    name: 'ci/build',
    sha: 'a'.repeat(40),
    status: 'completed',
    conclusion: 'failure',
    attempt: 2,
    details_url: 'https://ci.example.com/runs/9',
    summary: 'two tests failed',
  }

  const reported = { ...subject, subjectType: 'repository' as const, check }

  it('travels under its own key, with the fields a gate needs', () => {
    const body: any = webhookPayload('check:reported', reported, at)

    expect(body.check.name).toBe('ci/build')
    expect(body.check.sha).toBe('a'.repeat(40))
    expect(body.check.status).toBe('completed')
    expect(body.check.conclusion).toBe('failure')
    expect(body.check.attempt).toBe(2)
    expect(body.check.details_url).toBe('https://ci.example.com/runs/9')
  })

  /*
   * The transition is the field. A receiver waiting for a build to finish
   * subscribes once and switches on `action`; flattening `queued`,
   * `in_progress` and `completed` into one word would leave it re-reading the
   * check on every hop to find out whether anything had happened.
   */
  it('puts the transition in action, not a single flattened word', () => {
    expect(webhookPayload('check:reported', reported, at).action).toBe('completed')

    expect(webhookPayload('check:reported', {
      ...reported,
      check: { ...check, status: 'in_progress', conclusion: null },
    }, at).action).toBe('in_progress')
  })

  it('and the subject stays the repository, so nothing routing on it breaks', () => {
    // A check is about a commit, and the commit is in `check.sha`. Stretching
    // `subject.type` to a fourth value would break every receiver that switches
    // on it today.
    const body = webhookPayload('check:reported', reported, at)

    expect(body.subject.type).toBe('repository')
    expect(body.subject.url).toBe('/acme/api')
  })

  it('is absent from every event that is not one', () => {
    expect((webhookPayload('pr:merged', subject, at) as any).check).toBeUndefined()
  })
})

describe('the ping', () => {
  it('is the same envelope, so handling the envelope handles it for free', () => {
    const body = pingPayload({ id: 3, owner: 'acme', name: 'api' }, { handle: 'chris', id: 7 }, at)

    expect(body.event).toBe('ping')
    expect(body.repository.full_name).toBe('acme/api')
    expect(body.sender).toEqual({ handle: 'chris', id: 7 })
  })

  it('carries something to log, because an empty body reads as a failure', () => {
    expect(pingPayload({ id: 3, owner: 'acme', name: 'api' }, null, at).zen).toBeTruthy()
  })
})

describe('who gets which event', () => {
  it('a star means everything', () => {
    expect(subscribes('*', 'pr:opened')).toBe(true)
  })

  it('a list means that list', () => {
    expect(subscribes('pr:opened,pr:merged', 'pr:merged')).toBe(true)
    expect(subscribes('pr:opened,pr:merged', 'issue:opened')).toBe(false)
  })

  it('an empty list means nothing, not everything', () => {
    // A webhook created with no events selected should be silent, not a
    // firehose. This is the default that is dangerous to get backwards.
    expect(subscribes('', 'pr:opened')).toBe(false)
  })

  it('tolerates the spacing people actually type', () => {
    expect(subscribes(' pr:opened , pr:merged ', 'pr:merged')).toBe(true)
  })

  it('does not match on a substring', () => {
    // Filtering in SQL with LIKE would match here, which is why it is not done
    // in SQL: a repository named after an event would subscribe itself.
    expect(subscribes('pr:opened', 'pr:open')).toBe(false)
  })
})

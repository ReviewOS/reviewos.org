/**
 * What each event says, and where it points.
 *
 * The sentence is the product here. "somebody reviewed your pull request" makes
 * the reader open it to find out whether they are blocked, which is the work
 * the notification was supposed to save them - so the tests are mostly about
 * whether the line carries its own answer.
 */

import type { EventSubject } from '../../app/Notifications/definitions'
import { describe as group, expect, test } from 'bun:test'
import { describe, reasonsFor, urlFor } from '../../app/Notifications/definitions'

function subject(overrides: Partial<EventSubject> = {}): EventSubject {
  return {
    actorId: 1,
    actorHandle: 'alice',
    repositoryId: 10,
    owner: 'acme',
    repository: 'forge',
    subjectType: 'pull_request',
    subjectId: 55,
    number: 12,
    title: 'Make the diff stream',
    ...overrides,
  }
}

group('describe', () => {
  test('names the person, the place and the thing', () => {
    expect(describe('pr:opened', subject())?.title)
      .toBe('alice opened acme/forge#12: Make the diff stream')
  })

  /**
   * The verdict is the whole point of a review notification. Without it the
   * reader has to open the pull request to find out whether they are blocked,
   * which is exactly the trip the notification exists to save.
   */
  test('a review carries its verdict', () => {
    expect(describe('review:submitted', subject({ detail: 'requested changes on' }))?.title)
      .toBe('alice requested changes on acme/forge#12')
  })

  test('a review with no verdict still reads as a sentence', () => {
    expect(describe('review:submitted', subject())?.title).toBe('alice reviewed acme/forge#12')
  })

  test('a review request is addressed to the reader, not narrated at them', () => {
    expect(describe('review:requested', subject())?.title)
      .toBe('alice asked you to review acme/forge#12')
  })

  test('a close says it did not merge, because that is the part people check', () => {
    expect(describe('pr:closed', subject())?.title).toContain('without merging')
  })

  test('a release names the tag rather than "a release"', () => {
    const notification = describe('release:published', subject({
      subjectType: 'repository',
      number: undefined,
      detail: 'v2.1.0',
    }))

    expect(notification?.title).toBe('alice published v2.1.0 in acme/forge')
  })

  test('an unknown event produces nothing rather than a blank row', () => {
    expect(describe('nonsense' as any, subject())).toBeNull()
  })

  test('a subject with no number reads as the repository', () => {
    expect(describe('issue:opened', subject({ subjectType: 'issue', number: undefined, title: 'x' }))?.title)
      .toBe('alice opened acme/forge: x')
  })
})

group('urlFor', () => {
  /**
   * A pull request notification lands on the review screen rather than the
   * conversation: somebody told about a review request is going there next, and
   * a click that needs a second click is a click that gets postponed.
   */
  test('a pull request points at the files, which is where the reader is going', () => {
    expect(urlFor(subject())).toBe('/acme/forge/pull/12/files')
  })

  test('an issue points at the issue', () => {
    expect(urlFor(subject({ subjectType: 'issue', number: 7 }))).toBe('/acme/forge/issue/7')
  })

  test('a repository-level subject points at the repository', () => {
    expect(urlFor(subject({ subjectType: 'repository', number: undefined }))).toBe('/acme/forge')
  })

  test('a pull request with no number falls back rather than building a broken link', () => {
    expect(urlFor(subject({ number: undefined }))).toBe('/acme/forge')
  })
})

group('reasonsFor', () => {
  /**
   * A review request is addressed at a person rather than broadcast to a
   * thread, so it has to reach them whether or not they were watching. Every
   * other event respects why somebody is subscribed.
   */
  test('a review request reaches its reviewer however they are subscribed', () => {
    expect(reasonsFor('review:requested')).toBe('all')
  })

  /**
   * Somebody watching a repository wants to know a pull request opened. They do
   * not want every comment on it, and a forge that sends both is a forge people
   * mute.
   */
  test('a comment reaches the conversation, not everybody watching the repository', () => {
    const reasons = reasonsFor('comment:created')

    expect(reasons).not.toBe('all')
    expect(reasons).toContain('participating')
    expect(reasons).not.toContain('watching')
  })

  test('an opened pull request does reach the watchers', () => {
    expect(reasonsFor('pr:opened')).toContain('watching')
  })
})

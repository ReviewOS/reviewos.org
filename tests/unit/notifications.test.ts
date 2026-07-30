// Who gets notified, why, and how much.
//
// The failure modes here are social rather than technical: notifying someone
// about their own comment, telling a requested reviewer they are "watching",
// or sending ten emails for one conversation. Each of those teaches people to
// ignore notifications, which is the same as not having them.

import { describe, expect, test } from 'bun:test'
import {
  batchNotifications,
  REASONS,
  reasonText,
  resolveRecipients,
  subscribesActor,
} from '../../app/Actions/Notification/recipients'

describe('resolveRecipients', () => {
  test('notifies a candidate', () => {
    const result = resolveRecipients({ candidates: [{ userId: 2, reason: 'watching' }], actorId: 1 })

    expect(result).toEqual([{ userId: 2, reason: 'watching' }])
  })

  test('never notifies the person who did it', () => {
    const result = resolveRecipients({
      candidates: [{ userId: 1, reason: 'author' }, { userId: 2, reason: 'watching' }],
      actorId: 1,
    })

    expect(result.map(r => r.userId)).toEqual([2])
  })

  test('notifies once, under the strongest reason', () => {
    const result = resolveRecipients({
      candidates: [
        { userId: 2, reason: 'watching' },
        { userId: 2, reason: 'review_requested' },
        { userId: 2, reason: 'participating' },
      ],
      actorId: 1,
    })

    expect(result).toEqual([{ userId: 2, reason: 'review_requested' }])
  })

  test('a review request outranks watching however they are ordered', () => {
    const forward = resolveRecipients({
      candidates: [{ userId: 2, reason: 'review_requested' }, { userId: 2, reason: 'watching' }],
      actorId: 1,
    })

    expect(forward[0]!.reason).toBe('review_requested')
  })

  test('being mentioned outranks being the author', () => {
    const result = resolveRecipients({
      candidates: [{ userId: 2, reason: 'author' }, { userId: 2, reason: 'mentioned' }],
      actorId: 1,
    })

    expect(result[0]!.reason).toBe('mentioned')
  })

  test('a muted reason is skipped', () => {
    const result = resolveRecipients({
      candidates: [{ userId: 2, reason: 'watching' }],
      actorId: 1,
      preferences: [{ userId: 2, muted: ['watching'] }],
    })

    expect(result).toEqual([])
  })

  test('muting one reason leaves a stronger one working', () => {
    // Muting "watching" must not cost someone their review requests.
    const result = resolveRecipients({
      candidates: [{ userId: 2, reason: 'watching' }, { userId: 2, reason: 'review_requested' }],
      actorId: 1,
      preferences: [{ userId: 2, muted: ['watching'] }],
    })

    expect(result).toEqual([{ userId: 2, reason: 'review_requested' }])
  })

  test('unsubscribing from a thread beats every reason', () => {
    const result = resolveRecipients({
      candidates: [{ userId: 2, reason: 'review_requested' }, { userId: 2, reason: 'mentioned' }],
      actorId: 1,
      preferences: [{ userId: 2, unsubscribed: true }],
    })

    expect(result).toEqual([])
  })

  test('orders the strongest reasons first', () => {
    const result = resolveRecipients({
      candidates: [
        { userId: 4, reason: 'watching' },
        { userId: 3, reason: 'mentioned' },
        { userId: 2, reason: 'review_requested' },
      ],
      actorId: 1,
    })

    expect(result.map(r => r.userId)).toEqual([2, 3, 4])
  })

  test('nobody to notify is not an error', () => {
    expect(resolveRecipients({ candidates: [], actorId: 1 })).toEqual([])
  })
})

describe('subscribesActor', () => {
  test('doing something subscribes you to what follows', () => {
    expect(subscribesActor('issue:opened')).toBe(true)
    expect(subscribesActor('comment:created')).toBe(true)
    expect(subscribesActor('review:submitted')).toBe(true)
  })

  test('reading or reacting does not', () => {
    expect(subscribesActor('issue:viewed')).toBe(false)
    expect(subscribesActor('reaction:added')).toBe(false)
  })
})

describe('batchNotifications', () => {
  const minute = 60_000

  test('collapses a burst into one delivery', () => {
    const pending = [0, 1, 2, 3].map(n => ({
      userId: 2,
      event: 'comment:created',
      subjectKey: 'pr:7',
      at: n * minute,
    }))

    const batches = batchNotifications(pending, 5 * minute)

    expect(batches).toHaveLength(1)
    expect(batches[0]!.events).toHaveLength(4)
  })

  test('a gap longer than the window starts a new delivery', () => {
    const pending = [
      { userId: 2, event: 'comment:created', subjectKey: 'pr:7', at: 0 },
      { userId: 2, event: 'comment:created', subjectKey: 'pr:7', at: 60 * minute },
    ]

    expect(batchNotifications(pending, 5 * minute)).toHaveLength(2)
  })

  test('a running conversation does not become one message at the end of the day', () => {
    // Each comment is inside the window of the one before it, but the batch
    // still closes when the gap does open.
    const pending = [0, 4, 8, 40].map(n => ({
      userId: 2,
      event: 'comment:created',
      subjectKey: 'pr:7',
      at: n * minute,
    }))

    const batches = batchNotifications(pending, 5 * minute)

    expect(batches).toHaveLength(2)
    expect(batches[0]!.events).toHaveLength(3)
  })

  test('different subjects are never merged', () => {
    const pending = [
      { userId: 2, event: 'comment:created', subjectKey: 'pr:7', at: 0 },
      { userId: 2, event: 'comment:created', subjectKey: 'issue:3', at: minute },
    ]

    expect(batchNotifications(pending, 5 * minute)).toHaveLength(2)
  })

  test('different people are never merged', () => {
    const pending = [
      { userId: 2, event: 'comment:created', subjectKey: 'pr:7', at: 0 },
      { userId: 3, event: 'comment:created', subjectKey: 'pr:7', at: minute },
    ]

    expect(batchNotifications(pending, 5 * minute)).toHaveLength(2)
  })

  test('records the span the batch covers', () => {
    const pending = [
      { userId: 2, event: 'a', subjectKey: 'pr:7', at: 1000 },
      { userId: 2, event: 'b', subjectKey: 'pr:7', at: 4000 },
    ]
    const [batch] = batchNotifications(pending, 5 * minute)

    expect(batch!.from).toBe(1000)
    expect(batch!.to).toBe(4000)
  })

  test('handles events arriving out of order', () => {
    const pending = [
      { userId: 2, event: 'b', subjectKey: 'pr:7', at: 4000 },
      { userId: 2, event: 'a', subjectKey: 'pr:7', at: 1000 },
    ]
    const [batch] = batchNotifications(pending, 5 * minute)

    expect(batch!.events).toEqual(['a', 'b'])
  })

  test('nothing pending is nothing to send', () => {
    expect(batchNotifications([], minute)).toEqual([])
  })
})

describe('reasonText', () => {
  test('every reason has text a person would recognise', () => {
    for (const reason of REASONS) {
      expect(reasonText(reason).length).toBeGreaterThan(0)
      expect(reasonText(reason)).not.toContain('_')
    }
  })

  test('a review request says so', () => {
    expect(reasonText('review_requested')).toContain('review')
  })
})

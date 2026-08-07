import { describe, expect, it } from 'bun:test'
import {
  defaultDelivery,
  deliveryPreference,
  isDelivery,
  PREFERENCE_CHANNELS,
  PREFERENCE_EVENTS,
  preferenceGrid,
} from '../../app/Actions/Notification/preferences'

describe('the shipped defaults', () => {
  it('the inbox is always immediate', () => {
    // It is the channel that has to work when the others do not, and a digest
    // of it would be a page somebody has to wait for.
    for (const event of PREFERENCE_EVENTS)
      expect(defaultDelivery(event, 'in_app')).toBe('immediate')
  })

  it('push is off until somebody asks for it', () => {
    // A push nobody asked for is an interruption. The channel is worth having
    // precisely because it is opt-in and therefore trusted.
    for (const event of PREFERENCE_EVENTS)
      expect(defaultDelivery(event, 'push')).toBe('off')
  })

  it('email is immediate for what is addressed to you', () => {
    // A review request that waits four hours in a digest is four hours of
    // somebody else's day.
    expect(defaultDelivery('review:requested', 'email')).toBe('immediate')
    expect(defaultDelivery('review:submitted', 'email')).toBe('immediate')
  })

  it('email digests what you merely watch', () => {
    // Otherwise watching a busy repository is indistinguishable from
    // subscribing to a mailing list, which is what people mute.
    expect(defaultDelivery('comment:created', 'email')).toBe('digest')
    expect(defaultDelivery('release:published', 'email')).toBe('digest')
    expect(defaultDelivery('pr:opened', 'email')).toBe('digest')
  })

  it('every event and channel has an answer', () => {
    for (const event of PREFERENCE_EVENTS) {
      for (const channel of PREFERENCE_CHANNELS)
        expect(isDelivery(defaultDelivery(event, channel))).toBe(true)
    }
  })
})

describe('a stored preference', () => {
  it('wins over the default', () => {
    const stored = [{ event: 'comment:created', channel: 'email', delivery: 'immediate' }]

    expect(deliveryPreference('comment:created', 'email', stored)).toBe('immediate')
  })

  it('applies only to the event and channel it names', () => {
    const stored = [{ event: 'comment:created', channel: 'email', delivery: 'off' }]

    expect(deliveryPreference('comment:created', 'push', stored)).toBe('off')
    expect(deliveryPreference('review:requested', 'email', stored)).toBe('immediate')
  })

  it('cannot silence the inbox', () => {
    const stored = [{ event: 'pr:merged', channel: 'in_app', delivery: 'off' }]

    expect(deliveryPreference('pr:merged', 'in_app', stored)).toBe('immediate')
  })

  it('a value nobody recognises falls back to the default, not to silence', () => {
    // Wrong-but-talking costs somebody a notification they did not want.
    // Wrong-and-silent costs them a review they never heard about.
    const stored = [{ event: 'review:requested', channel: 'email', delivery: 'weekly' }]

    expect(deliveryPreference('review:requested', 'email', stored)).toBe('immediate')
  })

  it('an empty table is every default', () => {
    expect(deliveryPreference('comment:created', 'email', [])).toBe('digest')
  })
})

describe('the settings grid', () => {
  const grid = preferenceGrid([{ event: 'comment:created', channel: 'email', delivery: 'off' }])

  it('answers every cell, including the ones nobody has a row for', () => {
    // A settings screen that renders unset as "off" is how somebody turns
    // something on that was already on and concludes the switches do nothing.
    expect(grid).toHaveLength(PREFERENCE_EVENTS.length * PREFERENCE_CHANNELS.length)
    expect(grid.every(cell => isDelivery(cell.delivery))).toBe(true)
  })

  it('says which cells are a choice and which are the shipped default', () => {
    const chosen = grid.find(cell => cell.event === 'comment:created' && cell.channel === 'email')
    const untouched = grid.find(cell => cell.event === 'pr:merged' && cell.channel === 'email')

    expect(chosen?.isDefault).toBe(false)
    expect(untouched?.isDefault).toBe(true)
  })

  it('marks the inbox column as fixed', () => {
    expect(grid.filter(cell => cell.channel === 'in_app').every(cell => !cell.editable)).toBe(true)
    expect(grid.filter(cell => cell.channel !== 'in_app').every(cell => cell.editable)).toBe(true)
  })

  it('an in_app row stored somehow is still reported as a default', () => {
    // The column allows the value so one shape serves all three channels. The
    // grid must not show it as somebody's choice when it has no effect.
    const forced = preferenceGrid([{ event: 'pr:merged', channel: 'in_app', delivery: 'off' }])
    const cell = forced.find(entry => entry.event === 'pr:merged' && entry.channel === 'in_app')

    expect(cell?.delivery).toBe('immediate')
    expect(cell?.isDefault).toBe(true)
  })
})

describe('the event list', () => {
  it('matches what the product actually emits', async () => {
    // A preference for an event nobody emits is a switch that does nothing, and
    // an event with no preference is one nobody can turn off.
    const definitions = await Bun.file('app/Notifications/definitions.ts').text()

    for (const event of PREFERENCE_EVENTS)
      expect(definitions).toContain(`'${event}'`)
  })
})

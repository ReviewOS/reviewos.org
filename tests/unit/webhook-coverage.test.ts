/**
 * Every event a program needs has a webhook.
 *
 * This is a coverage test in the same spirit as the OpenAPI one: it does not
 * check that a payload is right, only that an event a client depends on is not
 * silently absent. The failure it exists for is quiet - nothing errors, the
 * webhook simply never arrives, and the client's author concludes the thing
 * never happens.
 *
 * The list below is the claim, written down. Adding to it is how a future
 * event gets remembered; removing from it is a decision somebody has to make
 * deliberately, in a diff.
 */

import { describe, expect, it } from 'bun:test'
import registry from '../../app/Events'
import listener from '../../app/Listeners/DispatchWebhooks'
import webhookModel from '../../app/Models/Webhook'
import { subscribes, WEBHOOK_EVENTS } from '../../app/Webhooks/payloads'

/**
 * What a program has to be told about, and why a person is not enough.
 *
 * The reasons matter more than the names: each one is a question an agent has
 * that a colleague watching a page does not.
 */
const REQUIRED = [
  { event: 'pr:opened', because: 'there is something new to look at' },
  { event: 'pr:synchronized', because: 'the head moved, so a review already written may be stale' },
  { event: 'pr:ready_for_review', because: 'a draft became ready, and nothing else about it changed' },
  { event: 'pr:merged', because: 'the work landed' },
  { event: 'pr:closed', because: 'the work will not land, and anything queued against it should stop' },
  { event: 'review:requested', because: 'somebody is waiting on this agent specifically' },
  { event: 'review:submitted', because: 'a verdict arrived on something the agent opened' },
  { event: 'issue:opened', because: 'there is something new to triage' },
  { event: 'issue:closed', because: 'work queued against it should stop' },
  { event: 'comment:created', because: 'somebody replied, possibly to the agent' },
]

describe('the events a program can subscribe to', () => {
  it('covers everything an agent needs to stay current', () => {
    /*
     * Reported as a list of names with reasons rather than a count. "3 events
     * are missing" sends somebody to diff two sets by hand; the names and the
     * reasons send them to the place the event should be emitted.
     */
    const missing = REQUIRED
      .filter(entry => !(WEBHOOK_EVENTS as readonly string[]).includes(entry.event))
      .map(entry => `${entry.event} (${entry.because})`)

    expect(missing).toEqual([])
  })

  it('has the head-moved event, which is the one that was absent', () => {
    /*
     * Called out on its own because it is the whole reason this file exists. An
     * agent that reviewed a change and hears nothing when the author pushes a
     * fix has two options and both are bad: poll every open pull request
     * forever, or never look again.
     */
    expect(WEBHOOK_EVENTS as readonly string[]).toContain('pr:synchronized')
  })
})

describe('an event that is advertised is actually dispatched', () => {
  it('every webhook event has a listener registration', () => {
    /*
     * The gap this catches: a name added to `WEBHOOK_EVENTS` makes the create
     * endpoint accept a subscription to it, and a receiver that subscribes then
     * waits forever for something nothing dispatches. An advertised event that
     * never fires is worse than an absent one - the client has no way to tell.
     */
    const listened = new Set(listener.listensTo as readonly string[])

    const advertised = (WEBHOOK_EVENTS as readonly string[]).filter(event => !listened.has(event))

    expect(advertised).toEqual([])
  })

  it('and is routed to the webhook listener by the event registry', () => {
    const routed = Object.entries(registry as Record<string, readonly string[]>)
      .filter(([, listeners]) => listeners.includes('DispatchWebhooks'))
      .map(([event]) => event)

    const orphaned = (WEBHOOK_EVENTS as readonly string[]).filter(event => !routed.includes(event))

    expect(orphaned).toEqual([])
  })
})

describe('subscribing', () => {
  it('a wildcard takes the new events too', () => {
    // A receiver registered before `pr:synchronized` existed and asking for
    // everything should get it, rather than having to re-register for each
    // event added after it was set up.
    expect(subscribes('*', 'pr:synchronized')).toBe(true)
  })

  it('and a named list takes only what it named', () => {
    expect(subscribes('pr:opened', 'pr:synchronized')).toBe(false)
    expect(subscribes('pr:opened,pr:synchronized', 'pr:synchronized')).toBe(true)
  })

  it('reads the format the column actually stores', () => {
    /*
     * Written after finding that it did not. The model declared this column as
     * a JSON array and defaulted it to `["*"]`; `subscribes` splits on commas,
     * so a webhook created with the column default matched nothing and was
     * silent forever. Only rows written through the endpoint - which stores the
     * comma form - ever worked, which is exactly why nobody noticed.
     *
     * Asserted against the model's own default rather than a literal, so the
     * two cannot drift apart again.
     */
    const declared = String((webhookModel as any).attributes.events.default)

    expect(subscribes(declared, 'pr:opened')).toBe(true)
    expect(subscribes(String((webhookModel as any).attributes.events.factory()), 'pr:opened')).toBe(true)
  })
})

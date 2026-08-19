// A run holding still for a clock, or for the world.
//
// `block:` waits for a person with an account here. This waits for whatever
// sends the event, which is the primitive underneath approvals, webhooks and
// every other human-in-the-loop gate - and the one thing it must never do is
// wait for nothing, because a job nobody can end holds a pull request's checks
// open forever.

import { describe, expect, test } from 'bun:test'
import { parseWorkflow, secondsFrom } from '../../app/Actions/Workflow/parse'
import { waitPlan, waitSettingsOf } from '../../app/Actions/Workflow/awaits'

function jobs(source: string): any[] {
  const result = parseWorkflow(`name: X\non: push\n${source}`, '.github/workflows/x.yml')

  if (result.errors.length > 0)
    throw new Error(result.errors.map(error => error.message).join('; '))

  return result.workflow!.jobs
}

function errorsIn(source: string): string[] {
  return parseWorkflow(`name: X\non: push\n${source}`, '.github/workflows/x.yml')
    .errors
    .map(error => `${error.message} ${error.fix ?? ''}`)
}

describe('a length of time', () => {
  test('is written the way people write it', () => {
    expect(secondsFrom('30s')).toBe(30)
    expect(secondsFrom('10m')).toBe(600)
    expect(secondsFrom('2h')).toBe(7200)
    expect(secondsFrom('1d')).toBe(86_400)
    // A bare number is seconds, which is what a bare number means everywhere
    // else in this file format.
    expect(secondsFrom(45)).toBe(45)
    expect(secondsFrom('45')).toBe(45)
  })

  test('and anything else is not one, rather than being guessed at', () => {
    expect(secondsFrom('soon')).toBeNull()
    expect(secondsFrom('10 minutes')).toBeNull()
    expect(secondsFrom('')).toBeNull()
    // Negative is not a duration. A wait that ends before it starts is a
    // typo, and treating it as zero would run the job somebody meant to delay.
    expect(secondsFrom(-5)).toBeNull()
  })
})

describe('a wait for a clock', () => {
  test('the short form is a duration', () => {
    const [job] = jobs(`jobs:
  soak:
    reviewos:
      await: 30m
`)

    expect(job!.kind).toBe('await')
    expect(job!.settings).toEqual({ sleepSeconds: 1800 })
  })

  test('and an instant is the other way to say when', () => {
    const [job] = jobs(`jobs:
  release:
    reviewos:
      await:
        until: '2026-08-20T10:00:00Z'
`)

    expect((job!.settings as any).until).toBe('2026-08-20T10:00:00Z')
  })

  test('a time nobody can read is refused rather than waited through', () => {
    expect(errorsIn(`jobs:
  release:
    reviewos:
      await:
        until: next tuesday
`).join(' ')).toContain('is not a time')
  })
})

describe('a wait for an event', () => {
  test('names the event and how long it will wait', () => {
    const [job] = jobs(`jobs:
  approval:
    reviewos:
      await:
        event: deploy-approved
        timeout: 1h
`)

    expect(job!.settings).toEqual({ event: 'deploy-approved', timeoutSeconds: 3600, onTimeout: 'fail' })
  })

  /**
   * Failing is the default rather than the choice: a run that goes green on
   * "nobody replied" is a green check for a deployment nobody approved.
   */
  test('and what a timeout means is stated, with failing as the default', () => {
    const [strict] = jobs(`jobs:
  approval:
    reviewos:
      await:
        event: ok
        timeout: 5m
`)

    const [lenient] = jobs(`jobs:
  approval:
    reviewos:
      await:
        event: ok
        timeout: 5m
        on-timeout: continue
`)

    expect((strict!.settings as any).onTimeout).toBe('fail')
    expect((lenient!.settings as any).onTimeout).toBe('continue')
  })

  test('a wait with no timeout waits until it is told, which is allowed', () => {
    const [job] = jobs(`jobs:
  approval:
    reviewos:
      await:
        event: deploy-approved
`)

    expect((job!.settings as any).timeoutSeconds).toBeUndefined()
  })
})

describe('what the file may not say', () => {
  test('a wait for nothing, which nothing would ever end', () => {
    /*
     * The failure this refusal prevents appears days later on somebody else's
     * screen: a job nobody can end holds a pull request's checks open forever,
     * and by then the workflow file is three commits old.
     */
    expect(errorsIn(`jobs:
  stuck:
    reviewos:
      await:
        on-timeout: continue
`).join(' ')).toContain('waits for nothing')
  })

  test('a timeout on a wait that already ends by itself', () => {
    // Two clocks for one wait, and the shorter one wins in a way nobody
    // reading the file would predict.
    expect(errorsIn(`jobs:
  soak:
    reviewos:
      await:
        sleep: 10m
        timeout: 5m
`).join(' ')).toContain('waits for no event')
  })

  test('a wait that also has steps', () => {
    expect(errorsIn(`jobs:
  soak:
    reviewos:
      await: 5m
    steps:
      - run: make
`).join(' ')).toContain('runs no commands')
  })

  test('and a wait that is also a gate', () => {
    expect(errorsIn(`jobs:
  both:
    reviewos:
      await: 5m
      block: Ship it?
`).join(' ')).toContain('at once')
  })
})

describe('when to look at a wait again', () => {
  const now = new Date('2026-08-19T12:00:00.000Z')

  test('a sleep ends at its own end', () => {
    const plan = waitPlan(JSON.stringify({ sleepSeconds: 600 }), now)

    expect(plan.wakeAt).toBe('2026-08-19T12:10:00.000Z')
    expect(plan.reason).toContain('12:10:00')
  })

  test('an instant is the instant, whenever the run reached it', () => {
    const plan = waitPlan(JSON.stringify({ until: '2026-08-20T10:00:00Z' }), now)

    expect(plan.wakeAt).toBe('2026-08-20T10:00:00.000Z')
  })

  test('a wait for an event wakes at its deadline, and says what it is waiting for', () => {
    const plan = waitPlan(JSON.stringify({ event: 'deploy-approved', timeoutSeconds: 3600 }), now)

    expect(plan.wakeAt).toBe('2026-08-19T13:00:00.000Z')
    expect(plan.reason).toContain('deploy-approved')
  })

  /**
   * Null is the honest answer, and the sweep's query is `wake_at <= now` - so a
   * wait with no deadline is one the sweep never picks up, which is exactly
   * what "waits until it is told" means.
   */
  test('and a wait with no timeout has no deadline at all', () => {
    expect(waitPlan(JSON.stringify({ event: 'ok' }), now).wakeAt).toBeNull()
  })

  test('settings nobody can read do not become a wait of unknown length', () => {
    // A row this cannot parse is a row a sweep must still be able to end, so
    // the defaults are a minute rather than forever.
    expect(waitSettingsOf('not json').event).toBe('')
    expect(waitPlan('not json', now).wakeAt).toBe('2026-08-19T12:01:00.000Z')
  })
})

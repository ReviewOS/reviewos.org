// Deciding whether a sign-in is from somewhere new.
//
// The whole feature turns on this judgement, and it fails in two directions
// that are not symmetric. Missing a real one costs somebody the only warning
// they get between a password leaking and the damage being visible. Firing on
// their own laptop every fortnight costs them the habit of reading it - and
// then they miss the real one anyway, plus they have been annoyed all year.
//
// So the comparison is deliberately coarse on the browser and exact on the
// address, and these pin why.

import { describe, expect, test } from 'bun:test'
import { describeSignIn } from '../../app/Actions/Auth/newDevice'
import { describeAgent } from '../../app/Actions/Auth/sessions'

const CHROME_120 = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
const CHROME_121 = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36'
const SAFARI_IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Mobile/15E148 Safari/604.1'

describe('what counts as the same device', () => {
  test('a browser update is not a new device', () => {
    /*
     * The single most important line here. Chrome ships a major version every
     * four weeks and the number is in the string, so a raw comparison makes
     * every update look like somebody else signing in - and a warning that
     * fires monthly is one people learn to dismiss, which is worse than no
     * warning because they dismiss the real one too.
     */
    expect(describeAgent(CHROME_120)).toBe(describeAgent(CHROME_121))
  })

  test('a different browser on the same machine is a different device', () => {
    // Coarse is not blind. Somebody signing in with Safari when this account
    // has only ever used Chrome is worth one line in an inbox.
    expect(describeAgent(CHROME_120)).not.toBe(describeAgent(SAFARI_IPHONE))
  })

  test('an unknown client does not collapse into every other unknown one', () => {
    // `curl` and `git` are the sessions somebody is scanning for, so they have
    // to stay distinguishable from each other and from a browser.
    expect(describeAgent('curl/8.4.0')).not.toBe(describeAgent('git/2.43.0'))
    expect(describeAgent('curl/8.4.0')).not.toBe(describeAgent(CHROME_120))
  })
})

describe('what the person reads', () => {
  test('says the device, the address and the time', () => {
    const line = describeSignIn(
      { userId: 1, userAgent: CHROME_120, ipAddress: '203.0.113.7' },
      new Date('2026-03-04T09:15:00.000Z'),
    )

    expect(line).toBe('New sign-in: Chrome on macOS from 203.0.113.7 at 2026-03-04 09:15 UTC')
  })

  test('does not call it suspicious', () => {
    /*
     * Most of these are the person themselves on a new laptop. Language that
     * starts by alarming them is language they stop reading, and the one that
     * matters arrives in the same envelope as the eleven that did not.
     */
    const line = describeSignIn(
      { userId: 1, userAgent: CHROME_120, ipAddress: '203.0.113.7' },
      new Date('2026-03-04T09:15:00.000Z'),
    )

    expect(/suspicious|unrecognised|unauthorized|warning/i.test(line)).toBe(false)
  })

  test('reads sensibly when there is no address to name', () => {
    // A direct connection with no proxy header, which is the ordinary
    // single-host deployment. The sentence still has to be a sentence.
    const line = describeSignIn(
      { userId: 1, userAgent: SAFARI_IPHONE, ipAddress: null },
      new Date('2026-03-04T09:15:00.000Z'),
    )

    expect(line).toBe('New sign-in: Safari on iPhone at 2026-03-04 09:15 UTC')
  })

  test('and when the client said nothing about itself', () => {
    const line = describeSignIn(
      { userId: 1, userAgent: null, ipAddress: '10.0.0.4' },
      new Date('2026-03-04T09:15:00.000Z'),
    )

    expect(line).toBe('New sign-in: Unknown device from 10.0.0.4 at 2026-03-04 09:15 UTC')
  })
})

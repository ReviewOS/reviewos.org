/**
 * What the star and watch controls say.
 *
 * Both endpoints have had a table, a model and a unique index since phase 1 and
 * no control anywhere in the interface, so this is the first time any of it is
 * drawn. What is tested is the part that is a rule rather than markup: the
 * label, the tint, and the redirect the form carries - which is a URL an
 * authenticated POST will follow, and so is a security question rather than a
 * cosmetic one.
 */

import { describe, expect, it } from 'bun:test'
import {
  abbreviateCount,
  repositoryActions,
  starButton,
  watchLabel,
  WATCH_CHOICES,
} from '../../app/Actions/Repo/standing'

function standing(over: Record<string, unknown> = {}): any {
  return { stars: 0, starred: false, watchers: 0, subscription: null, forks: 0, ...over }
}

describe('abbreviateCount', () => {
  it('shows a small number as itself', () => {
    expect(abbreviateCount(0)).toBe('0')
    expect(abbreviateCount(1)).toBe('1')
    expect(abbreviateCount(999)).toBe('999')
  })

  it('abbreviates thousands, with a decimal only where it says something', () => {
    expect(abbreviateCount(1000)).toBe('1k')
    expect(abbreviateCount(1247)).toBe('1.2k')
    expect(abbreviateCount(9400)).toBe('9.4k')
    // Above ten thousand the decimal is noise on a number nobody is checking.
    expect(abbreviateCount(94300)).toBe('94k')
  })

  it('abbreviates millions', () => {
    expect(abbreviateCount(1_500_000)).toBe('1.5m')
  })

  it('never shows a negative or a fraction', () => {
    expect(abbreviateCount(-5)).toBe('0')
    expect(abbreviateCount(3.7)).toBe('3')
    expect(abbreviateCount(Number.NaN)).toBe('0')
  })
})

describe('starButton', () => {
  it('says Star, and says Starred once it has been pressed', () => {
    expect(starButton(standing()).label).toBe('Star')
    expect(starButton(standing({ starred: true })).label).toBe('Starred')
  })

  it('reports pressed, so the control can say so rather than only look it', () => {
    expect(starButton(standing({ starred: true })).pressed).toBe(true)
    expect(starButton(standing()).pressed).toBe(false)
  })

  it('shows the count even at zero', () => {
    // A control that changes shape as it is used is harder to hit twice.
    expect(starButton(standing()).count).toBe('0')
    expect(starButton(standing({ stars: 623 })).count).toBe('623')
  })
})

describe('watchLabel', () => {
  it('names each of the four answers distinctly', () => {
    expect(watchLabel(null)).toBe('Watch')
    expect(watchLabel('all')).toBe('Watching')
    expect(watchLabel('participating')).toBe('Participating')
    expect(watchLabel('ignore')).toBe('Ignoring')
  })
})

describe('repositoryActions', () => {
  const options = { owner: 'stacks', repository: 'stacks', signedIn: true }

  it('comes back to the repository when there is no path', () => {
    expect(repositoryActions(standing(), options).next).toBe('/stacks/stacks')
  })

  it('comes back to the file the reader was standing on', () => {
    // The whole point of the button being usable from three directories down.
    const actions = repositoryActions(standing(), { ...options, path: 'tree/main/src/parser.ts' })

    expect(actions.next).toBe('/stacks/stacks/tree/main/src/parser.ts')
  })

  it('builds `next` from the page rather than from anything a caller sent', () => {
    // It is a URL an authenticated POST is redirected to. Nothing untrusted
    // reaches it, and the action puts it through `safeRedirect` regardless.
    const actions = repositoryActions(standing(), options)

    expect(actions.next.startsWith('/')).toBe(true)
    expect(actions.next.startsWith('//')).toBe(false)
  })

  it('sends a signed-out reader to sign in, and back to where they were', () => {
    const actions = repositoryActions(standing(), { ...options, signedIn: false })

    expect(actions.signedIn).toBe(false)
    expect(actions.signInHref).toBe(`/login?next=${encodeURIComponent('/stacks/stacks')}`)
  })

  it('selects the reader\'s current subscription, and `none` when they have never said', () => {
    const chosen = repositoryActions(standing({ subscription: 'all' }), options)
    expect(chosen.choices.find(choice => choice.selected)?.value).toBe('all')

    const never = repositoryActions(standing(), options)
    expect(never.choices.find(choice => choice.selected)?.value).toBe('none')
  })

  it('offers every choice the endpoint accepts, and no others', () => {
    // A control that offers something the endpoint refuses is a button that
    // silently does nothing.
    const values = repositoryActions(standing(), options).choices.map(choice => choice.value)

    expect(values).toEqual(WATCH_CHOICES.map(choice => choice.value) as any)
    expect(values).toContain('none')
  })

  it('does not tint `ignore` as something already done', () => {
    // Ignoring is a decision to hear nothing. Drawing it as an active watch
    // says the opposite of what the reader chose.
    expect(repositoryActions(standing({ subscription: 'ignore' }), options).watching).toBe(false)
    expect(repositoryActions(standing({ subscription: 'all' }), options).watching).toBe(true)
    expect(repositoryActions(standing({ subscription: 'participating' }), options).watching).toBe(true)
  })

  it('formats the watcher count the way the star count is formatted', () => {
    expect(repositoryActions(standing({ watchers: 1400 }), options).watchers).toBe('1.4k')
  })
})

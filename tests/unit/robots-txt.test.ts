import { describe, expect, it } from 'bun:test'
import { noIndex } from '../../resources/functions/meta'

/**
 * `public/robots.txt` and `noIndex` say the same thing to two different
 * audiences, and only one of them arrives in time.
 *
 * `noIndex` writes a <meta name="robots"> tag, which a crawler reads once it
 * has already fetched and rendered the page. robots.txt is read before the
 * fetch. That difference is why the site fell over twice: the meta policy
 * correctly named /tree/ as an unbounded space, and the crawler walking it
 * still cost a full render of every branch and tag of every repository.
 *
 * So the two must not drift. Anything the meta policy keeps out of an index
 * has to be something robots.txt keeps out of a crawl.
 */

const robots = await Bun.file(new URL('../../public/robots.txt', import.meta.url)).text()

const disallowed = robots
  .split('\n')
  .map(line => line.trim())
  .filter(line => line.startsWith('Disallow:'))
  .map(line => line.slice('Disallow:'.length).trim())
  .filter(Boolean)

/** robots.txt matching: a `*` stands for any run of characters, prefix match. */
function crawlBlocked(path: string): boolean {
  return disallowed.some((rule) => {
    const pattern = rule.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')

    return new RegExp(`^${pattern}`).test(path)
  })
}

/*
 * One path per reason the meta policy has for hiding something. Written out
 * rather than generated, because a generated list would be derived from the
 * same regexes it is meant to be checking.
 */
const HIDDEN = [
  '/login',
  '/register',
  '/forgot-password',
  '/unsubscribe',
  '/settings/profile',
  '/notifications',
  '/reviews',
  '/new',
  '/search?q=stx',
  '/stacks/stx/tree/main/src/index.ts',
  '/stacks/stx/blob/v0.2.196/README.md',
  '/stacks/stx/raw/main/package.json',
  '/stacks/stx/commit/deadbeef',
  '/stacks/stx/commits',
  '/stacks/stx/compare/main...next',
  '/stacks/stx/run/12',
  '/stacks/stx/runs',
  '/stacks/stx/tests',
  '/stacks/stx/insight',
  '/stacks/stx/settings',
  '/stacks/stx/webhooks',
  '/stacks/stx/labels',
  '/stacks/stx/milestones',
  '/stacks/tokens',
  '/stacks/people',
]

/* The pages the site exists to be found by. Neither policy may hide these. */
const PUBLIC = [
  '/',
  '/discover',
  '/explore',
  '/stacks',
  '/stacks/stx',
  '/stacks/stx/pulls',
  '/stacks/stx/issues',
  '/stacks/stx/pull/12',
  '/stacks/stx/issue/12',
  '/features/checks',
  '/pricing',
]

describe('robots.txt', () => {
  it('stops the crawl of everything the meta policy stops the indexing of', () => {
    for (const path of HIDDEN) {
      expect(noIndex(path), `${path} should be noindex`).toBe(true)
      expect(crawlBlocked(path), `${path} should be disallowed in robots.txt`).toBe(true)
    }
  })

  it('leaves the pages worth finding alone', () => {
    for (const path of PUBLIC) {
      expect(noIndex(path), `${path} should be indexable`).toBe(false)
      expect(crawlBlocked(path), `${path} should be crawlable`).toBe(false)
    }
  })

  it('names a user-agent, because a file of bare rules applies to nobody', () => {
    expect(robots).toMatch(/^User-agent:\s*\*$/m)
  })

  it('does not point at a sitemap that is not there', () => {
    expect(robots).not.toMatch(/^Sitemap:/m)
  })
})

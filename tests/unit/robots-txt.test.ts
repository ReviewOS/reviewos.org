import { buildRobotsTxt, resolveSeoOrigin } from '@stacksjs/actions/seo'
import { describe, expect, it } from 'bun:test'
import app from '../../config/app'
import { noIndex } from '../../resources/functions/meta'

/**
 * The robots policy and `noIndex` say the same thing to two different
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
 *
 * ## Why this reads the generated file and not a static one
 *
 * The policy used to live in a hand-written `public/robots.txt`, which Stacks
 * serves in preference to its own. A static file cannot know the origin it is
 * served from, so it named no Sitemap, and every self-hoster would have had to
 * either edit it or advertise ours. It now lives in `config/app.ts` under
 * `seo.robots`, which both generators read: /robots.txt gets the rules and the
 * instance's own sitemap URL, and /sitemap.xml stops listing pages the rules
 * disallow. Thirteen were listed and blocked at the same time before this.
 *
 * So the subject here is what the framework *generates* from our config. A
 * test against a file in `public/` would now be testing something nothing
 * serves.
 */

const robots = buildRobotsTxt({
  seo: (app as any).seo,
  origin: resolveSeoOrigin({ seo: (app as any).seo, appUrl: (app as any).url }),
} as any)

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

  /*
   * The inverse of what this asserted before.
   *
   * It read `does not point at a sitemap that is not there`, and the premise
   * was wrong: nothing is at `public/sitemap.xml`, so Stacks serves a
   * generated /sitemap.xml, and it has always been there. The old static
   * robots.txt omitted the line because it could not name an origin, and the
   * test pinned that limitation in place as though it were the policy.
   */
  it('points at the sitemap it has, at the origin it is served from', () => {
    expect(robots).toMatch(/^Sitemap:\s*https?:\/\/\S+\/sitemap\.xml$/m)
  })
})

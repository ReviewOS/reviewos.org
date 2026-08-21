/**
 * **The public diff viewer — somebody else's diff, opened here**
 *
 * DiffsHub's whole pitch is a URL swap: change the hostname on a GitHub pull
 * request and their viewer opens it. It is a lower-friction argument than a
 * migration, and it is the same argument mirroring makes - let somebody use the
 * thing before asking them to move to it.
 *
 * ## The decision this file records
 *
 * **It ships on the app, at `/view`, and it says what it is.**
 *
 * *On the app, not the marketing domain*, because the viewer is the product.
 * Standing it up on a second host would mean a second deployment of the diff
 * engine, and the first time the two versions differed the demo would be
 * arguing against the thing it is demonstrating.
 *
 * *At `/view` rather than at the root*, because the root of this instance is
 * the owner namespace: `reviewos.org/torvalds/linux` is a repository *here*,
 * or a repository somebody could create here tomorrow. A viewer at the root
 * would either shadow real repositories or be shadowed by them, and both are
 * worse than one extra path segment. An operator who wants the bare swap points
 * a hostname at `/view` in their gateway, which is one rewrite.
 *
 * *And it advertises*, because a viewer that is quiet about where it came from
 * is a favour done anonymously. Somebody arriving from a link should be able to
 * find out what rendered it. It is a header and a footer line, not a banner.
 *
 * ## Off by default
 *
 * This is a fetcher pointed at the internet, running on a server that holds
 * every repository on the instance. An operator turns it on deliberately - and
 * on a private instance behind a firewall the honest answer is usually to leave
 * it off. See `app/Actions/PublicDiff/fetch.ts` for what is structural rather
 * than configurable: the host allowlist, the byte ceiling, and redirects
 * followed one hop at a time with the host checked at each.
 */

import { env } from '@stacksjs/env'

export interface PublicDiffConfig {
  /** Whether the viewer answers at all. Off by default. */
  enabled: boolean
  /**
   * Requests per five minutes per address, before the viewer refuses.
   *
   * Deliberately low. Each one is an outbound fetch of an unbounded patch from
   * GitHub, so this is the number that keeps a shared instance from being
   * somebody's crawler. It is spent per *proxy* request, not per page: a diff
   * already fetched is answered from the page.
   */
  requestsPerWindow: number
}

export default {
  enabled: env.PUBLIC_DIFF_ENABLED === true || env.PUBLIC_DIFF_ENABLED === 'true',
  requestsPerWindow: Number(env.PUBLIC_DIFF_RATE ?? 30),
} satisfies PublicDiffConfig

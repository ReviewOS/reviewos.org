import type { SecurityConfig } from '@stacksjs/types'

/**
 * **Services**
 *
 * This configuration defines all of your services. Because Stacks is fully-typed, you may
 * hover any of the options below and the definitions will be provided. In case you
 * have any questions, feel free to reach out via Discord or GitHub Discussions.
 */
export default {
  /**
   * **Which models publish a REST API.**
   *
   * `'own'`, meaning `app/Models` and nothing else. A `useApi` trait used to
   * generate routes for every model the framework ships as well, so this
   * instance served `/api/products`, `/api/coupons` and `/api/carts` over
   * tables it has never migrated: discoverable, in the OpenAPI document, and
   * failing at runtime rather than answering 404. 178 of 714 routes came from
   * 72 commerce and CMS models a git forge has no use for.
   *
   * `STACKS_DEFAULT_ROUTES=none` in `.env` already removed the default route
   * *files*; this is the same decision one layer down, for the routes a model
   * generates. Both exist because a self-hosted forge's API surface is also
   * its attack surface, and an endpoint nobody meant to publish is the kind
   * nobody reviews.
   *
   * An override of a framework model counts as the app's, so adopting one is
   * still a matter of putting it in `app/Models`. Added in stacksjs/stacks#2866,
   * which this instance asked for.
   */
  api: {
    models: 'own',
  },

  firewall: {
    enabled: true,
    countryCodes: ['RU', 'IR'],
    ipAddresses: [],
    // Per-IP request ceiling. Kept low enough to blunt online brute force /
    // enumeration against auth, password-reset, and 2FA endpoints (the
    // per-account lockouts are the second line; this is the first). Raise it
    // for high-throughput public APIs — but 1000/min/IP let an attacker make
    // ~16 guesses/sec, which defeats the purpose of a firewall limit.
    rateLimitPerMinute: 100,
    useIpReputationLists: true,
    useKnownBadInputsRuleSet: true,
    queryString: [],
    httpHeaders: [],
  },
} satisfies SecurityConfig

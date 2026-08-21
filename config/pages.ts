/**
 * **Pages — where published sites are served from**
 *
 * A published site is somebody else's HTML and JavaScript. The only thing
 * separating a repository owner's script from every session on the instance is
 * the **origin**, so Pages needs a hostname that is not the instance's, and it
 * will not serve anything until it has one.
 *
 * ## Why this is not optional and has no default
 *
 * A default of "under the instance's own host" would work on the first try and
 * be a cross-site scripting vulnerability with a straight face: a page on
 * `reviewos.org/owner/repo/pages/` shares cookies, storage and same-origin
 * fetch with `reviewos.org`, so publishing a site would be handing its owner a
 * script tag on everybody's dashboard.
 *
 * So `PAGES_DOMAIN` is set by an operator or Pages is off, and the settings
 * page says which. That is one DNS record and one certificate more than
 * nothing, and it is the whole security boundary of the feature.
 *
 * ## The scheme
 *
 * With `PAGES_DOMAIN=pages.example.com`:
 *
 * ```
 * https://<owner>.pages.example.com/<repository>/
 * ```
 *
 * The owner is a subdomain and the repository is the first path segment, which
 * is GitHub's scheme and is chosen for the same reason: one wildcard record
 * (`*.pages.example.com`) and one wildcard certificate cover every site that
 * will ever exist here, where a subdomain per repository would need a
 * certificate per repository.
 *
 * A site may also declare its own `domain`, and that one is answered directly.
 */

import { env } from '@stacksjs/env'

export interface PagesConfig {
  /**
   * The suffix every published site is served under, e.g. `pages.example.com`.
   * Empty means Pages is off: nothing is served and the settings page says so.
   */
  domain: string
  /**
   * Whether a site may claim a custom domain of its own.
   *
   * On by default, and it costs an operator something to leave on: a custom
   * domain needs a certificate for a name the instance does not own, which is
   * either an on-demand TLS gateway in front or a manual certificate per site.
   * An instance with neither should turn this off rather than let owners
   * configure a domain that answers with the wrong certificate.
   */
  customDomains: boolean
  /**
   * How long a browser may cache a file, in seconds.
   *
   * Short by default. A documentation site's whole value is being current, and
   * the failure people report is "I pushed the fix and the page still says the
   * old thing" - which a day-long cache causes and no amount of explaining
   * fixes. HTML is never cached beyond this; hashed assets are immutable by
   * their own filenames.
   */
  maxAge: number
}

export default {
  domain: String(env.PAGES_DOMAIN ?? '').trim().toLowerCase(),
  customDomains: env.PAGES_CUSTOM_DOMAINS !== false && env.PAGES_CUSTOM_DOMAINS !== 'false',
  maxAge: Number(env.PAGES_MAX_AGE ?? 60),
} satisfies PagesConfig

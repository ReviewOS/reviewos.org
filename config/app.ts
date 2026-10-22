import type { AppConfig } from '@stacksjs/types'
import { env } from '@stacksjs/env'

/**
 * **Application Configuration**
 *
 * This configuration defines all of your application options. Because Stacks is fully-typed,
 * you may hover any of the options below and the definitions will be provided. In case
 * you have any questions, feel free to reach out via Discord or GitHub Discussions.
 */
export default {
  name: env.APP_NAME ?? 'ReviewOS',
  description: 'An open source, self-hostable git forge built around code review.',
  env: env.APP_ENV ?? 'local',
  url: env.APP_URL ?? 'reviewos.localhost',
  redirectUrls: ['reviewos.org'],
  debug: env.DEBUG ?? false,
  key: env.APP_KEY,

  maintenanceMode: env.APP_MAINTENANCE ?? false,
  comingSoonMode: env.APP_COMING_SOON ?? false,
  comingSoonSecret: env.APP_COMING_SOON_SECRET ?? '',
  // docMode: true, // instead of example.com/docs, deploys example.com as main entry point for docs
  docMode: false,

  /**
   * What a crawler may walk, and what it may not.
   *
   * `resources/functions/meta.ts` already decided this and wrote the reason
   * down: some pages are personal, and some are generated views of the same
   * data, an unbounded URL space that a crawler will happily walk forever. It
   * expressed that as a <meta name="robots"> tag, which a crawler reads after
   * it has fetched and rendered the page, so the expensive work was already
   * done and the tag only kept the result out of an index.
   *
   * It was not a theory. A crawler walked /tree/ across every branch and every
   * tag of every mirrored repository, a page at a time, until the page process
   * reached its memory ceiling and the site stopped answering. Twice.
   *
   * So the same policy, said in the one place that stops the fetch instead of
   * the indexing. This lived in a hand-written `public/robots.txt`, which the
   * framework serves in preference to its own and which therefore named no
   * Sitemap: the static file cannot know the origin it is served from, and
   * every self-hoster would have advertised ours. Here the generated
   * /robots.txt carries these rules *and* the instance's own sitemap URL.
   *
   * `tests/unit/robots-txt.test.ts` fails if this list and the meta policy
   * ever disagree. Stacks adds `/api/` and `Allow: /` of its own.
   */
  seo: {
    robots: {
      disallow: [
        // Personal, or a form. Nothing here for somebody arriving from a
        // search.
        '/login',
        '/register',
        '/forgot-password',
        '/unsubscribe',
        '/unsubscribed',
        '/settings',
        '/notifications',
        '/reviews',
        '/new',
        '/search',

        // The unbounded spaces. Every one of these takes a ref or a range, so
        // the number of URLs is the number of refs times the number of paths,
        // and a crawler has no way to know it is walking the same repository
        // over and over.
        '/*/*/tree/',
        '/*/*/blob/',
        '/*/*/raw/',
        '/*/*/commit/',
        '/*/*/commits',
        '/*/*/compare',
        '/*/*/run/',
        '/*/*/runs',
        '/*/*/tests',
        '/*/*/insight',

        // Administrative views of a repository, and of an owner.
        '/*/*/settings',
        '/*/*/webhooks',
        '/*/*/labels',
        '/*/*/milestones',
        '/*/tokens',
        '/*/people',

        // The git wire protocol. A crawler that follows a clone URL gets a
        // pack file.
        '/git/',
      ],
    },
  },

  timezone: 'America/Los_Angeles',
  locale: 'en',
  fallbackLocale: 'en',
  cipher: 'aes-256-cbc',
} satisfies AppConfig

import type { BunPressOptions } from '@stacksjs/bunpress'

/**
 * **Documentation Configuration**
 *
 * The documentation site is bunpress, wrapped by Stacks. `./buddy dev:docs` serves
 * it and `./buddy build:docs` builds it; both read this file.
 *
 * The roadmap under `/todo` is the source of truth for what exists and what does
 * not, so it sits at the top of the sidebar rather than in a project footnote.
 */
const config: BunPressOptions = {
  verbose: false,
  docsDir: './docs',
  outDir: './dist/docs',

  // Top-level, not only under `markdown`: bunpress prefers these when both are
  // present, and they are what the browser tab and the social cards show.
  title: 'ReviewOS',
  description: 'An open source, self-hostable git forge built around code review.',

  /*
   * The tab icon, the same mark the application and the cards carry.
   *
   * The docs are served from `/docs` on the same origin as the application, so
   * these are the very files `buddy generate:images` wrote into `public/`.
   *
   * **Absolute, for the same reason the card above is.** bunpress prefixes
   * every root-relative `href` in the document with its base path, which it
   * takes from `sitemap.baseUrl` - so `/favicon.svg` is rewritten to
   * `/docs/favicon.svg`, where no such file exists. That rewrite is right for
   * a link to another documentation page and wrong for a file that belongs to
   * the origin rather than to the docs, and a bare path cannot tell the two
   * apart. An absolute URL can.
   *
   * Needs bunpress 0.2.8, which added the site-wide `head` list. Before it a
   * favicon could only be declared per page, in frontmatter, on all 41 of them.
   */
  head: [
    ['link', { rel: 'icon', href: 'https://reviewos.org/favicon.svg', type: 'image/svg+xml' }],
    ['link', { rel: 'icon', href: 'https://reviewos.org/favicon.ico', sizes: '32x32' }],
    ['link', { rel: 'apple-touch-icon', href: 'https://reviewos.org/apple-touch-icon.png' }],
  ],

  nav: [
    { text: 'Roadmap', link: '/todo/' },
    // Back into the instance, which the docs otherwise have no route to: a
    // reader who followed Docs out of the top bar had Discover and nothing
    // else to return through.
    { text: 'Explore', link: 'https://reviewos.org/explore' },
    { text: 'Discover', link: 'https://reviewos.org/discover' },
    {
      text: 'Project',
      items: [
        // Ours first. The docs argue for self-hosting a forge; sending a
        // reader to GitHub to read this project's own code undercuts the
        // argument on the way past. The GitHub mirror stays listed, labelled,
        // because it is still where releases are cut.
        { text: 'Source', link: 'https://reviewos.org/reviewos/reviewos.org' },
        { text: 'Issues', link: 'https://reviewos.org/reviewos/reviewos.org/issues' },
        { text: 'Changelog', link: 'https://github.com/ReviewOS/reviewos.org/blob/main/CHANGELOG.md' },
        { text: 'GitHub mirror', link: 'https://github.com/ReviewOS/reviewos.org' },
      ],
    },
  ],

  markdown: {
    title: 'ReviewOS Documentation',
    /*
     * The link preview for every documentation page.
     *
     * bunpress only emits Open Graph tags at all when `sitemap.baseUrl` is
     * set, which it is below. The card itself is the one `buddy
     * generate:images` draws for `/docs` from `config/images.ts`; it is named
     * here as an absolute URL because a receiver resolving a relative image
     * against its own host is how a preview renders as a broken square.
     *
     * A page's own `image:` in its frontmatter still wins, so a page with
     * something better to show can say so.
     *
     * The four `og:image:*` shape keys need bunpress 0.2.7, which dropped them
     * on the floor until then: `basicMeta` filters every `og:` key out of the
     * arbitrary meta block on the assumption the Open Graph builder handles
     * them, and it only ever handled `og:image`. They are declared here now
     * and will start rendering when `@stacksjs/docs` picks up 0.2.7; the image
     * and the card type work today.
     */
    meta: {
      'description': 'An open source, self-hostable git forge built around code review.',
      'author': 'ReviewOS',
      'og:image': 'https://reviewos.org/social/docs.png',
      'og:image:type': 'image/png',
      'og:image:width': '1200',
      'og:image:height': '630',
      'og:image:alt': 'ReviewOS documentation: install it, run it, operate it',
      // The default is `summary`, which renders a small square thumbnail no
      // matter how good the card is.
      'twitter:card': 'summary_large_image',
    },
    syntaxHighlightTheme: 'github-dark',
    toc: {
      enabled: true,
      minDepth: 2,
      maxDepth: 3,
    },
    sidebar: {
      '/': [
        {
          text: 'Introduction',
          items: [
            { text: 'What ReviewOS is', link: '/' },
            { text: 'Getting started', link: '/getting-started' },
            { text: 'Architecture', link: '/architecture' },
            { text: 'Contributing', link: '/contributing' },
          ],
        },
        /*
         * The pages somebody reads while running or talking to an instance.
         *
         * Above the roadmap because a reader who arrived from a search for
         * "reviewos webhook payload" wants the reference, not a phase list -
         * and until now these pages existed with nothing linking to them.
         */
        {
          text: 'Reference',
          items: [
            { text: 'Configuration', link: '/configuration' },
            { text: 'Design', link: '/design' },
            { text: 'API reference', link: '/api' },
            { text: 'Webhook payloads', link: '/webhooks' },
            { text: 'Runner protocol', link: '/runner-protocol' },
            { text: 'Self-hosting', link: '/self-hosting' },
            { text: 'Pages', link: '/pages' },
            { text: 'CI threat model', link: '/ci-threat-model' },
            { text: 'The execution plane', link: '/ci-execution-plane' },
            { text: 'CI security review', link: '/ci-security-review' },
            { text: 'Security review', link: '/security-review-2026-08' },
            { text: 'Workflow extensions', link: '/extensions' },
            { text: 'Actions conformance', link: '/conformance' },
            { text: 'Runner autoscaling', link: '/autoscaling' },
            { text: 'Test intelligence', link: '/test-intelligence' },
            { text: 'Deployment environments', link: '/environments' },
            { text: 'Workflow variables', link: '/variables' },
            { text: 'Secrets', link: '/secrets' },
            { text: 'The merge queue', link: '/merge-queue' },
            { text: 'Insight', link: '/insight' },
            { text: 'Runner hooks', link: '/runner-hooks' },
            { text: 'Plugins', link: '/plugins' },
            { text: 'Identity tokens', link: '/oidc' },
            { text: 'Signed work', link: '/signed-work' },
            { text: 'Workflows as code', link: '/workflows-as-code' },
            { text: 'Arriving from Buildkite', link: '/from-buildkite' },
          ],
        },
        {
          text: 'Roadmap',
          items: [
            { text: 'Overview', link: '/todo/' },
            { text: '00 - Bootstrap', link: '/todo/00-bootstrap' },
            { text: '01 - Foundation', link: '/todo/01-foundation' },
            { text: '02 - Git hosting', link: '/todo/02-git-hosting' },
            { text: '03 - Issues', link: '/todo/03-issues' },
            { text: '04 - Reviews', link: '/todo/04-reviews' },
            { text: '05 - Notifications and webhooks', link: '/todo/05-notifications-webhooks' },
            { text: '06 - Search and explore', link: '/todo/06-search-explore' },
            { text: '07 - Marketing and docs', link: '/todo/07-marketing-docs' },
            { text: '08 - Migration', link: '/todo/08-migration' },
            { text: '09 - Checks and CI', link: '/todo/09-checks-ci' },
            { text: '10 - Federation', link: '/todo/10-federation' },
            { text: '11 - Self-hosting and operations', link: '/todo/11-self-hosting-deploy' },
            { text: '12 - The API and agents', link: '/todo/12-api-and-agents' },
            { text: '13 - Mirroring', link: '/todo/13-mirroring' },
            // 14 and 15 existed as files, were listed in the roadmap's own
            // table, and were built to HTML - and were missing from here, so
            // the two largest phases were reachable only from inside another
            // page. The sidebar is the roadmap's index; a phase absent from it
            // is a phase nobody browsing finds.
            { text: '14 - The diff engine', link: '/todo/14-diff-engine' },
            { text: '15 - Pipelines', link: '/todo/15-pipelines' },
          ],
        },
      ],
    },
    themeConfig: {
      /*
       * The product's teal, because this is the product's documentation.
       *
       * bunpress ships an indigo brand ramp, so `/docs` rendered its buttons,
       * its links and its logotype in a colour that appears nowhere else on
       * this instance - and the Docs item in the top bar therefore led somewhere
       * that looked like a different project. The ramp below is the same
       * `--accent` the application and the marketing pages use, and the dark
       * half is the lighter teal those two switch to, because #0f6d72 on a dark
       * background is a colour you cannot read a link in.
       */
      cssVars: {
        '--bp-c-brand-1': '#0b565a',
        '--bp-c-brand-2': '#0f6d72',
        '--bp-c-brand-3': '#137e83',
        '--bp-c-brand-soft': 'rgba(15, 109, 114, 0.14)',
      },

      /*
       * The dark half, which `cssVars` alone cannot express: it emits one
       * `:root` block, and bunpress switches theme by putting `.dark` on the
       * document rather than by a media query. Emitted after that block, so the
       * two tie on specificity and this one wins where it applies.
       */
      css: `
        .dark {
          --bp-c-brand-1: #7fd8db;
          --bp-c-brand-2: #4ec5c9;
          --bp-c-brand-3: #2a9ba0;
          --bp-c-brand-soft: rgba(78, 197, 201, 0.16);

          /*
           * The ramp inverts in the dark - brand-1 is now the pale end, because
           * it is what links are drawn in - and a filled button takes its
           * background from brand-1 and its text from this. Left at its default
           * white, the call to action on the front page of the documentation
           * was white on pale teal: a button you can see and cannot read.
           */
          --bp-button-brand-text: #062023;
        }
      `,

      footer: {
        message: 'Released under the MIT License.',
        copyright: 'Copyright 2026-present ReviewOS contributors',
      },
      socialLinks: [
        { icon: 'github', link: 'https://github.com/ReviewOS/reviewos.org' },
      ],
    },
  },

  sitemap: {
    enabled: true,
    baseUrl: 'https://reviewos.org/docs',
  },

  robots: {
    enabled: true,
  },
}

export default config

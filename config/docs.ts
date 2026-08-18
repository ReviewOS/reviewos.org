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

  nav: [
    { text: 'Roadmap', link: '/todo/' },
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
            { text: 'CI threat model', link: '/ci-threat-model' },
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

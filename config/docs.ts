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
    {
      text: 'Project',
      items: [
        { text: 'Source', link: 'https://github.com/ReviewOS/reviewos.org' },
        { text: 'Issues', link: 'https://github.com/ReviewOS/reviewos.org/issues' },
        { text: 'Changelog', link: 'https://github.com/ReviewOS/reviewos.org/blob/main/CHANGELOG.md' },
      ],
    },
  ],

  markdown: {
    title: 'ReviewOS Documentation',
    meta: {
      description: 'An open source, self-hostable git forge built around code review.',
      author: 'ReviewOS',
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

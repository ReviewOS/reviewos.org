export interface BlogConfig {
  subdomain: string
  title: string
  description: string
  postsPerPage: number
  enableComments: boolean
  enableRss: boolean
  enableSitemap: boolean
  enableSearch: boolean
  /** Short title used in the blog layout nav; defaults to `title`. */
  siteTitle?: string
  /** Fallback post author when frontmatter has none. */
  author?: string
  /** Canonical site origin for feed/sitemap URLs when no request origin exists. */
  url?: string
  nav?: { text: string, link: string }[]
  /** Which modes the blog theme toggle offers. */
  themes?: ('colored' | 'light' | 'dark')[]
  defaultTheme?: 'colored' | 'light' | 'dark'
  /** Raw HTML for the blog footer colophon line. */
  colophon?: string
  social: {
    twitter?: string
    github?: string
  }
  theme: {
    primaryColor: string
    logo?: string
  }
}

/*
 * The blog, as this project rather than as the template it started from.
 *
 * Every value below was Stacks': the title, the description, the canonical URL,
 * the social handles, the colophon. None of it is a placeholder that reads as
 * one - a build of this would have published another product's branding on
 * reviewos.org, and it would have looked deliberate.
 *
 * `content/blog/` is empty on purpose. Two posts about Stacks shipped here for
 * the same reason, and an empty blog is honest where somebody else's marketing
 * is not.
 */
const config: BlogConfig = {
  subdomain: 'blog',
  title: 'The ReviewOS Blog',
  description: 'Notes from building an open source git forge organized around code review.',
  postsPerPage: 10,
  enableComments: true,
  enableRss: true,
  enableSitemap: true,
  enableSearch: true,
  siteTitle: 'ReviewOS Blog',
  author: 'The ReviewOS contributors',
  url: 'https://reviewos.org',
  nav: [
    { text: 'Blog', link: '/blog' },
    { text: 'Docs', link: '/docs' },
    { text: 'GitHub', link: 'https://github.com/ReviewOS/reviewos.org' },
  ],
  themes: ['colored', 'light', 'dark'],
  defaultTheme: 'light',
  colophon: 'Open source, self-hostable · <a href="/blog/feed.xml">RSS</a>',
  social: {
    github: 'ReviewOS/reviewos.org',
  },
  theme: {
    primaryColor: '#2563eb',
    logo: undefined,
  },
}

export default config

import type { ImagesConfig, SocialCardPageConfig } from '@stacksjs/types'
import { COMPARISONS, FEATURES, USE_CASES } from '../resources/functions/marketing'

/**
 * **Generated imagery**
 *
 * The link preview is the only part of a page most people ever see. A link to
 * a feature page pasted into a chat, a pull request description, or iMessage
 * is rendered from `og:image`, and a page without one is a grey rectangle with
 * a URL in it - the first impression this project makes in the place most
 * people meet it.
 *
 * `./buddy generate:images` draws every card declared here with ts-images and
 * writes them to `public/social/`. No browser in the pipeline: this used to be
 * an HTML card screenshotted through headless Chrome, which meant one card
 * (nobody screenshots forty pages by hand) and a Chrome dependency on whoever
 * regenerated it.
 *
 * **The copy is not written here.** Features, use cases, and comparisons come
 * from `resources/functions/marketing.ts`, the same catalog the mega menu and
 * the index pages read. A card that quotes a headline the page no longer has
 * is worse than a generic one, and deriving it is the only way that cannot
 * happen. Only the pages with no catalog entry - the landing page and the
 * index pages - are spelled out below.
 *
 * Pages the build cannot enumerate (a repository, a pull request, an issue)
 * are drawn per request instead. See `app/Actions/Og/SocialCardAction.ts`.
 */

/** Where every generated card is written, and the URL prefix it is served on. */
export const SOCIAL_OUTPUT_DIR = 'public/social'
export const SOCIAL_PUBLIC_PATH = '/social'

/**
 * The container. PNG rather than the usual JPEG, and it costs about 60 KB a
 * card to say so.
 *
 * These cards are a dark gradient, one glow, and type - the two things JPEG
 * is worst at. The gradient blocks visibly across the left half of the card
 * at the default quality, and the ringing lands exactly on the edge between
 * light text and a dark field, which is every letter on the card. At 1200x630
 * that is 110 KB against 50 KB, which is worth it for the one image a link to
 * this site is judged by.
 */
export const SOCIAL_FORMAT: NonNullable<NonNullable<ImagesConfig['social']>['format']> = 'png'

/** The pages with no entry in the marketing catalog. */
const STANDALONE: SocialCardPageConfig[] = [
  {
    path: '/',
    eyebrow: 'Open source, self-hostable',
    title: 'A git forge built around review',
    subtitle: 'Stacked pull requests, review threads that survive a force-push, and a diff that stays fast at a hundred files.',
  },
  {
    path: '/features',
    eyebrow: 'Features',
    title: 'A forge that spends its complexity on review',
    subtitle: 'Repositories, issues, and pull requests, with the review as the primary object rather than a tab on one.',
  },
  {
    path: '/for',
    eyebrow: 'Use cases',
    title: 'Who this is built for',
    subtitle: 'Maintainers, platform teams, regulated work, and teams whose diffs are mostly machine-authored.',
  },
  {
    path: '/compare',
    eyebrow: 'Comparisons',
    title: 'How ReviewOS compares',
    subtitle: 'Against GitHub, GitLab, and Forgejo, on the things that differ rather than the things every forge has.',
  },
  {
    path: '/docs',
    eyebrow: 'Documentation',
    title: 'Install it, run it, operate it',
    subtitle: 'One Postgres and one process. Self-hosting instructions, the API reference, and the roadmap.',
  },
  {
    path: '/discover',
    eyebrow: 'Discover',
    title: 'Repositories worth reading',
    subtitle: 'What is being built on this instance, and the reviews happening on it right now.',
  },
  {
    path: '/explore',
    eyebrow: 'Explore',
    title: 'Every public repository here',
    subtitle: 'Browse by language, activity, and what has been reviewed recently.',
  },
]

/**
 * One card per catalog entry.
 *
 * The eyebrow carries the section so a card read at thumbnail size still says
 * where in the site it came from, which the title alone cannot: "Issues that
 * link up" could be a feature, a use case, or a blog post.
 */
const CATALOG: SocialCardPageConfig[] = [
  ...FEATURES.map(feature => ({
    path: `/features/${feature.slug}`,
    eyebrow: feature.group,
    title: feature.name,
    subtitle: feature.summary,
  })),
  ...USE_CASES.map(useCase => ({
    path: `/for/${useCase.slug}`,
    eyebrow: 'Use case',
    title: useCase.name,
    subtitle: useCase.summary,
  })),
  ...COMPARISONS.map(comparison => ({
    path: `/compare/${comparison.slug}`,
    eyebrow: 'Comparison',
    title: comparison.name,
    subtitle: comparison.summary,
  })),
]

/** Every route that gets its own card, in the order they are generated. */
export const SOCIAL_PAGES: SocialCardPageConfig[] = [...STANDALONE, ...CATALOG]

const config: ImagesConfig = {
  /*
   * Vendored TrueType, not a web font.
   *
   * The card renderer reads `glyf` outlines directly rather than asking a
   * browser to lay text out, so the face has to be a file this repository
   * ships. Fetching one at generation time would make a card render
   * differently depending on whether the machine had a route out, and this is
   * an image nobody looks at again after it is committed.
   *
   * Geist, under the OFL, which is what the site itself sets - see
   * `resources/fonts/OFL.txt`.
   */
  fonts: {
    title: 'resources/fonts/Geist-Bold.ttf',
    body: 'resources/fonts/Geist-Medium.ttf',
  },

  brand: 'ReviewOS',

  /*
   * The mark, drawn bare.
   *
   * `markPlate: false` because the mark already carries its own teal plate -
   * the default white one behind it would read as a white sticker with a
   * smaller teal sticker on top. See `scripts/brand-mark.ts`.
   */
  mark: 'public/images/mark.png',
  markPlate: false,

  /*
   * The dark palette, not the light one.
   *
   * A card is always seen inside somebody else's interface, against a surface
   * this project does not choose. The dark card holds its edges on a light
   * timeline and on a dark one; the light card dissolves into the first.
   */
  background: {
    color: '#0c1113',
    gradient: {
      angle: 150,
      stops: [
        { offset: 0, color: '#101a1c' },
        { offset: 1, color: '#0a0f11' },
      ],
    },
    // One glow, off the top right. Enough that a flat dark rectangle does not
    // read as a failed image load, and not enough to compete with the words.
    glows: [
      { x: 0.88, y: 0.02, radius: 0.55, color: 'rgb(78 197 201 / 0.20)' },
    ],
  },

  color: '#eef2f2',
  mutedColor: '#9aa9ac',
  accent: '#7fd8db',

  social: {
    enabled: true,
    outputDir: SOCIAL_OUTPUT_DIR,
    publicPath: SOCIAL_PUBLIC_PATH,
    format: SOCIAL_FORMAT,

    /*
     * One size, deliberately.
     *
     * Repeated `og:image` is a gallery rather than a fallback list: Discord
     * lays every declared image out side by side, each cropped to a sliver,
     * and Facebook and Apple take the first and ignore the rest. 1.91:1 is
     * the ratio every scraper draws whole and the one Messages letterboxes
     * into its taller slot rather than mangling.
     */
    presets: ['og'],

    pages: SOCIAL_PAGES,
  },

  /*
   * The browser tab, the home screen, and the bookmark bar.
   *
   * There was no favicon at all: nothing declared one and `public/` held no
   * `favicon.ico`, so every tab showed the browser's blank-page glyph and
   * every request for `/favicon.ico` was a 404 in the log. The two `favicon`
   * SVGs under `public/images/logos/` are leftovers from the Stacks template
   * and are somebody else's logo.
   *
   * Generated from the same mark the cards carry, so the tab and the link
   * preview cannot end up showing different logos.
   *
   * `platforms: []` means no iOS or macOS asset catalogs. This is a web
   * application; an Xcode catalog would be a directory nothing here reads.
   */
  appIcons: {
    enabled: true,
    source: 'public/images/mark.png',
    platforms: [],
    favicon: true,
    faviconDir: 'public',
    manifest: {
      name: 'ReviewOS',
      shortName: 'ReviewOS',
      // The dark surface, because a home screen splash paints this behind the
      // icon and the icon is teal on nothing.
      themeColor: '#0c1113',
      backgroundColor: '#0c1113',
    },
  },
}

export default config

/**
 * What a page tells the outside world about itself.
 *
 * Three audiences read the `<head>`, and they are not the same audience:
 *
 * - a browser tab, which wants a short title;
 * - a search engine, which wants a description, a canonical URL, and to be
 *   told which pages it should not have;
 * - a link unfurler - iMessage, Slack, Discord, a pull request description -
 *   which wants an image and will render a grey rectangle with a URL in it
 *   if it does not get one.
 *
 * The third is the one that was missing here entirely on every page inside the
 * product, and partly missing outside it: the marketing layout declared one
 * card for forty pages and the product layout declared no meta at all beyond a
 * title. This module is the single answer, so a new page gets the whole set by
 * existing rather than by remembering.
 *
 * **The card URL is derived, not declared.** `config/images.ts` lists the
 * routes that have a generated card and `./buddy generate:images` writes one
 * file per entry; `socialCard()` reads the same list. A page that gains a card
 * gets it in its `<head>` in the same commit, and a page that never had one
 * falls back to the site card rather than to nothing.
 */
import { SOCIAL_FORMAT, SOCIAL_PAGES, SOCIAL_PUBLIC_PATH } from '../../config/images'

/** The public origin, with no trailing slash. Absolute URLs are required. */
export const SITE_URL = 'https://reviewos.org'

export const SITE_NAME = 'ReviewOS'

/** The description a page inherits when it has nothing better to say. */
export const SITE_DESCRIPTION = 'An open source, self-hostable git forge built around code review. Stacked pull requests, review threads that survive a force-push, and a diff that stays fast at a hundred files.'

/** What the site card shows, for the `alt` on a card that has no page copy. */
export const SITE_CARD_ALT = 'ReviewOS: a git forge built around review'

const CARD_EXTENSION = SOCIAL_FORMAT === 'jpeg' ? 'jpg' : SOCIAL_FORMAT

/**
 * The card file name for a route.
 *
 * The same rule `@stacksjs/image` names the generated files by: the root is
 * `og` so the site card's URL never moves, and everything else is its path
 * with the separators flattened. Restated here rather than imported because
 * importing it pulls the whole ts-images codec stack into a page render, for
 * one line of string handling.
 */
function cardName(path: string): string {
  const trimmed = path.replace(/^\/+|\/+$/g, '')

  return trimmed === '' ? 'og' : trimmed.replace(/[^a-z0-9]+/gi, '-').toLowerCase()
}

/** Routes that have a generated card, so a lookup is a set membership test. */
const GENERATED = new Set(SOCIAL_PAGES.map(page => cardName(page.path)))

/** The site-wide card, used by any page with nothing more specific. */
export const DEFAULT_CARD = `${SOCIAL_PUBLIC_PATH}/og.${CARD_EXTENSION}`

/**
 * The generated card for a route, or the site card.
 *
 * Falling back rather than guessing: naming a file that `generate:images` did
 * not write gives every unfurler a 404 where a perfectly good generic card was
 * available, and a broken image reads worse than a generic one.
 */
export function socialCard(path: string): string {
  const name = cardName(path)

  return GENERATED.has(name) ? `${SOCIAL_PUBLIC_PATH}/${name}.${CARD_EXTENSION}` : DEFAULT_CARD
}

/**
 * Paths whose card has to be drawn when somebody asks for it.
 *
 * A build can enumerate the marketing site; it cannot enumerate the
 * repositories, pull requests, issues, and profiles on an instance, and those
 * are most of what actually gets shared. `/api/og` draws one on demand - see
 * `app/Actions/Og/SocialCardAction.ts`, which decides for itself whether the
 * thing named is public before it draws anything.
 *
 * Under `/api` because only that prefix reaches the route registry here;
 * everything else is resolved by the file-based view router, which would send
 * `/og/owner/repository` to the profile page. The URL is read by scrapers,
 * never typed by a person, so the prefix costs nothing.
 */
const OG_ENDPOINT = '/api/og'

/** Reserved first segments: real routes, not somebody's handle. */
const NOT_AN_OWNER = new Set([
  'api', 'attachments', 'compare', 'discover', 'docs', 'explore', 'features',
  'for', 'forgot-password', 'login', 'new', 'notifications', 'register',
  'reviews', 'search', 'settings', 'unsubscribe', 'unsubscribed',
])

/**
 * The on-demand card for a path, or nothing if the path is not about an
 * owner, a repository, a pull request, or an issue.
 *
 * Returning nothing rather than a URL is the important half: a page that is
 * not about one of those has a perfectly good static card, and pointing it at
 * an endpoint that would only answer with the same generic image costs a
 * request and a cache entry per scrape for no difference in the preview.
 */
export function runtimeCard(path: string): string | undefined {
  const clean = String(path ?? '').split('?')[0]!.split('#')[0]!
  const segments = clean.split('/').filter(Boolean)
  const owner = segments[0]

  if (!owner || NOT_AN_OWNER.has(owner.toLowerCase()))
    return undefined

  // A `.git` suffix is the wire protocol, not a page.
  if (segments.some(segment => segment.endsWith('.git')))
    return undefined

  return `${OG_ENDPOINT}?path=${encodeURIComponent(`/${segments.join('/')}`)}`
}

/**
 * Escape a value on its way into an HTML attribute.
 *
 * For the copy that comes from a person rather than from this repository - a
 * repository description, an issue title. A stray double quote in one of those
 * ends the `content="` it was placed in and turns the rest of the description
 * into attributes on a `<meta>` tag.
 */
export function attr(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * Trim a body of text down to something an unfurler will actually show.
 *
 * Around 160 characters is what a search result renders and roughly what a
 * link preview gives a description before it stops; past that the tail is
 * carried by every scraper and read by none of them. Cut on a word boundary
 * so the result reads as a shortened sentence rather than a truncated one.
 *
 * Not `summarize`: everything under `resources/functions` is auto-imported
 * into templates under its bare name, and `reactions.ts` already exports one.
 */
export function shortenForPreview(text: unknown, limit = 160): string {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim()

  if (flat.length <= limit)
    return flat

  const cut = flat.slice(0, limit)
  const lastSpace = cut.lastIndexOf(' ')

  return `${(lastSpace > limit * 0.6 ? cut.slice(0, lastSpace) : cut).replace(/[,;:.\s]+$/, '')}...`
}

/** A site-relative path as an absolute URL. Passes an absolute one through. */
export function absolute(pathOrUrl: string): string {
  if (/^https?:\/\//i.test(pathOrUrl))
    return pathOrUrl

  return `${SITE_URL}${pathOrUrl.startsWith('/') ? '' : '/'}${pathOrUrl}`
}

/**
 * The canonical URL for a request path.
 *
 * The query string is dropped, which is the point of the tag: `/explore` and
 * `/explore?page=2&sort=stars` are one page as far as a search engine's index
 * is concerned, and leaving them distinct splits whatever a page has earned
 * across however many filter combinations somebody has linked to. A trailing
 * slash is dropped too, for the same reason.
 */
export function canonical(path: string): string {
  const withoutQuery = String(path ?? '/').split('?')[0]!.split('#')[0]!
  const trimmed = withoutQuery.replace(/\/+$/, '')

  return `${SITE_URL}${trimmed || '/'}`
}

/**
 * Pages that must never reach an index, matched on the request path.
 *
 * Two different reasons, deliberately kept in one list because the answer is
 * the same: pages that are *personal* (somebody's notification list, their
 * settings, the sign-in form) have nothing to offer a stranger arriving from a
 * search result, and pages that are *generated views of the same data* (a
 * diff at a ref, a compare range) are an unbounded URL space that a crawler
 * will happily walk forever.
 *
 * Anonymous readers can still reach many of these; `noindex` is about what
 * belongs in a search result, not about who may look.
 */
const NEVER_INDEXED = [
  /^\/login\b/,
  /^\/register\b/,
  /^\/forgot-password\b/,
  /^\/unsubscribe\b/,
  /^\/unsubscribed\b/,
  /^\/settings\b/,
  /^\/notifications\b/,
  /^\/reviews\b/,
  /^\/new\b/,
  /^\/search\b/,
  // Deep repository views: an unbounded space of refs, paths, and ranges.
  /^\/[^/]+\/[^/]+\/(?:compare|commit|commits|tree|blob|raw|run|runs|tests|insight)\b/,
  /^\/[^/]+\/(?:tokens|people)\b/,
  /^\/[^/]+\/[^/]+\/(?:settings|webhooks|labels|milestones)\b/,
]

/** Whether a search engine should keep this path out of its index. */
export function noIndex(path: string): boolean {
  const clean = String(path ?? '/').split('?')[0]!

  return NEVER_INDEXED.some(pattern => pattern.test(clean))
}

/** Everything a `<head>` needs, resolved. */
export interface PageMeta {
  title: string
  description: string
  canonical: string
  /** Absolute URL of the card an unfurler should draw. */
  image: string
  imageAlt: string
  /** `article` for a page about one thing, `website` for the rest. */
  type: string
  robots: string
}

export interface PageMetaInput {
  /** The request path. Everything else is derived from it by default. */
  path?: string
  title?: string
  description?: string
  /** Overrides the derived card. Site-relative or absolute. */
  image?: string
  imageAlt?: string
  type?: string
  /** Forces `noindex`, for a page whose privacy the path cannot express. */
  noIndex?: boolean
}

/**
 * Resolve the tags for one page.
 *
 * Every field has an answer, which is the property worth having: a page that
 * passes nothing still gets a title, a description, a canonical URL and a
 * card, and a page that passes everything gets exactly what it asked for.
 */
export function pageMeta(input: PageMetaInput = {}): PageMeta {
  const path = String(input.path ?? '/')
  const title = (input.title ?? '').trim() || SITE_NAME
  const description = (input.description ?? '').trim() || SITE_DESCRIPTION
  // Drawn on demand where the path names something a build could not have
  // known about, generated where it does not, and overridden where the page
  // has already worked out something better than either.
  const image = absolute(input.image ?? runtimeCard(path) ?? socialCard(path))

  return {
    title,
    description,
    canonical: canonical(path),
    image,
    imageAlt: (input.imageAlt ?? '').trim() || (title === SITE_NAME ? SITE_CARD_ALT : title),
    type: input.type ?? 'website',
    // `max-image-preview:large` is what makes a search result carry the card
    // rather than a thumbnail, and it has to be asked for.
    robots: (input.noIndex || noIndex(path))
      ? 'noindex, nofollow'
      : 'index, follow, max-image-preview:large, max-snippet:-1',
  }
}

/**
 * The dimensions declared alongside the card.
 *
 * Not derived from the file: a scraper that cannot fetch the image has
 * nothing to reserve layout with unless these are in the markup, so they have
 * to be right without reading a pixel. They are the `og` preset's, which is
 * the only preset `config/images.ts` generates.
 */
export const CARD_WIDTH = 1200
export const CARD_HEIGHT = 630
export const CARD_MIME = SOCIAL_FORMAT === 'jpeg' ? 'image/jpeg' : `image/${SOCIAL_FORMAT}`

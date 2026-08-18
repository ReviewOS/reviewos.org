import type { Font, SocialCardOptions } from 'ts-images'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { path as frameworkPath } from '@stacksjs/path'
import { parseColor, renderSocialCard } from 'ts-images'
import images from '../../../config/images'

/**
 * The link-preview card for a page a build could not have known about.
 *
 * `config/images.ts` declares one card per marketing route and
 * `./buddy generate:images` draws them all at build time. That approach ends
 * where the interesting URLs begin: an instance has a page per repository, per
 * pull request, per issue and per account, and those are most of what anybody
 * actually pastes into a chat. There is no list to generate from, so the card
 * is drawn when a scraper asks for it.
 *
 * Everything visual comes from the same `config/images.ts` the generated cards
 * come from, so a card drawn at request time and a card drawn at build time
 * cannot disagree about the palette.
 */

/** What a card says, once the request path has been resolved to a thing. */
export interface CardCopy {
  /** Small line above the title: the section, or the repository. */
  eyebrow: string
  title: string
  subtitle?: string
}

/**
 * The faces, parsed once per process.
 *
 * `loadFont` walks the whole TrueType table, which is a few milliseconds - not
 * much, and paid on every request if it is done inside the handler, for a
 * result that is identical every time. A promise rather than a value so
 * concurrent first requests share one read instead of racing to do it twice.
 */
let faces: Promise<{ title: Font, body: Font }> | null = null

async function fonts(): Promise<{ title: Font, body: Font }> {
  if (!faces) {
    faces = (async () => {
      // Imported here rather than at the top of the file: `loadFont` drags in
      // the font parser, and this action is one route among many in a process
      // that mostly serves JSON.
      const { loadFont } = await import('ts-images')
      const read = async (file: string): Promise<Font> =>
        loadFont(new Uint8Array(await readFile(frameworkPath.projectPath(file))))

      const titleFile = images.fonts?.title ?? 'resources/fonts/Geist-Bold.ttf'

      return {
        title: await read(titleFile),
        body: await read(images.fonts?.body ?? titleFile),
      }
    })()
  }

  return faces
}

/** Where rendered cards are kept between requests. */
function cacheDir(): string {
  return frameworkPath.storagePath('framework/cache/og')
}

/**
 * The cache key for a card.
 *
 * Hashed from what the card *says* rather than from the URL it was asked for.
 * A repository renamed, an issue retitled, a description edited - each changes
 * the copy and so changes the key, and the new card is drawn on the next
 * request with nothing to invalidate by hand. The old file is orphaned rather
 * than overwritten, which is the right trade for a directory of 40 KB files
 * that can be deleted wholesale at any time.
 */
export function cardKey(copy: CardCopy): string {
  return createHash('sha256')
    .update(JSON.stringify([copy.eyebrow, copy.title, copy.subtitle ?? '']))
    .digest('hex')
    .slice(0, 32)
}

/** The shared half of the card: palette, brand, faces. Read from config. */
async function base(): Promise<Omit<SocialCardOptions, 'title'>> {
  const { title, body } = await fonts()
  const background = images.background

  return {
    titleFont: title,
    bodyFont: body,
    brand: images.brand,
    // Deliberately no mark: `drawMark` takes a painter, and decoding the mark
    // PNG per request to place a 48-pixel square is work for a detail nobody
    // looking at a preview in a chat window can resolve. The wordmark carries
    // the brand on its own.
    surface: background && {
      color: background.color ? parseColor(background.color) : undefined,
      gradient: background.gradient && {
        angle: background.gradient.angle,
        stops: background.gradient.stops.map(stop => ({ offset: stop.offset, color: parseColor(stop.color) })),
      },
      glows: background.glows?.map(glow => ({ ...glow, color: parseColor(glow.color) })),
    },
    color: images.color ? parseColor(images.color) : undefined,
    mutedColor: images.mutedColor ? parseColor(images.mutedColor) : undefined,
    accent: images.accent ? parseColor(images.accent) : undefined,
    format: 'png',
    width: 1200,
    height: 630,
  }
}

/**
 * Draw a card, or hand back the one already drawn for this copy.
 *
 * The bytes are returned rather than a path, and the cache is written after
 * the caller already has them: a scraper waiting on a preview should not also
 * be waiting on a disk write, and a failed write means the next request draws
 * it again rather than that this one fails.
 */
export async function cardFor(copy: CardCopy): Promise<{ bytes: Uint8Array, key: string }> {
  const key = cardKey(copy)
  const file = join(cacheDir(), `${key}.png`)

  try {
    const cached = await readFile(file)

    return { bytes: new Uint8Array(cached), key }
  }
  catch {
    // Not drawn yet, or the cache directory has been wiped. Both mean "draw
    // it", and neither is worth distinguishing.
  }

  const bytes = await renderSocialCard({
    ...(await base()),
    eyebrow: copy.eyebrow,
    title: copy.title,
    subtitle: copy.subtitle,
  })

  void mkdir(cacheDir(), { recursive: true })
    .then(() => writeFile(file, bytes))
    .catch(() => {
      // A read-only or full disk costs a redraw per request, not a failure.
    })

  return { bytes, key }
}

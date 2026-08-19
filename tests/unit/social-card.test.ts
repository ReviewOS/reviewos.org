// The cards a link to this site renders as, and the tags that point at them.
//
// The failure this guards against is silent by construction: nothing on this
// site renders its own `og:image`, so a card that is missing, mis-sized, or
// pointed at a path that does not exist looks exactly like a card that works
// until somebody posts a link somewhere.

import { afterAll, describe, expect, test } from 'bun:test'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import images, { SOCIAL_OUTPUT_DIR, SOCIAL_PAGES } from '../../config/images'
import { cardKey } from '../../app/Actions/Og/card'
import {
  CARD_HEIGHT,
  CARD_WIDTH,
  DEFAULT_CARD,
  noIndex,
  pageMeta,
  runtimeCard,
  socialCard,
  shortenForPreview,
} from '../../resources/functions/meta'

/** The repository root, which the generators resolve their inputs against. */
const projectRoot = resolve(import.meta.dir, '../..')

/** PNG width and height are big-endian 32-bit words at byte 16 of the IHDR. */
async function dimensions(path: string): Promise<[number, number]> {
  const bytes = await Bun.file(path).arrayBuffer()
  const header = new DataView(bytes)

  return [header.getUint32(16), header.getUint32(20)]
}

describe('the generated cards', () => {
  test('one exists for every route that declares one, at the size the tags claim', async () => {
    // Every card, not a sample: the whole point of generating one per page is
    // that a page which quietly stopped producing one is invisible otherwise.
    for (const page of SOCIAL_PAGES) {
      const url = socialCard(page.path)
      const file = `${SOCIAL_OUTPUT_DIR}${url.slice(url.indexOf('/', 1))}`

      expect(await Bun.file(file).exists()).toBe(true)
      expect(await dimensions(file)).toEqual([CARD_WIDTH, CARD_HEIGHT])
    }
  }, 30_000)

  test('the site card is the fallback for a page that declares none', () => {
    expect(socialCard('/nothing/here')).toBe(DEFAULT_CARD)
    expect(socialCard('/')).toBe(DEFAULT_CARD)
  })

  test('the mark and the faces the generator needs are in the repository', async () => {
    // A font resolved off the machine renders differently in CI than on a
    // laptop, which is the one thing a committed image must not do.
    expect(await Bun.file(images.fonts!.title).exists()).toBe(true)
    expect(await Bun.file(images.fonts!.body!).exists()).toBe(true)
    expect(await Bun.file(images.mark!).exists()).toBe(true)
  })

  test('and no em-dashes in the copy, which is a house rule and a design tell', () => {
    for (const page of SOCIAL_PAGES)
      expect(`${page.eyebrow} ${page.title} ${page.subtitle}`).not.toMatch(/[—–]/)
  })
})

describe('the tags that point at them', () => {
  test('the landing page names an image, its size, and what it shows', async () => {
    // Size matters to the receiver: without it some platforms fetch the image
    // before deciding whether to show a large card, and slow fetches lose.
    const page = await Bun.file('resources/views/index.stx').text()

    expect(page).toContain('property="og:image"')
    expect(page).toContain('og:image:width')
    expect(page).toContain('og:image:height')
    expect(page).toContain('name="twitter:image"')
    expect(page).toContain('og:image:alt')
  })

  test('and so does every other page, through one of the two layouts', async () => {
    for (const layout of ['marketing', 'app']) {
      const source = await Bun.file(`resources/views/layouts/${layout}.stx`).text()

      expect(source).toContain('og:image')
      expect(source).toContain('og:image:width')
      expect(source).toContain('rel="canonical"')
      expect(source).toContain('name="robots"')
      // `summary` renders a small square thumbnail no matter how good the card
      // is, and it is the default.
      expect(source).toContain('content="summary_large_image"')
    }
  })

  test('exactly one og:image per layout, because a second one is read as a gallery', async () => {
    for (const layout of ['marketing', 'app']) {
      const source = await Bun.file(`resources/views/layouts/${layout}.stx`).text()

      expect(source.match(/<meta property="og:image"/g)?.length).toBe(1)
    }
  })

  test('every view says what it is, in a title and a description', async () => {
    const views = new Bun.Glob('resources/views/**/*.stx')

    for await (const file of views.scan('.')) {
      // The layouts declare the tags; the docs views hand back a document
      // bunpress rendered, head and all; the landing page writes its own head.
      if (file.includes('/layouts/') || file.includes('/docs/') || file === 'resources/views/index.stx')
        continue

      const source = await Bun.file(file).text()

      expect(source).toInclude('@section(\'title\'')
      expect(source).toInclude('@section(\'description\'')
    }
  })
})

describe('the favicon', () => {
  // There was none: nothing declared one, `public/` held no `favicon.ico`, and
  // every tab carried the browser's blank-page glyph. The failure is silent in
  // exactly the way a card's is - the page works, it just has no identity.
  const files = ['favicon.svg', 'favicon.ico', 'apple-touch-icon.png', 'site.webmanifest', 'favicon-32x32.png', 'favicon-192x192.png', 'favicon-512x512.png']

  test('every file the tags name is in public/', async () => {
    for (const file of files)
      expect(await Bun.file(`public/${file}`).exists()).toBe(true)
  })

  test('the apple-touch icon is the 180px square iOS asks for', async () => {
    expect(await dimensions('public/apple-touch-icon.png')).toEqual([180, 180])
  })

  test('the manifest names this application rather than the generator default', async () => {
    // It said "App", with a theme colour belonging to no brand, until
    // `config/images.ts` could declare one.
    const manifest = await Bun.file('public/site.webmanifest').json()

    expect(manifest.name).toBe('ReviewOS')
    expect(manifest.theme_color).toBe('#0c1113')
    expect(manifest.icons.map((icon: { src: string }) => icon.src)).toEqual([
      '/favicon-192x192.png',
      '/favicon-512x512.png',
    ])
  })

  test('and every page declares them, through a layout or its own head', async () => {
    for (const page of ['resources/views/layouts/marketing.stx', 'resources/views/layouts/app.stx', 'resources/views/index.stx']) {
      const source = await Bun.file(page).text()

      expect(source).toContain('rel="icon" href="/favicon.svg"')
      expect(source).toContain('rel="apple-touch-icon"')
      expect(source).toContain('rel="manifest"')
    }
  })

  test('the docs site declares the same three, absolutely', async () => {
    // bunpress prefixes root-relative hrefs with its base path, so `/favicon.svg`
    // becomes `/docs/favicon.svg` - a file that does not exist.
    const source = await Bun.file('config/docs.ts').text()

    expect(source).toContain('https://reviewos.org/favicon.svg')
    expect(source).toContain('https://reviewos.org/apple-touch-icon.png')
  })
})

describe('the committed imagery', () => {
  /*
   * The drift check, and the reason the cards are committed at all.
   *
   * `buddy generate:images` runs when somebody remembers, not as part of the
   * deploy: `config/cloud.ts` ships `public/` as it is committed. So a headline
   * edited in `config/images.ts` - or in the marketing catalog it derives from -
   * changes what every card *should* say and changes nothing about what is
   * served, and the only symptom is a preview quoting copy the page no longer
   * has. Nothing fails, which is exactly the failure.
   *
   * The generator is byte-deterministic from the same inputs, so regenerating
   * into a temporary directory and comparing is the whole check. Run
   * `./buddy generate:images` and commit what changes.
   */
  const scratch = join(tmpdir(), 'reviewos-image-drift')

  afterAll(async () => {
    await rm(scratch, { recursive: true, force: true })
  })

  test('is what the generator produces today', async () => {
    const { generateAppIconSet, generateSocialCardSet } = await import('@stacksjs/image')

    // The same declaration, written somewhere disposable. Everything else -
    // the palette, the faces, the mark, the page list - is the config's own,
    // so this compares the committed output against the current inputs rather
    // than against a second description of them.
    const redirected = {
      ...images,
      social: { ...images.social!, outputDir: join(scratch, 'social') },
      appIcons: { ...images.appIcons!, faviconDir: join(scratch, 'icons') },
    }

    const cards = await generateSocialCardSet(redirected, projectRoot)
    const icons = await generateAppIconSet(redirected, projectRoot)

    const stale: string[] = []

    for (const written of [...cards.flatMap(card => Object.values(card.files)), ...icons.favicons.map(icon => icon.path)]) {
      const committed = join(projectRoot, written.startsWith(join(scratch, 'social'))
        ? SOCIAL_OUTPUT_DIR
        : 'public', basename(written))

      const fresh = new Uint8Array(await Bun.file(written).arrayBuffer())
      const onDisk = await Bun.file(committed).exists()
        ? new Uint8Array(await Bun.file(committed).arrayBuffer())
        : new Uint8Array()

      if (fresh.byteLength !== onDisk.byteLength || !fresh.every((byte, index) => byte === onDisk[index]))
        stale.push(committed.replace(`${projectRoot}/`, ''))
    }

    expect(stale).toEqual([])
  }, 60_000)
})

describe('what a page tells a scraper', () => {
  test('a repository, a pull request, an issue and a profile are drawn on demand', () => {
    expect(runtimeCard('/owner/repository')).toContain('/api/og?path=')
    expect(runtimeCard('/owner/repository/pull/12')).toContain('pull')
    expect(runtimeCard('/owner')).toContain('/api/og?path=')
  })

  test('and a route that is not about one of those is not', () => {
    // Otherwise every marketing page pays a request and a cache entry per
    // scrape to be told the same generic card it already had.
    expect(runtimeCard('/features/fast-diffs')).toBeUndefined()
    expect(runtimeCard('/settings/profile')).toBeUndefined()
    expect(runtimeCard('/docs/install')).toBeUndefined()
    // The wire protocol, not a page.
    expect(runtimeCard('/owner/repository.git/info/refs')).toBeUndefined()
  })

  test('the canonical URL drops the query, so filters do not fork the page', () => {
    expect(pageMeta({ path: '/explore?page=2&sort=stars' }).canonical).toBe('https://reviewos.org/explore')
    expect(pageMeta({ path: '/features/' }).canonical).toBe('https://reviewos.org/features')
  })

  test('personal pages and unbounded views stay out of an index', () => {
    for (const path of ['/settings/profile', '/notifications', '/login', '/owner/repo/compare/a...b', '/owner/repo/tree/main/src'])
      expect(noIndex(path)).toBe(true)

    for (const path of ['/', '/features', '/for/open-source', '/owner/repo', '/owner/repo/issues'])
      expect(noIndex(path)).toBe(false)
  })

  test('a page that says nothing still gets the whole set', () => {
    const meta = pageMeta()

    expect(meta.title).toBeTruthy()
    expect(meta.description).toBeTruthy()
    expect(meta.image).toStartWith('https://reviewos.org/')
    expect(meta.imageAlt).toBeTruthy()
  })
})

describe('the on-demand card', () => {
  test('is keyed on what it says, so retitling something redraws it', () => {
    const before = cardKey({ eyebrow: 'owner/repo', title: 'A name', subtitle: 'Open' })
    const same = cardKey({ eyebrow: 'owner/repo', title: 'A name', subtitle: 'Open' })
    const after = cardKey({ eyebrow: 'owner/repo', title: 'Another name', subtitle: 'Open' })

    expect(before).toBe(same)
    expect(after).not.toBe(before)
  })
})

describe('description copy', () => {
  test('is cut on a word boundary and marked, rather than stopping mid-word', () => {
    const long = 'Review threads that follow a line through a rebase, stacked pull requests that retarget themselves, and a diff that stays readable at a hundred files.'
    const short = shortenForPreview(long, 60)

    expect(short.length).toBeLessThanOrEqual(63)
    expect(short).toEndWith('...')
    expect(long).toStartWith(short.slice(0, -3))
  })

  test('leaves a description that already fits completely alone', () => {
    expect(shortenForPreview('Short enough.', 60)).toBe('Short enough.')
  })
})

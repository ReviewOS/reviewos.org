// The cards a link to this site renders as, and the tags that point at them.
//
// The failure this guards against is silent by construction: nothing on this
// site renders its own `og:image`, so a card that is missing, mis-sized, or
// pointed at a path that does not exist looks exactly like a card that works
// until somebody posts a link somewhere.

import { describe, expect, test } from 'bun:test'
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

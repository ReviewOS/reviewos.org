// The card a link to this site renders as, and the tags that point at it.
//
// The failure this guards against is silent by construction: nothing on this
// site renders `og:image`, so a card that is missing, mis-sized, or pointed at
// a path that does not exist looks exactly like a card that works until
// somebody posts a link somewhere.

import { describe, expect, test } from 'bun:test'
import { CARD_HEIGHT, CARD_WIDTH, DEFAULT_CARD, renderCard } from '../../app/Social/card'

describe('the card', () => {
  const html = renderCard()

  test('carries the copy it is supposed to say', () => {
    expect(html).toContain(DEFAULT_CARD.title)
    expect(html).toContain(DEFAULT_CARD.subtitle)
    expect(html).toContain('reviewos.org')
  })

  test('is the size every platform crops from', () => {
    expect([CARD_WIDTH, CARD_HEIGHT]).toEqual([1200, 630])
    expect(html).toContain('width: 1200px')
    expect(html).toContain('height: 630px')
  })

  /*
   * A generator that reaches the network renders differently depending on
   * whether it could, and the difference is a font nobody notices until the
   * card is already out there.
   */
  test('asks for nothing over the network', () => {
    expect(html).not.toContain('http://')
    expect(html).not.toContain('https://')
    expect(html).not.toContain('@import')
  })

  test('escapes what it is given, because copy comes from outside this file', () => {
    const card = renderCard({ ...DEFAULT_CARD, title: '<script>alert(1)</script>' })

    expect(card).not.toContain('<script>alert(1)</script>')
    expect(card).toContain('&lt;script&gt;')
  })

  test('and no em-dashes, which is a house rule and a design tell', () => {
    expect(`${DEFAULT_CARD.title} ${DEFAULT_CARD.subtitle} ${DEFAULT_CARD.eyebrow}`).not.toMatch(/[—–]/)
  })
})

describe('the tags that point at it', () => {
  test('the landing page names an image, its size, and what it shows', async () => {
    // Size matters to the receiver: without it some platforms fetch the image
    // before deciding whether to show a large card, and slow fetches lose.
    const page = await Bun.file('resources/views/index.stx').text()

    expect(page).toContain('property="og:image" content="https://reviewos.org/images/og.png"')
    expect(page).toContain('content="1200"')
    expect(page).toContain('content="630"')
    expect(page).toContain('name="twitter:image"')
    expect(page).toContain('og:image:alt')
  })

  test('and so does every marketing page, through the shared layout', async () => {
    const layout = await Bun.file('resources/views/layouts/marketing.stx').text()

    expect(layout).toContain('og:image')
    expect(layout).toContain('twitter:card')
  })

  test('the image the tags name exists, at the size they claim', async () => {
    // An absolute URL in a meta tag cannot be resolved by a test, so this
    // checks the file those URLs are served from. A card is 1200x630 or it is
    // cropped by whoever renders it.
    const png = await Bun.file('public/images/og.png').arrayBuffer()

    expect(png.byteLength).toBeGreaterThan(10_000)

    // PNG width and height are big-endian 32-bit words at byte 16 of the IHDR.
    const header = new DataView(png)

    expect(header.getUint32(16)).toBe(CARD_WIDTH)
    expect(header.getUint32(20)).toBe(CARD_HEIGHT)
  })
})

#!/usr/bin/env bun
/**
 * Draw the ReviewOS mark: `public/images/mark.png` and `public/favicon.svg`.
 *
 * The mark was drawn in CSS and nowhere else - `.nav-mark` in the two layouts,
 * a rounded square with two bars in it - which is fine for a navigation bar
 * and no use to anything that needs a file. A social card wants a raster to
 * composite, a browser tab wants vector artwork, and a home screen wants a
 * whole set of PNGs. All three come from here, off the same numbers the CSS
 * uses: an 18px square with a 5px radius, two 2px bars inset 5px from the top
 * and 4px from the sides, 4px apart.
 *
 * The PNG is the source `buddy generate:images` resizes into `favicon.ico`,
 * the apple-touch icon and the manifest's icons. The SVG is what a modern
 * browser prefers for a tab: it is crisp at 16px and at 512px, and it is
 * about 300 bytes.
 *
 * **Committed rather than generated with the cards.** `buddy generate:images`
 * reads the mark as an input, so producing it in the same run would be an
 * ordering problem for the sake of a file that changes when the logo does,
 * which is approximately never. Re-run this if the mark changes:
 *
 *     bun scripts/brand-mark.ts
 *     ./buddy generate:images --app-icons
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import process from 'node:process'
import { createImageData, encode, fillRoundedRect } from 'ts-images'

/**
 * The mark's edge, in pixels.
 *
 * Larger than any card draws it. A card places the mark at around 4% of its
 * width - 48px on the 1200px card - and downscaling a clean raster is free
 * where upscaling is not.
 */
const SIZE = 512

/** `--accent` in the dark palette, which is the palette the cards use. */
const TEAL = { r: 0x4E, g: 0xC5, b: 0xC9 }

/** `--on-accent`: the colour the bars are drawn in over the teal. */
const ON_ACCENT = { r: 0x08, g: 0x20, b: 0x1F }

async function main(): Promise<void> {
  // Transparent, not filled: the card composites this over whatever the
  // background happens to be, and a mark on its own opaque square would show
  // its corners against the field it is meant to sit on.
  const mark = createImageData(SIZE, SIZE, { hasAlpha: true })

  // The CSS square is 18px with a 5px radius. Everything below is that
  // proportion times SIZE, so the file and the navigation stay the same shape
  // when either is resized.
  fillRoundedRect(mark, { x: 0, y: 0, width: SIZE, height: SIZE, radius: SIZE * (5 / 18) }, TEAL)

  // Two bars: the lines of a diff, which is what the whole product is about.
  // `inset: 5px 4px auto 4px; height: 2px` plus a second one 4px below it.
  const barX = SIZE * (4 / 18)
  const barWidth = SIZE * (10 / 18)
  const barHeight = SIZE * (2 / 18)
  const barRadius = barHeight / 2

  for (const top of [5 / 18, 9 / 18]) {
    fillRoundedRect(
      mark,
      { x: barX, y: SIZE * top, width: barWidth, height: barHeight, radius: barRadius },
      ON_ACCENT,
    )
  }

  const out = resolve(import.meta.dir, '../public/images/mark.png')
  await mkdir(dirname(out), { recursive: true })
  await writeFile(out, await encode(mark, 'png'))

  console.log(`Wrote ${out} (${SIZE}x${SIZE})`)

  const icon = resolve(import.meta.dir, '../public/favicon.svg')
  await writeFile(icon, faviconSvg())

  console.log(`Wrote ${icon}`)
}

/**
 * The same mark as vector artwork, for the browser tab.
 *
 * On an 18-unit viewBox, so the numbers below are the CSS's own rather than a
 * translation of them - the one place the two could drift is the one place
 * they now cannot.
 *
 * No `prefers-color-scheme` inside it, deliberately. A tab strip is not the
 * page, and Safari in particular renders a monochrome mask from this in some
 * contexts; a mark that changes colour with the reader's theme is a mark that
 * disappears in one of them. Teal reads on a light strip and on a dark one.
 */
function faviconSvg(): string {
  const bar = (y: number): string =>
    `<rect x="4" y="${y}" width="10" height="2" rx="1" fill="#08201f"/>`

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18" width="18" height="18">`
    + `<title>ReviewOS</title>`
    + `<rect width="18" height="18" rx="5" fill="#4ec5c9"/>`
    + `${bar(5)}${bar(9)}`
    + `</svg>\n`
}

await main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})

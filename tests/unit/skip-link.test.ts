import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Every document that draws the site navigation offers a way past it.
 *
 * A repository screen opens with the top bar, then the repository header, then
 * six tabs - about twenty controls before the first line of what somebody came
 * to read, and a person navigating with a keyboard passed all of them on every
 * page, every time.
 *
 * Three documents draw that chrome, not one: both layouts and `index.stx`,
 * which carries its own `<html>` rather than using a layout. That is exactly
 * the shape of thing that gets fixed in two places out of three, so the test
 * names all three.
 */

const DOCUMENTS = [
  'resources/views/layouts/app.stx',
  'resources/views/layouts/marketing.stx',
  'resources/views/index.stx',
]

describe.each(DOCUMENTS)('%s', (relative) => {
  const source = readFileSync(resolve(import.meta.dir, '../..', relative), 'utf8')

  it('offers a skip link before the navigation', () => {
    expect(source).toContain('<a class="skip-link" href="#content">')

    const link = source.indexOf('class="skip-link"')
    const nav = source.indexOf('<SiteNav />')

    // Before the nav in source order, because that is what tab order follows.
    expect(link).toBeGreaterThan(-1)
    expect(nav).toBeGreaterThan(-1)
    expect(link).toBeLessThan(nav)
  })

  it('and something for it to land on', () => {
    expect(source).toContain('<main id="content" tabindex="-1">')
  })

  /*
   * `display: none` would take it out of the tab order, which is the one thing
   * it exists to be in. It has to be positioned away and brought back on focus.
   */
  it('which is reachable rather than hidden', () => {
    expect(source).toMatch(/\.skip-link\s*\{[^}]*position:\s*absolute/)
    expect(source).not.toMatch(/\.skip-link\s*\{[^}]*display:\s*none/)
    expect(source).toMatch(/\.skip-link:focus\s*\{/)
  })
})

// A build's colours, and the one dangerous sentence in the module under test:
// it returns HTML.
//
// Every branch either emits a tag the module wrote or text it escaped, and this
// file is where that claim is checked - with the awkward inputs, because the
// text came off a machine running somebody's code and "it looked fine on my
// build" is not a security argument.

import { describe, expect, test } from 'bun:test'
import { escapeHtml, hasAnsi, renderAnsi } from '../../app/Actions/Runner/ansi'

/** The escape character, built rather than typed, so this file stays readable. */
const ESC = String.fromCharCode(27)
const sgr = (codes: string) => `${ESC}[${codes}m`

describe('colour', () => {
  test('a coloured run becomes a span, and the colour is a class a theme can set', () => {
    const html = renderAnsi(`${sgr('31')}failed${sgr('0')}`)

    expect(html).toContain('ansi-red')
    expect(html).toContain('failed')
    // Never an inline style: a log page that hardcodes #ff0000 is unreadable in
    // the theme the reader actually chose.
    expect(html).not.toContain('style=')
  })

  test('the escapes themselves never reach the page', () => {
    // Leaving them as text is worse than stripping them: `[0;31m` in front of
    // every line is noise nobody can turn off.
    expect(renderAnsi(`${sgr('32')}ok${sgr('0')}`)).not.toContain('[32m')
    expect(renderAnsi(`${sgr('32')}ok${sgr('0')}`)).not.toContain(ESC)
  })

  test('bold, dim, italic and underline each survive', () => {
    const html = renderAnsi(`${sgr('1')}b${sgr('2')}d${sgr('3')}i${sgr('4')}u`)

    for (const kind of ['ansi-bold', 'ansi-dim', 'ansi-italic', 'ansi-underline'])
      expect(html).toContain(kind)
  })

  /*
   * The "off" codes matter more than they look. A build that turns bold off
   * mid-line means it, and a renderer that only understands a full reset leaves
   * the rest of the line shouting.
   */
  test('turning an attribute off turns it off', () => {
    const html = renderAnsi(`${sgr('1')}loud${sgr('22')}quiet`)
    const after = html.slice(html.indexOf('quiet') - 40)

    expect(after).not.toContain('ansi-bold')
  })

  test('a background is its own class, not the foreground one', () => {
    expect(renderAnsi(`${sgr('41')}x`)).toContain('ansi-bg-red')
  })

  test('several parameters in one escape all apply', () => {
    const html = renderAnsi(`${sgr('1;31')}x`)

    expect(html).toContain('ansi-bold')
    expect(html).toContain('ansi-red')
  })

  /*
   * Everything that is not colour describes a terminal that does not exist
   * here. A log that redraws itself is one nobody can scroll back through, so
   * cursor movement is dropped rather than rendered.
   */
  test('a cursor sequence is dropped rather than printed', () => {
    const html = renderAnsi(`before${ESC}[2Kafter`)

    expect(html).toContain('before')
    expect(html).toContain('after')
    expect(html).not.toContain('2K')
  })
})

describe('what the log cannot do to the page', () => {
  test('markup in build output is text', () => {
    const html = renderAnsi('<script>alert(1)</script>')

    expect(html).toContain('&lt;script&gt;')
    expect(html).not.toContain('<script>')
  })

  test('quotes are escaped too, because this text lands inside attributes', () => {
    expect(escapeHtml(`" '`)).toBe('&quot; &#39;')
  })

  test('a link is only ever http or https', () => {
    // The one thing a log must not be able to do is hand the reader a
    // `javascript:` URL dressed as a build artefact.
    const html = renderAnsi('javascript:alert(1) and data:text/html,<b>x</b>')

    expect(html).not.toContain('<a')
  })

  test('a real URL becomes a link that this instance does not vouch for', () => {
    const html = renderAnsi('see https://example.com/report for details')

    expect(html).toContain('<a href="https://example.com/report"')
    expect(html).toContain('rel="noreferrer nofollow noopener"')
  })

  test('and trailing punctuation stays out of the href', () => {
    // "see https://example.com/report." is a sentence, not a URL ending in a
    // full stop, and a link that 404s teaches people not to click them.
    const html = renderAnsi('see https://example.com/report.')

    expect(html).toContain('href="https://example.com/report"')
    expect(html).toContain('>https://example.com/report</a>.')
  })

  test('a URL with markup in it is still escaped first', () => {
    const html = renderAnsi('https://example.com/"><script>alert(1)</script>')

    expect(html).not.toContain('<script>')
  })
})

describe('hasAnsi', () => {
  test('says whether there is any work to do', () => {
    expect(hasAnsi(`${sgr('31')}x`)).toBe(true)
    expect(hasAnsi('plain output')).toBe(false)
  })
})

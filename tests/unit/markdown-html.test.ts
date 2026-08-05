// The raw HTML tokenizer and its allowlist.
//
// `markdown-render.test.ts` covers what a reader ends up looking at. This file
// covers the layer underneath it, where the interesting failures are: a
// tokenizer that disagrees with a browser about where a tag starts is how an
// allowlist gets walked past, and no amount of end-to-end testing finds that
// disagreement because the payload that exploits it is the one nobody wrote.

import { describe, expect, test } from 'bun:test'
import { buildOpenTag, createHtmlWriter, tokenizeHtml } from '../../app/Actions/Markdown/html'

/** Text runs pass through unchanged, so the writer's own output is visible. */
function write(source: string): string {
  const writer = createHtmlWriter()

  return writer.write(source, text => text) + writer.close()
}

describe('tokenizeHtml', () => {
  test('splits a tag out of the text around it', () => {
    expect(tokenizeHtml('a <br> b')).toEqual([
      { kind: 'text', text: 'a ' },
      { kind: 'open', name: 'br', attributes: [], selfClosing: false },
      { kind: 'text', text: ' b' },
    ])
  })

  test('lowercases the name, so one spelling reaches the allowlist', () => {
    expect(tokenizeHtml('<KBD>')[0]).toMatchObject({ kind: 'open', name: 'kbd' })
    expect(tokenizeHtml('</KBD>')[0]).toEqual({ kind: 'close', name: 'kbd' })
  })

  /**
   * The browser's rule, and the one a regex usually gets wrong: `<` opens a tag
   * only when a letter follows it. Everything else is a less-than sign that
   * somebody typed.
   */
  test('a less-than sign that is not a tag stays text', () => {
    expect(tokenizeHtml('a < b and 3 <5 and 2</3')).toEqual([
      { kind: 'text', text: 'a < b and 3 <5 and 2</3' },
    ])
  })

  test('reads all three ways of quoting an attribute', () => {
    expect(tokenizeHtml('<div align="center" dir=\'rtl\' data-x=y>')[0]).toEqual({
      kind: 'open',
      name: 'div',
      attributes: [['align', 'center'], ['dir', 'rtl'], ['data-x', 'y']],
      selfClosing: false,
    })
  })

  test('reads a bare attribute as present with no value', () => {
    expect(tokenizeHtml('<details open>')[0]).toMatchObject({
      attributes: [['open', null]],
    })
  })

  test('reads both spellings of a self-closing tag', () => {
    expect(tokenizeHtml('<br/>')[0]).toMatchObject({ selfClosing: true })
    expect(tokenizeHtml('<br />')[0]).toMatchObject({ selfClosing: true })
  })

  test('a tag with no closing bracket is text, because that is how it renders', () => {
    expect(tokenizeHtml('trailing <div align="x')).toEqual([
      { kind: 'text', text: 'trailing <div align="x' },
    ])
  })

  test('drops comments, doctypes, CDATA and processing instructions', () => {
    for (const source of ['<!-- hi -->', '<!DOCTYPE html>', '<![CDATA[x]]>', '<?php echo 1; ?>'])
      expect(tokenizeHtml(source)).toEqual([{ kind: 'drop' }])
  })

  /** A comment that never ends takes the rest of the run with it, as it would. */
  test('an unterminated comment does not leak what follows it', () => {
    expect(tokenizeHtml('<!-- <script>alert(1)</script>')).toEqual([{ kind: 'drop' }])
  })

  test('a quoted attribute value may contain a closing bracket', () => {
    expect(tokenizeHtml('<div align="a>b">x')[0]).toMatchObject({
      attributes: [['align', 'a>b']],
    })
  })
})

describe('buildOpenTag', () => {
  test('builds an element the allowlist names', () => {
    expect(buildOpenTag('kbd', [])).toEqual({ kind: 'tag', html: '<kbd>', empty: false })
  })

  test('rejects an element it does not', () => {
    expect(buildOpenTag('iframe', [['src', 'https://evil.example']]).kind).toBe('reject')
    expect(buildOpenTag('script', []).kind).toBe('reject')
    expect(buildOpenTag('form', []).kind).toBe('reject')
    expect(buildOpenTag('svg', []).kind).toBe('reject')
  })

  /**
   * The property the whole design rests on. There is no list of forbidden
   * attributes anywhere, because nothing copies an attribute across: the output
   * is assembled from the names the rule for that element declares, so an
   * attribute nobody declared cannot appear however it is spelled.
   */
  test('carries only the attributes its element declares', () => {
    const built = buildOpenTag('div', [
      ['align', 'center'],
      ['onclick', 'alert(1)'],
      ['style', 'position:fixed'],
      ['id', 'nav'],
      ['class', 'shell'],
    ])

    expect(built).toEqual({ kind: 'tag', html: '<div align="center">', empty: false })
  })

  test('an alignment outside the fixed set is left out', () => {
    expect(buildOpenTag('div', [['align', 'center" onmouseover="alert(1)']])).toMatchObject({
      html: '<div>',
    })
  })

  test('a dimension has to be a small number', () => {
    expect(buildOpenTag('img', [['src', 'a.png'], ['width', '200']])).toMatchObject({
      html: '<img src="a.png" width="200" loading="lazy">',
    })
    expect(buildOpenTag('img', [['src', 'a.png'], ['width', '99999']])).toMatchObject({
      html: '<img src="a.png" loading="lazy">',
    })
  })

  test('alt text cannot break out of its attribute', () => {
    const built = buildOpenTag('img', [['src', 'a.png'], ['alt', 'x" onerror="alert(1)']])

    expect(built).toMatchObject({ kind: 'tag' })
    expect((built as any).html).not.toContain('onerror="alert')
  })

  test('a URL attribute gets the same check a markdown link gets', () => {
    expect(buildOpenTag('a', [['href', 'javascript:alert(1)']]).kind).toBe('elide')
    expect(buildOpenTag('a', [['href', '&#106;avascript:alert(1)']]).kind).toBe('elide')
    expect(buildOpenTag('img', [['src', 'javascript:alert(1)']]).kind).toBe('elide')
  })

  test('an element with no URL attribute at all is left alone', () => {
    // `<a name="x">` is an old-fashioned anchor, not a link that failed.
    expect(buildOpenTag('a', [['name', 'x']])).toEqual({ kind: 'tag', html: '<a>', empty: false })
  })

  test('keeps the first of a repeated attribute, as a browser does', () => {
    expect(buildOpenTag('div', [['align', 'center'], ['align', 'right']])).toMatchObject({
      html: '<div align="center">',
    })
  })
})

describe('balance', () => {
  test('emits a close tag for an element it opened', () => {
    expect(write('<b>x</b>')).toBe('<b>x</b>')
  })

  test('shows a close tag it never opened as text', () => {
    expect(write('</div>')).toBe('&lt;/div&gt;')
  })

  test('closes what the document left open', () => {
    expect(write('<details><summary>x</summary>')).toBe('<details><summary>x</summary></details>')
  })

  test('closes the inner elements when an outer one closes', () => {
    expect(write('<b><i>x</b>')).toBe('<b><i>x</i></b>')
  })

  test('an empty element is never closed', () => {
    expect(write('<br>text')).toBe('<br>text')
  })

  test('an element closed inline is not closed again at the end', () => {
    expect(write('<span/>text')).toBe('<span>text')
  })

  test('an elided element leaves no closing tag behind', () => {
    expect(write('<a href="javascript:alert(1)">click</a>')).toBe('click')
  })

  /**
   * The one that matters if this is ever reached with a document a reader did
   * not write. Nothing a body can contain may end the element the rendered
   * markdown is placed in.
   */
  test('no run of close tags can escape the container', () => {
    const escaped = write('</p></div></article></body></html><script>alert(1)</script>')

    expect(escaped).not.toContain('</div>')
    expect(escaped).not.toContain('<script')
  })
})

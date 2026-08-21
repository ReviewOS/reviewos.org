/**
 * The first screen is not fetched, and what the server sent is what is shown.
 *
 * "Partial hydration" is usually a story about markup in the document being
 * adopted by a client framework. This viewer's answer is a different shape and
 * a better fit for what it does: the server parses the diff *once* to build the
 * manifest, renders the first files' rows while it is there, and sends them on
 * the same stream as the file records. By the time the virtualizer lays out
 * file three, file three's rows are usually already in hand.
 *
 * Two properties follow, and both are worth pinning because both are silent
 * when broken.
 *
 * **No second request for the first screen.** A viewer that laid out the first
 * files and then asked for their rows would show a screen of placeholders on
 * every load, on every diff, and it would look exactly like the server being
 * slow rather than like the client asking twice.
 *
 * **The markup is used verbatim.** The rows above the fold are then the *same
 * markup* as the rows below it, from one renderer. A second rendering path for
 * the first screen is how a diff comes to have one appearance above the fold
 * and another below it, which nobody notices until it is everywhere.
 *
 * The reflow half of the box - hydrated "without a reflow" - is the browser
 * probe's, for the same reason element pooling is: it is a claim about real
 * elements in a real layout, and there is no layout in this suite.
 */

import { describe, expect, test } from 'bun:test'
import { serverMarkup, streamDiffManifest } from '../../resources/functions/diffviewer'

/** A `Response` whose body arrives in pieces, like the manifest does. */
function streaming(chunks: string[]): Response {
  const encoder = new TextEncoder()

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks)
        controller.enqueue(encoder.encode(chunk))

      controller.close()
    },
  })

  return new Response(body, { status: 200, headers: { 'content-type': 'application/x-ndjson' } })
}

const ROWS = '<table class="diff-rows"><tr class="line"><td class="code"><span class="t-keyword">const</span></td></tr></table>'

/**
 * Run something with `fetch` answering one manifest, and put it back after.
 *
 * The global rather than an injected implementation, because `streamDiffManifest`
 * takes no injection point - it is browser code and the browser has one `fetch`.
 * Restored in a `finally`, so a failing assertion does not leave every later
 * test in this process talking to a fake.
 */
async function withManifest(chunks: string[], run: () => Promise<void>): Promise<void> {
  const original = globalThis.fetch

  globalThis.fetch = (async () => streaming(chunks)) as typeof fetch

  try {
    await run()
  }
  finally {
    globalThis.fetch = original
  }
}

describe('what the server already rendered', () => {
  test('is used exactly as it arrived', () => {
    const cache = new Map([[3, { html: ROWS, layout: 'unified' as const }]])

    expect(serverMarkup(cache, 3, 'unified')).toBe(ROWS)
  })

  test('is not used in a layout it was not rendered for', () => {
    // Rows arrive as markup rather than as data, so a file rendered unified is
    // of no use in split - and showing it anyway would put a unified file in
    // the middle of a split diff.
    const cache = new Map([[3, { html: ROWS, layout: 'unified' as const }]])

    expect(serverMarkup(cache, 3, 'split')).toBeNull()
  })

  test('and a file nobody sent rows for asks for them', () => {
    expect(serverMarkup(new Map(), 3, 'unified')).toBeNull()
  })

  test('per file, so switching back does not wait for the whole list', () => {
    // The reader switched to split, three files were refetched, and then they
    // switched back. The three know their new layout; the rest still know their
    // old one, and both are usable in the layout they match.
    const cache = new Map([
      [1, { html: ROWS, layout: 'split' as const }],
      [2, { html: ROWS, layout: 'unified' as const }],
    ])

    expect(serverMarkup(cache, 1, 'split')).toBe(ROWS)
    expect(serverMarkup(cache, 1, 'unified')).toBeNull()
    expect(serverMarkup(cache, 2, 'unified')).toBe(ROWS)
  })
})

describe('the first screen arrives on the manifest', () => {
  /** A manifest carrying three files and rows for the first two. */
  const file = (i: number, path: string) => ({
    t: 'file',
    i,
    path,
    from: null,
    status: 'modified',
    binary: false,
    additions: 1,
    deletions: 0,
    hunks: 1,
    rows: 3,
  })

  const manifest = [
    `${JSON.stringify(file(0, 'a.ts'))}\n`,
    `${JSON.stringify(file(1, 'b.ts'))}\n`,
    `${JSON.stringify({ t: 'rows', i: 0, layout: 'unified', html: ROWS })}\n`,
    `${JSON.stringify({ t: 'rows', i: 1, layout: 'unified', html: ROWS })}\n`,
    `${JSON.stringify(file(2, 'c.ts'))}\n`,
    `${JSON.stringify({ t: 'end', files: 3, additions: 3, deletions: 0 })}\n`,
  ]

  test('rows come down the same stream as the files, before it ends', async () => {
    const rows: Array<{ index: number, html: string }> = []
    let ended = false

    await withManifest(manifest, () => streamDiffManifest('/manifest', {
      onFiles() {},
      onRows(index, html) {
        // The ordering assertion is the point: a row record after `end` would
        // be a first screen that arrives once the reader is already looking at
        // placeholders.
        expect(ended).toBe(false)
        rows.push({ index, html })
      },
      onEnd() {
        ended = true
      },
    }))

    expect(ended).toBe(true)
    expect(rows.map(row => row.index)).toEqual([0, 1])
  })

  test('and the markup is passed through untouched', async () => {
    const seen: string[] = []

    await withManifest(manifest, () => streamDiffManifest('/manifest', {
      onFiles() {},
      onRows(_index, html) {
        seen.push(html)
      },
      onEnd() {},
    }))

    // Not "contains the code" - identical. Anything that reshaped it here would
    // be a second renderer, which is the thing this arrangement exists to avoid.
    expect(seen).toEqual([ROWS, ROWS])
  })

  test('a file past the inline budget gets no rows, which is what the fetch is for', async () => {
    const rows: number[] = []

    await withManifest(manifest, () => streamDiffManifest('/manifest', {
      onFiles() {},
      onRows(index) {
        rows.push(index)
      },
      onEnd() {},
    }))

    // File 2 is in the manifest and has no rows: the budget stopped at two, and
    // the viewer asks for the rest as the reader reaches them.
    expect(rows).not.toContain(2)
  })
})

/**
 * The work this instance does once, before the first reader arrives.
 *
 * Measured on the 5,722 file compare: the first compare in a process took
 * 2,058ms with a worst hold of 1,080ms; the second took 920ms with a worst hold
 * of 124ms. The difference is grammar parsing and JIT, paid once per process -
 * and paid by whichever reader arrived first, who has no idea why their page
 * was a second slower than everybody else's.
 *
 * The reason this took a framework change rather than a function: there was
 * nowhere to call it from. `app/Routes.ts` is a config object and a route file
 * runs at import time, so an exported `warmHighlighter()` that nothing called
 * would have been dead code pretending to be a fix.
 */

import { describe, expect, test } from 'bun:test'
import { highlightLines, warmHighlighter } from '../../app/Actions/Browse/highlight'

describe('warming the highlighter', () => {
  test('leaves the common grammars ready, and takes about as long as one page', async () => {
    const started = performance.now()

    await warmHighlighter()

    const elapsed = performance.now() - started

    // Not a performance assertion on the machine - a bound on what boot is
    // allowed to cost. A warm-up that took seconds would be trading a slow
    // first request for a slow start, which is not a trade.
    expect(elapsed).toBeLessThan(2000)
  })

  test('and the first real highlight after it is a real highlight', async () => {
    await warmHighlighter()

    const tokens = await highlightLines(['const a = 1'], 'x.ts')

    expect(tokens[0]!.some(token => token.type === 'keyword')).toBe(true)
    expect(tokens[0]!.map(token => token.content).join('')).toBe('const a = 1')
  })

  test('never throws, because a missing colour must not stop a server', async () => {
    // Called twice, which is not something the boot hook does but is the
    // cheapest way to assert the property holds on a path where the highlighter
    // is already built.
    await warmHighlighter()

    expect(await warmHighlighter().then(() => 'returned')).toBe('returned')
  })
})

// The pack cache's parser.
//
// This decides whether a request may be answered from cache, and the only
// dangerous answer is a false positive: serving a stored pack to a client
// whose request meant something else is a corruption bug wearing a
// performance bug's clothes. So most of what is asserted here is what it
// *refuses*, and the rule it is held to is that anything not completely
// understood produces null - which means git runs, exactly as before.

import { describe, expect, test } from 'bun:test'
import { packCacheKey, parseClone, readPacketLines } from '../../app/Actions/Git/packCache'

const A = 'a'.repeat(40)
const B = 'b'.repeat(40)

/** Frame payloads the way git does, so the fixtures are real pkt-lines. */
function pkt(...payloads: string[]): Uint8Array {
  const parts: Uint8Array[] = []

  for (const payload of payloads) {
    if (payload === '') {
      parts.push(new TextEncoder().encode('0000'))

      continue
    }

    const bytes = new TextEncoder().encode(payload)
    const header = (bytes.length + 4).toString(16).padStart(4, '0')
    parts.push(new TextEncoder().encode(header), bytes)
  }

  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const joined = new Uint8Array(total)
  let at = 0

  for (const part of parts) {
    joined.set(part, at)
    at += part.length
  }

  return joined
}

describe('readPacketLines', () => {
  test('reads what git writes, flushes included', () => {
    expect(readPacketLines(pkt('want ' + A + '\n', '', 'done\n'))).toEqual([`want ${A}\n`, '', 'done\n'])
  })

  test('refuses a truncated frame rather than guessing at it', () => {
    expect(readPacketLines(new TextEncoder().encode('0032want'))).toBeNull()
    expect(readPacketLines(new TextEncoder().encode('zzzz'))).toBeNull()
    expect(readPacketLines(new TextEncoder().encode('00'))).toBeNull()
  })
})

describe('parseClone', () => {
  test('recognises a plain clone and sorts its wants', () => {
    const plan = parseClone(pkt(`want ${B} multi_ack ofs-delta\n`, `want ${A}\n`, '', 'done\n'))

    expect(plan?.wants).toEqual([A, B])
  })

  test('deduplicates wants, so two names for one tip are one key', () => {
    const plan = parseClone(pkt(`want ${A}\n`, `want ${A}\n`, '', 'done\n'))

    expect(plan?.wants).toEqual([A])
  })

  test('reads protocol v2 the same way', () => {
    const plan = parseClone(pkt('command=fetch\n', 'agent=git/2.54\n', 'object-format=sha1\n', `want ${A}\n`, 'done\n', ''))

    expect(plan?.wants).toEqual([A])
  })

  /**
   * The refusals, which are the point of the file. Each of these makes the
   * answer depend on something other than the wanted tips, so a cache hit
   * would be a pack that does not contain what the client asked for.
   */
  test('refuses a negotiated fetch', () => {
    expect(parseClone(pkt(`want ${A}\n`, `have ${B}\n`, '', 'done\n'))).toBeNull()
  })

  test('refuses shallow, deepen and filter', () => {
    expect(parseClone(pkt(`want ${A}\n`, `shallow ${B}\n`, '', 'done\n'))).toBeNull()
    expect(parseClone(pkt(`want ${A}\n`, 'deepen 1\n', '', 'done\n'))).toBeNull()
    expect(parseClone(pkt(`want ${A}\n`, 'filter blob:none\n', '', 'done\n'))).toBeNull()
    expect(parseClone(pkt(`want ${A}\n`, 'deepen-since 1700000000\n', '', 'done\n'))).toBeNull()
  })

  test('refuses a request with no wants at all', () => {
    expect(parseClone(pkt('command=ls-refs\n', ''))).toBeNull()
  })

  /**
   * The rule that makes this safe to add to the wire protocol: a line this
   * parser has never seen is a reason to run git, not a reason to guess.
   */
  test('refuses anything it does not fully understand', () => {
    expect(parseClone(pkt(`want ${A}\n`, 'some-future-extension yes\n', '', 'done\n'))).toBeNull()
    expect(parseClone(new TextEncoder().encode('not pkt-line at all'))).toBeNull()
    expect(parseClone(new Uint8Array())).toBeNull()
  })
})

describe('packCacheKey', () => {
  test('the same tips are the same key, in any order', () => {
    const one = parseClone(pkt(`want ${A}\n`, `want ${B}\n`, '', 'done\n'))!
    const other = parseClone(pkt(`want ${B}\n`, `want ${A}\n`, '', 'done\n'))!

    expect(packCacheKey(7, one)).toBe(packCacheKey(7, other))
  })

  test('different tips are different keys', () => {
    const one = parseClone(pkt(`want ${A}\n`, '', 'done\n'))!
    const other = parseClone(pkt(`want ${B}\n`, '', 'done\n'))!

    expect(packCacheKey(7, one)).not.toBe(packCacheKey(7, other))
  })

  /** One repository's pack must never be served for another's request. */
  test('different repositories are different keys', () => {
    const plan = parseClone(pkt(`want ${A}\n`, '', 'done\n'))!

    expect(packCacheKey(7, plan)).not.toBe(packCacheKey(8, plan))
  })

  /**
   * Capabilities change the encoding rather than which objects are sent, so
   * they are out of the key - otherwise every client version misses.
   */
  test('capabilities do not split the cache', () => {
    const one = parseClone(pkt(`want ${A} multi_ack ofs-delta agent=git/2.54\n`, '', 'done\n'))!
    const other = parseClone(pkt(`want ${A} thin-pack no-progress agent=git/2.39\n`, '', 'done\n'))!

    expect(packCacheKey(7, one)).toBe(packCacheKey(7, other))
  })

  test('the key is a safe blob key', async () => {
    const { isSafeKey } = await import('../../app/Actions/Git/blobs')
    const plan = parseClone(pkt(`want ${A}\n`, '', 'done\n'))!

    expect(isSafeKey(packCacheKey(7, plan))).toBe(true)
  })
})

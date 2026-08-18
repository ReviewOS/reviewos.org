// The pull-based stdout stream.
//
// The property under test is invisible in an end-to-end transfer: whether
// chunks leave the child only when the consumer asks. A fake child makes it
// visible - it counts what has been taken - and proves the two contracts the
// helper exists for: one chunk per pull, and a kill when the reader walks
// away.

import { describe, expect, test } from 'bun:test'
import type { StreamableChild } from '../../app/Actions/Git/stream'
import { stdoutStream } from '../../app/Actions/Git/stream'

/** A child whose stdout hands out numbered chunks and counts the takes. */
function fakeChild(chunks: number): StreamableChild & { taken: number, killed: boolean } {
  const child = {
    taken: 0,
    killed: false,
    kill() {
      child.killed = true

      return true
    },
    stdout: {
      async* [Symbol.asyncIterator]() {
        for (let index = 0; index < chunks; index += 1) {
          child.taken += 1
          yield new TextEncoder().encode(`chunk-${index}`)
        }
      },
    },
  }

  return child
}

describe('stdoutStream', () => {
  test('takes exactly one chunk per pull, never ahead of the reader', async () => {
    const child = fakeChild(100)
    const reader = stdoutStream(child).getReader()

    // Nothing consumed yet: nothing taken. An eager `on('data')`
    // implementation would have drained all hundred by now.
    expect(child.taken).toBe(0)

    await reader.read()
    expect(child.taken).toBe(1)

    await reader.read()
    await reader.read()
    expect(child.taken).toBe(3)

    void reader.cancel()
  })

  test('delivers every chunk, in order, then closes', async () => {
    const child = fakeChild(5)
    const reader = stdoutStream(child).getReader()
    const seen: string[] = []

    for (;;) {
      const { done, value } = await reader.read()
      if (done)
        break
      seen.push(new TextDecoder().decode(value))
    }

    expect(seen).toEqual(['chunk-0', 'chunk-1', 'chunk-2', 'chunk-3', 'chunk-4'])
  })

  test('cancel kills the child', async () => {
    const child = fakeChild(100)
    const stream = stdoutStream(child)
    const reader = stream.getReader()

    await reader.read()
    expect(child.killed).toBe(false)

    await reader.cancel()
    expect(child.killed).toBe(true)
    expect(child.taken).toBeLessThan(100)
  })

  test('a child that dies mid-stream ends the body rather than erroring it', async () => {
    const child: StreamableChild = {
      kill: () => true,
      stdout: {
        async* [Symbol.asyncIterator]() {
          yield new TextEncoder().encode('partial')
          throw new Error('killed')
        },
      },
    }

    const reader = stdoutStream(child).getReader()

    const first = await reader.read()
    expect(new TextDecoder().decode(first.value)).toBe('partial')

    // The throw arrives as a clean end: the status code went out long ago,
    // and the client's own protocol is what notices a truncated body.
    const second = await reader.read()
    expect(second.done).toBe(true)
  })
})

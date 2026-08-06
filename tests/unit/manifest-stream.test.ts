/**
 * Reading the manifest off the wire, and stopping partway.
 *
 * `readNdjson` is the piece that makes the first file usable before the last
 * one has been written, and `streamDiffManifest` is the batching over it. Both
 * are tested against a fake `Response` rather than a server: what is worth
 * pinning here is the framing and the abort, and neither needs a socket.
 *
 * The abort is the one that matters. A reader who navigates mid-stream must not
 * have the previous diff's files appended into the new viewer - the shape of
 * that bug is a list that grows every time you go back and forward.
 */

import { describe, expect, test } from 'bun:test'
import { readNdjson, streamDiffManifest } from '../../resources/functions/diffviewer'

/** A Response whose body arrives in pieces, with a pause between them. */
function streaming(chunks: string[], pauseMs = 0): Response {
  const encoder = new TextEncoder()

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const chunk of chunks) {
        if (pauseMs > 0)
          await new Promise(resolve => setTimeout(resolve, pauseMs))
        controller.enqueue(encoder.encode(chunk))
      }
      controller.close()
    },
  })

  return new Response(body, { status: 200 })
}

const RECORDS = [
  '{"t":"file","i":0,"path":"a.ts"}\n',
  '{"t":"file","i":1,"path":"b.ts"}\n',
  '{"t":"end","files":2,"additions":0,"deletions":0}\n',
]

describe('readNdjson', () => {
  test('yields one record per line', async () => {
    const seen = []
    for await (const record of readNdjson<{ t: string }>(streaming(RECORDS)))
      seen.push(record)

    expect(seen.map(record => record.t)).toEqual(['file', 'file', 'end'])
  })

  /**
   * The property the whole streaming design rests on: a record is complete when
   * its newline arrives, not when the response does.
   */
  test('a record split across chunk edges is still one record', async () => {
    const whole = RECORDS.join('')
    const cut = [whole.slice(0, 12), whole.slice(12, 40), whole.slice(40)]

    const seen = []
    for await (const record of readNdjson<{ t: string }>(streaming(cut)))
      seen.push(record)

    expect(seen.map(record => record.t)).toEqual(['file', 'file', 'end'])
  })

  test('a last line with no trailing newline is not lost', async () => {
    const seen = []
    for await (const record of readNdjson<{ t: string }>(streaming(['{"t":"end"}'])))
      seen.push(record)

    expect(seen).toEqual([{ t: 'end' }])
  })

  test('blank lines are skipped rather than parsed', async () => {
    const seen = []
    for await (const record of readNdjson<{ t: string }>(streaming(['\n\n{"t":"end"}\n\n'])))
      seen.push(record)

    expect(seen).toEqual([{ t: 'end' }])
  })

  test('an aborted read stops yielding', async () => {
    const controller = new AbortController()
    const seen = []

    for await (const record of readNdjson<{ t: string }>(streaming(RECORDS, 5), controller.signal)) {
      seen.push(record)
      controller.abort()
    }

    expect(seen.length).toBeLessThan(3)
  })
})

describe('a stream that is aborted, then retried', () => {
  /**
   * The bug this exists to prevent: a reader navigates mid-stream and the
   * previous diff's files are appended into the new viewer. The shape of it is
   * a list that grows every time you go back and forward.
   */
  test('leaves no files from the first attempt', async () => {
    const controller = new AbortController()
    const first: string[] = []

    const original = globalThis.fetch
    globalThis.fetch = (async () => streaming(RECORDS, 5)) as typeof fetch

    try {
      await streamDiffManifest('/manifest', {
        onFiles(files) {
          first.push(...files.map(file => file.path))
          controller.abort()
        },
      }, controller.signal)

      const second: string[] = []
      await streamDiffManifest('/manifest', {
        onFiles(files) {
          second.push(...files.map(file => file.path))
        },
      })

      // The retry sees the whole diff, and nothing from the attempt before it.
      expect(second).toEqual(['a.ts', 'b.ts'])
      expect(second.length).toBeGreaterThanOrEqual(first.length)
    }
    finally {
      globalThis.fetch = original
    }
  })

  test('a failed response is reported rather than silently empty', async () => {
    const original = globalThis.fetch
    globalThis.fetch = (async () => new Response('no such pull request', { status: 404 })) as typeof fetch

    try {
      let error = ''
      await streamDiffManifest('/manifest', {
        onFiles: () => {},
        onError: (message) => { error = message },
      })

      expect(error).toBe('no such pull request')
    }
    finally {
      globalThis.fetch = original
    }
  })
})

import { expect, test } from 'bun:test'
import { gitRequestBody, UnsupportedGitContentEncoding } from '../../app/Actions/Git/requestBody'

test('fragmented gzip input reaches Git as the exact original packet bytes', async () => {
  const original = Buffer.from('0032want 1234567890123456789012345678901234567890\n00000009done\n')
  const encoded = Bun.gzipSync(original)
  let offset = 0
  const body = new ReadableStream<Uint8Array<ArrayBuffer>>({
    pull(controller) {
      if (offset === encoded.length) { controller.close(); return }
      controller.enqueue(encoded.slice(offset, offset + 3))
      offset = Math.min(offset + 3, encoded.length)
    },
  })
  const decoded = gitRequestBody({ headers: new Headers({ 'Content-Encoding': 'gzip' }), body })
  expect(Buffer.from(await new Response(decoded).arrayBuffer())).toEqual(original)
})

test('ordinary requests preserve their original stream and absent bodies', () => {
  const body = new ReadableStream<Uint8Array<ArrayBuffer>>()
  expect(gitRequestBody({ headers: new Headers(), body })).toBe(body)
  expect(gitRequestBody({ headers: new Headers({ 'Content-Encoding': 'identity' }), body: null })).toBeNull()
})

test('unsupported encodings are refused before consuming the request', () => {
  const body = new ReadableStream<Uint8Array<ArrayBuffer>>()
  expect(() => gitRequestBody({ headers: new Headers({ 'Content-Encoding': 'br' }), body })).toThrow(UnsupportedGitContentEncoding)
  expect(body.locked).toBe(false)
})

test('corrupt compressed input fails instead of forwarding compressed bytes to Git', async () => {
  const request = new Request('http://git.test/upload-pack', { method: 'POST', headers: { 'Content-Encoding': 'gzip' }, body: 'not gzip' })
  const decoded = gitRequestBody(request)
  await expect(new Response(decoded).arrayBuffer()).rejects.toThrow()
})

// The object-storage driver, against a fake client.
//
// What can honestly be tested without a bucket: that keys map to objects the
// way the prefix says, that a binary body survives the round trip, that a
// missing object reads as null rather than throwing, and that the buffering
// ceiling refuses loudly instead of exhausting memory. Whether AWS and Hetzner
// accept these calls is a question only credentials can answer, and the
// roadmap says so rather than this file pretending otherwise.

import { describe, expect, test } from 'bun:test'
import type { S3Like } from '../../app/Actions/Git/blobsS3'
import { S3BlobStore } from '../../app/Actions/Git/blobsS3'
import { UnsafeBlobKey } from '../../app/Actions/Git/blobs'

/** An S3 that is a Map, so the calls it receives can be asserted. */
function fakeS3(): S3Like & { objects: Map<string, Uint8Array> } {
  const objects = new Map<string, Uint8Array>()

  return {
    objects,
    async putObjectStream({ bucket, key, body }) {
      const data = new Uint8Array(await new Response(body as ReadableStream<Uint8Array>).arrayBuffer())
      objects.set(`${bucket}/${key}`, data)
      return { bytes: data.byteLength }
    },
    async getObjectStream(bucket, key) {
      const body = objects.get(`${bucket}/${key}`)

      if (!body) throw Object.assign(new Error('missing'), { statusCode: 404 })
      return { body: new Response(body).body! }
    },
    async headObject(bucket, key) {
      const body = objects.get(`${bucket}/${key}`)

      return body ? { ContentLength: body.byteLength, LastModified: new Date(1_700_000_000_000) } : null
    },
    async deleteObject(bucket, key) {
      objects.delete(`${bucket}/${key}`)
    },
    async listAllObjects({ bucket, prefix }) {
      return [...objects.entries()]
        .filter(([full]) => full.startsWith(`${bucket}/`))
        .map(([full, body]) => ({ Key: full.slice(bucket.length + 1), Size: body.byteLength }))
        .filter(entry => !prefix || entry.Key.startsWith(prefix))
    },
  }
}

describe('S3BlobStore', () => {
  test('puts a key under the configured prefix, and reads it back as a key', async () => {
    const client = fakeS3()
    const store = new S3BlobStore({ bucket: 'forge', prefix: 'reviewos/one', client })

    await store.put('artifacts/1/log.txt', 'hello')

    // The prefix is the instance's; the key is the caller's, and the caller
    // never sees the prefix again.
    expect([...client.objects.keys()]).toEqual(['forge/reviewos/one/artifacts/1/log.txt'])

    const listed = await store.list('artifacts')
    expect(listed.map(entry => entry.key)).toEqual(['artifacts/1/log.txt'])
  })

  test('works with no prefix at all', async () => {
    const client = fakeS3()
    const store = new S3BlobStore({ bucket: 'forge', client })

    await store.put('wal/acme/app/1.bundle', 'x')

    expect([...client.objects.keys()]).toEqual(['forge/wal/acme/app/1.bundle'])
    expect((await store.list('')).map(entry => entry.key)).toEqual(['wal/acme/app/1.bundle'])
  })

  /**
   * The bug a text fixture would hide: `getObject` decodes UTF-8 and would
   * quietly corrupt every packfile and image, so the driver uses
   * `getObjectBytes`. Asserted with bytes that are not valid UTF-8.
   */
  test('a binary body survives the round trip byte for byte', async () => {
    const client = fakeS3()
    const store = new S3BlobStore({ bucket: 'forge', client })
    const bytes = new Uint8Array([0x00, 0xFF, 0xFE, 0x80, 0x7F, 0xC3, 0x28])

    await store.put('artifacts/1/blob.bin', bytes)

    const read = await store.get('artifacts/1/blob.bin')
    const back = new Uint8Array(await new Response(read!).arrayBuffer())

    expect([...back]).toEqual([...bytes])
  })

  test('a missing object is null on both get and stat', async () => {
    const store = new S3BlobStore({ bucket: 'forge', client: fakeS3() })

    expect(await store.get('artifacts/1/gone.txt')).toBeNull()
    expect(await store.stat('artifacts/1/gone.txt')).toBeNull()
  })

  test('stat reports the size without fetching the body', async () => {
    const client = fakeS3()
    const store = new S3BlobStore({ bucket: 'forge', client })

    await store.put('artifacts/1/log.txt', 'x'.repeat(120))

    const found = await store.stat('artifacts/1/log.txt')
    expect(found?.size).toBe(120)
    expect(found?.modifiedAtMs).toBe(1_700_000_000_000)
  })

  test('deleting something absent is a success', async () => {
    const store = new S3BlobStore({ bucket: 'forge', client: fakeS3() })

    await store.delete('artifacts/1/gone.txt')
  })

  test('refuses an unsafe key before it reaches the bucket', async () => {
    const client = fakeS3()
    const store = new S3BlobStore({ bucket: 'forge', prefix: 'reviewos', client })

    await expect(store.put('../../etc/passwd', 'x')).rejects.toThrow(UnsafeBlobKey)
    expect(client.objects.size).toBe(0)
  })

  test('streams past the old ceiling and propagates authorization failures', async () => {
    const client = fakeS3()
    let bytes = 0
    client.putObjectStream = async ({ body }) => { for await (const chunk of body) bytes += chunk.byteLength; return { bytes } }
    const store = new S3BlobStore({ bucket: 'forge', client })
    const chunk = new Uint8Array(1024 * 1024)
    async function* input() { for (let index = 0; index < 270; index++) yield chunk }
    expect((await store.put('wal/1/checkpoint.bundle', input())).size).toBe(270 * chunk.byteLength)
    client.getObjectStream = async () => { throw Object.assign(new Error('denied'), { statusCode: 403 }) }
    await expect(store.get('wal/1/checkpoint.bundle')).rejects.toThrow('denied')
    client.headObject = async () => { throw new Error('provider unavailable') }
    await expect(store.stat('wal/1/checkpoint.bundle')).rejects.toThrow('provider unavailable')
  })
})

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
import { MAX_BUFFERED_BYTES, S3BlobStore } from '../../app/Actions/Git/blobsS3'
import { UnsafeBlobKey } from '../../app/Actions/Git/blobs'

/** An S3 that is a Map, so the calls it receives can be asserted. */
function fakeS3(): S3Like & { objects: Map<string, Uint8Array> } {
  const objects = new Map<string, Uint8Array>()

  return {
    objects,
    async putObject({ bucket, key, body }) {
      objects.set(`${bucket}/${key}`, body)
    },
    async getObjectBytes(bucket, key) {
      const body = objects.get(`${bucket}/${key}`)

      return body ? { body } : null
    },
    async headObject(bucket, key) {
      const body = objects.get(`${bucket}/${key}`)

      return body ? { ContentLength: body.byteLength, LastModified: new Date(1_700_000_000_000) } : null
    },
    async deleteObject(bucket, key) {
      objects.delete(`${bucket}/${key}`)
    },
    async list({ bucket, prefix }) {
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

  /**
   * S3 will not take a PUT without a length, so a stream has to be collected -
   * and a driver that collects without a ceiling is one OOM away from taking
   * the process down. It refuses with a message naming multipart instead.
   */
  test('refuses a body past the buffering ceiling, naming the fix', async () => {
    const store = new S3BlobStore({ bucket: 'forge', client: fakeS3() })
    const chunk = new Uint8Array(1024 * 1024)

    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        // Endless, so only the ceiling can stop it.
        controller.enqueue(chunk)
      },
    })

    await expect(store.put('artifacts/1/huge.bin', body)).rejects.toThrow(/multipart/)
  })

  test('the ceiling is under the artifact ceiling it has to survive', () => {
    // If this ever exceeds what a small box can hold, the refusal above stops
    // being a safety property and becomes the thing that kills the process.
    expect(MAX_BUFFERED_BYTES).toBeLessThanOrEqual(512 * 1024 * 1024)
  })
})

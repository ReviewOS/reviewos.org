/**
 * The object-storage driver for `BlobStore`.
 *
 * Separate from `blobs.ts` so the zero-dependency path stays zero-dependency:
 * an instance on one box never imports ts-cloud, never resolves credentials,
 * and never pays for an S3 client it does not use. `blobStore()` imports this
 * only when the driver is configured.
 *
 * **AWS and Hetzner from day one**, because they are the two this project
 * actually targets - `config/cloud.ts` already provisions Hetzner compute, so
 * storage beside it should not require a second vendor. Both are the same
 * SigV4 client with a different endpoint, which is ts-cloud's
 * `createObjectStorageClient` doing the work: `provider: 'hetzner'` resolves
 * `{region}.your-objectstorage.com` and reads `HETZNER_S3_*`, `provider: 'aws'`
 * uses the AWS chain. Backblaze comes along for free and is untested here.
 *
 * ## The one place this is not a faithful `BlobStore`
 *
 * `put` takes a stream, and S3 will not take one without knowing how long it
 * is: a PUT needs `Content-Length`, and the way to send bytes of unknown
 * length is a multipart upload. So this driver collects the stream before
 * sending it, and refuses - loudly, rather than by exhausting memory - past
 * `MAX_BUFFERED_BYTES`.
 *
 * That is a real limit and it is written down rather than hidden: every
 * current caller already has its bytes in memory (`storeArtifact` takes a
 * `Uint8Array`, an asset upload has been read to check its checksum), so
 * nothing today is worse off. The day something genuinely streams a
 * multi-gigabyte object into the store, this needs multipart, and the error
 * message says so instead of the process dying.
 */

import type { BlobBody, BlobStat, BlobStore } from './blobs'
import process from 'node:process'
import { isSafeKey, UnsafeBlobKey } from './blobs'

/**
 * How much this driver will hold in memory for one object.
 *
 * Above the 500 MB artifact ceiling and the 2 GB asset ceiling would be
 * dishonest - it would promise something the memory cannot keep - so it sits
 * where a single object is still comfortably bufferable on a small box, and
 * anything larger is an explicit failure naming multipart as the fix.
 */
export const MAX_BUFFERED_BYTES = 256 * 1024 * 1024

/** What this driver needs from an S3 client, and nothing more. */
export interface S3Like {
  putObject: (input: { bucket: string, key: string, body: Uint8Array, contentType?: string }) => Promise<void>
  getObjectBytes: (bucket: string, key: string) => Promise<{ body: Uint8Array } | null>
  headObject: (bucket: string, key: string) => Promise<{ ContentLength?: number, LastModified?: string | Date } | null>
  deleteObject: (bucket: string, key: string) => Promise<void>
  list: (options: { bucket: string, prefix?: string }) => Promise<Array<{ Key?: string, Size?: number, LastModified?: string | Date }>>
}

export interface S3BlobStoreOptions {
  bucket: string
  /** Everything this instance writes goes under here, so one bucket can hold several. */
  prefix?: string
  client: S3Like
}

export class S3BlobStore implements BlobStore {
  readonly driver = 's3'
  private readonly bucket: string
  private readonly prefix: string
  private readonly client: S3Like

  constructor(options: S3BlobStoreOptions) {
    this.bucket = options.bucket
    this.prefix = (options.prefix ?? '').replace(/^\/+|\/+$/g, '')
    this.client = options.client
  }

  /** The object name for a key. The prefix is ours; the key is the caller's. */
  private objectFor(key: string): string {
    if (!isSafeKey(key))
      throw new UnsafeBlobKey(key)

    return this.prefix.length > 0 ? `${this.prefix}/${key}` : key
  }

  /** And back, for `list`, which answers in object names. */
  private keyFor(object: string): string | null {
    if (this.prefix.length === 0)
      return object

    return object.startsWith(`${this.prefix}/`) ? object.slice(this.prefix.length + 1) : null
  }

  async put(key: string, body: BlobBody): Promise<BlobStat> {
    const object = this.objectFor(key)
    const bytes = await collect(body)

    await this.client.putObject({ bucket: this.bucket, key: object, body: bytes })

    return { key, size: bytes.byteLength, modifiedAtMs: Date.now() }
  }

  async get(key: string): Promise<ReadableStream<Uint8Array> | null> {
    const object = this.objectFor(key)

    /*
     * `getObjectBytes`, never `getObject`: the latter decodes as UTF-8, which
     * silently corrupts every packfile, image and tarball that goes through
     * it. The kind of bug that passes a test written with a text fixture.
     */
    const found = await this.client.getObjectBytes(this.bucket, object).catch(() => null)

    if (!found?.body)
      return null

    const bytes = found.body

    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes)
        controller.close()
      },
    })
  }

  async stat(key: string): Promise<BlobStat | null> {
    const head = await this.client.headObject(this.bucket, this.objectFor(key)).catch(() => null)

    if (!head)
      return null

    const modified = head.LastModified ? new Date(head.LastModified).getTime() : null

    return {
      key,
      size: Number(head.ContentLength ?? 0),
      modifiedAtMs: Number.isFinite(modified) ? modified : null,
    }
  }

  async delete(key: string): Promise<void> {
    // A delete of something absent is a success here as it is on local disk:
    // S3 answers 204 either way, and a caller sweeping expired blobs should
    // not have to care which.
    await this.client.deleteObject(this.bucket, this.objectFor(key)).catch(() => undefined)
  }

  async list(prefix: string): Promise<BlobStat[]> {
    const under = prefix.length === 0 ? this.prefix : this.objectFor(prefix)
    const found = await this.client.list({ bucket: this.bucket, prefix: under })
    const stats: BlobStat[] = []

    for (const entry of found) {
      if (!entry.Key)
        continue

      const key = this.keyFor(entry.Key)

      if (!key)
        continue

      const modified = entry.LastModified ? new Date(entry.LastModified).getTime() : null

      stats.push({
        key,
        size: Number(entry.Size ?? 0),
        modifiedAtMs: Number.isFinite(modified) ? modified : null,
      })
    }

    return stats
  }
}

/** Read a body into memory, refusing rather than dying past the ceiling. */
async function collect(body: BlobBody): Promise<Uint8Array> {
  if (typeof body === 'string')
    return new TextEncoder().encode(body)

  if (body instanceof Uint8Array)
    return guard(body)

  const parts: Uint8Array[] = []
  let total = 0

  const push = (chunk: Uint8Array): void => {
    total += chunk.byteLength

    if (total > MAX_BUFFERED_BYTES) {
      throw new Error(
        `blob exceeds ${Math.round(MAX_BUFFERED_BYTES / 1024 / 1024)} MB, which is the most the s3 driver will buffer. `
        + 'S3 needs a length before it will take a PUT, so an object this size needs a multipart upload.',
      )
    }

    parts.push(chunk)
  }

  if (body instanceof ReadableStream) {
    const reader = body.getReader()

    try {
      for (;;) {
        const { done, value } = await reader.read()

        if (done)
          break

        if (value)
          push(value)
      }
    }
    finally {
      reader.releaseLock()
    }
  }
  else {
    for await (const chunk of body)
      push(chunk)
  }

  const joined = new Uint8Array(total)
  let at = 0

  for (const part of parts) {
    joined.set(part, at)
    at += part.byteLength
  }

  return joined
}

function guard(bytes: Uint8Array): Uint8Array {
  if (bytes.byteLength > MAX_BUFFERED_BYTES)
    throw new Error(`blob exceeds ${Math.round(MAX_BUFFERED_BYTES / 1024 / 1024)} MB, the s3 driver's single-PUT ceiling`)

  return bytes
}

/**
 * Build the configured S3 store, or null when this instance is not using one.
 *
 * Env rather than a config import, for the reason `blobs.ts` gives: this is
 * reachable from hooks and `buddy` commands that do not boot the config layer.
 * The provider names match ts-cloud's, so `HETZNER_S3_*` and the AWS chain
 * both work without this file knowing how either is spelled.
 */
export async function s3StoreFromEnvironment(): Promise<BlobStore | null> {
  const bucket = String(process.env.BLOB_S3_BUCKET ?? '').trim()

  if (bucket.length === 0)
    return null

  const { createObjectStorageClient } = await import('@stacksjs/ts-cloud')

  const provider = String(process.env.BLOB_S3_PROVIDER ?? process.env.OBJECT_STORAGE_PROVIDER ?? 'aws').trim()
  const client = createObjectStorageClient({
    provider: (provider === 'hetzner' || provider === 'backblaze' ? provider : 'aws') as 'aws' | 'hetzner' | 'backblaze',
  })

  return new S3BlobStore({
    bucket,
    prefix: String(process.env.BLOB_S3_PREFIX ?? '').trim(),
    client: client as unknown as S3Like,
  })
}

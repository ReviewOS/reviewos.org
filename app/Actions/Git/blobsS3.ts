/** Streaming object storage. Only a missing object is an ordinary null result. */
import type { BlobBody, BlobStat, BlobStore } from './blobs'
import type { S3Client } from '@stacksjs/ts-cloud'
import process from 'node:process'
import { readFile, lstat } from 'node:fs/promises'
import { isSafeKey, UnsafeBlobKey } from './blobs'

export type S3Like = Pick<S3Client, 'putObjectStream' | 'getObjectStream' | 'headObject' | 'deleteObject' | 'listAllObjects'>
export interface S3BlobStoreOptions { bucket: string, prefix?: string, client: S3Like }

export class S3BlobStore implements BlobStore {
  readonly driver = 's3'
  private readonly bucket: string
  private readonly prefix: string
  private readonly client: S3Like

  constructor(options: S3BlobStoreOptions) {
    this.bucket = options.bucket
    this.prefix = (options.prefix ?? '').replace(/^\/+|\/+$/g, '')
    if (this.prefix && !isSafeKey(this.prefix)) throw new UnsafeBlobKey(this.prefix)
    this.client = options.client
  }

  private objectFor(key: string): string {
    if (!isSafeKey(key)) throw new UnsafeBlobKey(key)
    return this.prefix ? `${this.prefix}/${key}` : key
  }

  async put(key: string, body: BlobBody): Promise<BlobStat> {
    const stream = body instanceof ReadableStream ? body : typeof body === 'string' || body instanceof Uint8Array
      ? new Response(typeof body === 'string' ? body : new Uint8Array(body)).body! : streamOf(body)
    const written = await this.client.putObjectStream({ bucket: this.bucket, key: this.objectFor(key), body: stream })
    return { key, size: written.bytes, modifiedAtMs: Date.now() }
  }

  async get(key: string): Promise<ReadableStream<Uint8Array> | null> {
    try { return (await this.client.getObjectStream(this.bucket, this.objectFor(key))).body }
    catch (error) { if (Number((error as { statusCode?: number }).statusCode) === 404) return null; throw error }
  }

  async stat(key: string): Promise<BlobStat | null> {
    const head = await this.client.headObject(this.bucket, this.objectFor(key))
    if (!head) return null
    const modified = head.LastModified ? new Date(head.LastModified).getTime() : null
    return { key, size: Number(head.ContentLength ?? 0), etag: head.ETag, modifiedAtMs: Number.isFinite(modified) ? modified : null }
  }

  async delete(key: string): Promise<void> {
    await this.client.deleteObject(this.bucket, this.objectFor(key))
  }

  async list(prefix: string): Promise<BlobStat[]> {
    const under = prefix ? this.objectFor(prefix) : this.prefix
    // The SDK's list traverses every continuation page.
    const found = await this.client.listAllObjects({ bucket: this.bucket, prefix: under })
    const stats: BlobStat[] = []
    for (const entry of found) {
      const key = this.prefix ? (entry.Key?.startsWith(this.prefix + '/') ? entry.Key.slice(this.prefix.length + 1) : '') : entry.Key
      if (!key || !isSafeKey(key) || prefix && key !== prefix && !key.startsWith(prefix + '/')) continue
      const modified = entry.LastModified ? new Date(entry.LastModified).getTime() : null
      stats.push({ key, size: Number(entry.Size ?? 0), modifiedAtMs: Number.isFinite(modified) ? modified : null })
    }
    return stats
  }
}

function streamOf(body: AsyncIterable<Uint8Array>): ReadableStream<Uint8Array> {
  const iterator = body[Symbol.asyncIterator]()
  return new ReadableStream({
    async pull(controller) {
      const next = await iterator.next()
      if (next.done) controller.close(); else controller.enqueue(next.value)
    },
    async cancel() { await iterator.return?.() },
  })
}

export async function s3StoreFromEnvironment(options: { bucket?: string, provider?: string, prefix?: string } = {}): Promise<BlobStore | null> {
  const bucket = String(options.bucket ?? process.env.BLOB_S3_BUCKET ?? '').trim()
  if (!bucket) return null
  // Host credentials stay in the protected service environment, never payloads.
  const { createObjectStorageClient } = await import('@stacksjs/ts-cloud')
  const provider = String(options.provider ?? process.env.BLOB_S3_PROVIDER ?? process.env.OBJECT_STORAGE_PROVIDER ?? 'aws').trim()
  if (!['aws', 'hetzner', 'backblaze', 'r2'].includes(provider)) throw new Error('Unknown blob storage provider')
  const file = process.env.BLOB_S3_CREDENTIALS_FILE
  if (file) {
    const info = await lstat(file)
    if (!file.startsWith('/') || !info.isFile() || info.isSymbolicLink() || (info.mode & 0o077)) throw new Error('Object storage credentials require a private regular file')
  }
  const credentials = file ? JSON.parse(await readFile(file, 'utf8')) : undefined
  if (credentials && (typeof credentials.accessKeyId !== 'string' || typeof credentials.secretAccessKey !== 'string')) throw new Error('Invalid protected object storage credentials')
  const client = createObjectStorageClient({ credentials, region: process.env.BLOB_S3_REGION, provider: provider as 'aws' | 'hetzner' | 'backblaze' | 'r2' })
  return new S3BlobStore({ bucket, prefix: String(options.prefix ?? process.env.BLOB_S3_PREFIX ?? '').trim(), client })
}

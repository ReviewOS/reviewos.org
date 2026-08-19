/**
 * Where bytes that are not a git object live.
 *
 * Four things in this forge are large, immutable and not part of a repository's
 * object store: workflow artifacts, LFS objects, release assets, and the push
 * bundles phase 18b writes. Each of them grew its own path builder and its own
 * `Bun.write`, which is four places to change the day an instance outgrows one
 * disk - and four places for a path to be built from something a request said.
 *
 * So there is one seam. `BlobStore` is the whole of it: put, get, stat, delete,
 * list, on opaque keys.
 *
 * ## Local disk is a driver, not a fallback
 *
 * Most instances are one box and must stay a `bun install` and a `.env` away
 * from working. `LocalBlobStore` is therefore the default and stays supported
 * forever; object storage is what somebody turns on when they have a reason.
 * Nothing in this interface hints at S3 - no presigned URLs, no multipart, no
 * bucket - because the moment it does, the local driver becomes the one that
 * emulates something rather than the one that is simplest.
 *
 * ## Streaming both ways
 *
 * `put` takes a stream and `get` returns one. An artifact is hundreds of
 * megabytes and a release asset can be larger; a store whose interface is
 * `Buffer` in and `Buffer` out is a store that decides, on behalf of every
 * caller, that the whole thing fits in memory. Phase 16 spent a milestone
 * removing exactly that assumption from the git paths.
 *
 * ## Keys are opaque, and callers do not build paths
 *
 * A key is a `/`-separated string this module validates and maps to wherever
 * the driver keeps it. Callers pass what a key *means* (`artifacts/42/log.txt`)
 * and never a filesystem path, which is what keeps the traversal rule from
 * `storage.ts` in one place rather than repeated per feature.
 */

import type { Dirent } from 'node:fs'
import { mkdir, readdir, rm, stat as statFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import process from 'node:process'

/** What a stored blob weighs and when it was written. */
export interface BlobStat {
  key: string
  size: number
  /** Milliseconds since the epoch. Null when the driver cannot say. */
  modifiedAtMs: number | null
}

/** Anything that can be written to the store. */
export type BlobBody = ReadableStream<Uint8Array> | AsyncIterable<Uint8Array> | Uint8Array | string

export interface BlobStore {
  /** The driver's name, for logs and `buddy` output. */
  readonly driver: string

  /** Write, replacing whatever was at the key. Resolves once durable. */
  put: (key: string, body: BlobBody) => Promise<BlobStat>

  /**
   * Read. Resolves null when the key is not there, rather than throwing: a
   * missing artifact is an ordinary answer (it expired) and a caller that has
   * to catch to find that out will forget to.
   */
  get: (key: string) => Promise<ReadableStream<Uint8Array> | null>

  /** What is at the key, or null. Never reads the body. */
  stat: (key: string) => Promise<BlobStat | null>

  /** Remove. Removing something that is not there is a success, not an error. */
  delete: (key: string) => Promise<void>

  /** Every key under a prefix. Used by expiry sweeps and the WAL reconciler. */
  list: (prefix: string) => Promise<BlobStat[]>
}

/**
 * Whether a key is one this application will store.
 *
 * The same shape of rule as `isSafeSegment` in `storage.ts`, and here for the
 * same reason: a key can be built from something a request said - an artifact
 * name, a release asset's filename - and `../../.env` must not resolve out of
 * the store. Checked in the interface layer rather than per driver, because a
 * driver that forgets is a driver with a traversal bug.
 */
export function isSafeKey(key: string): boolean {
  if (key.length === 0 || key.length > 1024)
    return false

  if (key.startsWith('/') || key.endsWith('/') || key.includes('//'))
    return false

  if (key.includes('\0') || key.includes('\\'))
    return false

  return key.split('/').every(segment =>
    segment.length > 0
    && segment !== '.'
    && segment !== '..'
    && !segment.startsWith('.')
    && /^[A-Za-z0-9._-]+$/.test(segment),
  )
}

/** Thrown for a key the store will not touch. Never for a missing blob. */
export class UnsafeBlobKey extends Error {
  constructor(key: string) {
    super(`unsafe blob key: ${JSON.stringify(key)}`)
    this.name = 'UnsafeBlobKey'
  }
}

function assertSafe(key: string): void {
  if (!isSafeKey(key))
    throw new UnsafeBlobKey(key)
}

/** Normalise the several shapes a caller may hand `put` into a byte stream. */
async function* bytesOf(body: BlobBody): AsyncGenerator<Uint8Array> {
  if (typeof body === 'string') {
    yield new TextEncoder().encode(body)

    return
  }

  if (body instanceof Uint8Array) {
    yield body

    return
  }

  if (body instanceof ReadableStream) {
    const reader = body.getReader()

    try {
      for (;;) {
        const { done, value } = await reader.read()

        if (done)
          break

        if (value)
          yield value
      }
    }
    finally {
      reader.releaseLock()
    }

    return
  }

  for await (const chunk of body)
    yield chunk
}

/**
 * Blobs on the local filesystem, under a root inside `storage/`.
 *
 * The zero-configuration default. A key becomes a path under the root and
 * nothing else: no hashing into buckets, no sharding, because a directory with
 * a lot of entries is a problem for `ls` rather than for the filesystems
 * anybody runs this on, and a layout somebody can read with `find` is worth
 * more than one that is clever.
 */
export class LocalBlobStore implements BlobStore {
  readonly driver = 'local'
  private readonly root: string

  constructor(root: string) {
    this.root = resolve(root)
  }

  /** Where a key lives. Private: callers deal in keys, never in paths. */
  private pathFor(key: string): string {
    assertSafe(key)

    const absolute = resolve(this.root, key)

    // Belt and braces, exactly as `repositoryPath` does it: even with the key
    // validated, the resolved path has to sit under the root.
    if (absolute !== this.root && !absolute.startsWith(this.root + sep))
      throw new UnsafeBlobKey(key)

    return absolute
  }

  async put(key: string, body: BlobBody): Promise<BlobStat> {
    const path = this.pathFor(key)
    await mkdir(dirname(path), { recursive: true })

    /*
     * Written to a temporary name and renamed into place.
     *
     * A rename within a filesystem is atomic, so a reader either sees the old
     * blob or the whole new one - never a half-written artifact that looks
     * complete because the file exists and has a size. The interrupted case
     * leaves a `.partial` file rather than a corrupt blob.
     */
    const temporary = `${path}.partial`
    const file = Bun.file(temporary)
    const writer = file.writer()

    try {
      for await (const chunk of bytesOf(body))
        writer.write(chunk)

      await writer.end()
      await Bun.write(Bun.file(path), Bun.file(temporary))
      await rm(temporary, { force: true })
    }
    catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined)

      throw error
    }

    const written = await statFile(path)

    return { key, size: written.size, modifiedAtMs: written.mtimeMs }
  }

  async get(key: string): Promise<ReadableStream<Uint8Array> | null> {
    const path = this.pathFor(key)
    const file = Bun.file(path)

    return (await file.exists()) ? file.stream() : null
  }

  async stat(key: string): Promise<BlobStat | null> {
    const path = this.pathFor(key)

    try {
      const found = await statFile(path)

      return found.isFile() ? { key, size: found.size, modifiedAtMs: found.mtimeMs } : null
    }
    catch {
      return null
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.pathFor(key), { force: true })
  }

  async list(prefix: string): Promise<BlobStat[]> {
    // A prefix is a directory here. An empty one means the whole store, which
    // is what the sweeps want.
    const base = prefix.length === 0 ? this.root : this.pathFor(prefix)
    const found: BlobStat[] = []

    const walk = async (directory: string, keyPrefix: string): Promise<void> => {
      let entries: Dirent[]

      try {
        entries = await readdir(directory, { withFileTypes: true })
      }
      catch {
        return
      }

      for (const entry of entries) {
        const key = keyPrefix.length === 0 ? entry.name : `${keyPrefix}/${entry.name}`

        if (entry.isDirectory()) {
          await walk(join(directory, entry.name), key)

          continue
        }

        // The half-written blobs `put` cleans up after itself. Listing one
        // would offer a reader something that is not a blob.
        if (entry.name.endsWith('.partial'))
          continue

        const written = await statFile(join(directory, entry.name)).catch(() => null)

        if (written)
          found.push({ key, size: written.size, modifiedAtMs: written.mtimeMs })
      }
    }

    await walk(base, prefix)

    return found
  }
}

/** Where the local driver keeps things, unless configured otherwise. */
export const LOCAL_BLOB_ROOT = 'storage/blobs'

let configured: BlobStore | null = null

/**
 * The store this instance uses.
 *
 * Resolved once and cached, because a driver may hold a connection. Reading
 * the driver name from the environment rather than from a config file keeps
 * this importable by `app/Actions/Git/*`, which is loaded in contexts (hooks,
 * commands) where the config layer is not necessarily booted.
 *
 * Local unless `BLOB_S3_BUCKET` names a bucket. That is the whole switch, and
 * it is deliberately not a `BLOB_DRIVER=s3` that can be set without the thing
 * it needs: an instance that says "use s3" and has no bucket has told you
 * nothing, and finding that out at the first artifact upload is finding it out
 * too late.
 */
export async function blobStore(): Promise<BlobStore> {
  if (configured)
    return configured

  const bucket = String(process.env.BLOB_S3_BUCKET ?? '').trim()

  if (bucket.length > 0) {
    const { s3StoreFromEnvironment } = await import('./blobsS3')
    const remote = await s3StoreFromEnvironment()

    if (remote) {
      configured = remote

      return configured
    }
  }

  configured = new LocalBlobStore(process.env.BLOB_LOCAL_ROOT || LOCAL_BLOB_ROOT)

  return configured
}

/** Point the process at a different store. For tests and for `buddy`. */
export function useBlobStore(store: BlobStore | null): void {
  configured = store
}

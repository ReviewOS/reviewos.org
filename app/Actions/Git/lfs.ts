/**
 * Large files, and where this forge keeps them.
 *
 * The protocol is `ts-git-lfs`: pointer files, the batch API's decisions, the
 * content-addressed store, and the HTTP surface. What lives here is the three
 * things that are this forge's own and cannot be a library's:
 *
 * - **Where the objects go.** One store per repository, beside the bare
 *   repository rather than inside it, because `storage/repos/{owner}/{name}.git`
 *   is git's and nothing else should write there.
 * - **Who may read and write.** The same rule the wire protocol uses, from the
 *   same function. A second opinion about permissions is a security bug waiting
 *   for the two to disagree, and LFS is a way of reading a repository's
 *   contents like any other.
 * - **Where locks live.** In the database, so they survive a restart. A lock
 *   that a deploy forgets is a lock somebody was relying on.
 */

import type { Actor, LockRecord, LockStore, ObjectStoreLike } from 'ts-git-lfs'
import { ObjectStore, verifyObject } from 'ts-git-lfs'
import { blobStore } from './blobs'
import { join, resolve } from 'node:path'
import { path as frameworkPath } from '@stacksjs/path'

/**
 * The LFS object store, on this forge's blob store.
 *
 * ts-git-lfs ships an `ObjectStore` rooted at a directory, and that is what
 * this used. It could not survive the object store moving off local disk: the
 * library's download route opened `pathFor(oid)` itself, so a bucket-backed
 * store satisfied every other route and 404'd on the bytes. Fixed upstream in
 * ts-git-lfs 0.1.3, which types the option as `ObjectStoreLike` and asks the
 * store to stream - so this adapter is possible at all.
 *
 * The keys keep the layout the library used, one directory per repository with
 * a two-level fan-out, so an instance that already has LFS objects on disk
 * finds every one of them exactly where it left them.
 */
export function blobObjectStore(owner: string, name: string): ObjectStoreLike {
  const prefix = `lfs/${owner.toLowerCase()}/${stripGitSuffix(name).toLowerCase()}`
  const keyFor = (oid: string): string => `${prefix}/${oid.slice(0, 2)}/${oid.slice(2, 4)}/${oid}`

  return {
    async lookup(oid: string) {
      const found = await (await blobStore()).stat(keyFor(oid)).catch(() => null)

      return found ? { oid: oid as any, size: found.size } : null
    },

    async has(oid: string) {
      return Boolean(await (await blobStore()).stat(keyFor(oid)).catch(() => null))
    },

    async read(oid: string) {
      const stream = await (await blobStore()).get(keyFor(oid)).catch(() => null)

      return stream ? new Uint8Array(await new Response(stream).arrayBuffer()) : null
    },

    /*
     * Synchronous by the library's signature, and the store's `get` is not -
     * so the stream is opened lazily inside a ReadableStream's `start`. The
     * whole point of an object being in LFS is that it is too big to want a
     * copy of in memory, so this must not become a `read`.
     */
    stream(oid: string) {
      const key = keyFor(oid)

      return new ReadableStream<Uint8Array>({
        async start(controller) {
          const source = await (await blobStore()).get(key).catch(() => null)

          if (!source) {
            controller.close()

            return
          }

          const reader = source.getReader()

          try {
            for (;;) {
              const { done, value } = await reader.read()

              if (done)
                break

              if (value)
                controller.enqueue(value)
            }
          }
          finally {
            reader.releaseLock()
            controller.close()
          }
        },
      })
    },

    async write(bytes: Uint8Array, expected: { oid: string, size?: number }) {
      /*
       * The hash is checked here, by the library's own `verifyObject`, and
       * that is not optional politeness: an LFS object is addressed by the
       * hash of its content, and a store that writes whatever it is handed
       * under whatever name it is given lets one upload replace another
       * object's bytes. The library's own store verifies before writing; an
       * adapter that skips it silently removes the check for the whole
       * feature.
       *
       * The first version of this adapter did exactly that, and the existing
       * "bytes that do not hash to the id in the URL are refused" test caught
       * it - a 200 where a 422 belonged.
       */
      const verified = await verifyObject(bytes, expected)

      if (!verified.ok)
        return { ok: false, reason: verified.reason }

      const key = keyFor(verified.oid)
      const store = await blobStore()

      // Content-addressed, so an object already there is the same bytes.
      const already = await store.stat(key).catch(() => null)

      if (already)
        return { ok: true, oid: verified.oid, size: verified.size }

      const written = await store.put(key, bytes)

      return { ok: true, oid: verified.oid, size: written.size }
    },

    async remove(oid: string) {
      await (await blobStore()).delete(keyFor(oid)).catch(() => undefined)

      return true
    },
  }
}

/**
 * The object store for one repository.
 *
 * Beside the bare repository, not inside it. git owns everything under
 * `.git`, and an LFS object appearing in `git count-objects` would make the
 * repository size accounting wrong in a way nobody would think to look for.
 */
export function storeFor(owner: string, name: string): ObjectStore {
  const root = resolve(frameworkPath.storagePath('lfs'), owner.toLowerCase(), stripGitSuffix(name).toLowerCase())

  return new ObjectStore(root)
}

/** The path an object would have, for anything that needs to look. */
export function storeRoot(owner: string, name: string): string {
  return resolve(frameworkPath.storagePath('lfs'), owner.toLowerCase(), stripGitSuffix(name).toLowerCase())
}

/** `repo.git` and `repo` name the same repository over the wire. */
export function stripGitSuffix(name: string): string {
  return name.endsWith('.git') ? name.slice(0, -'.git'.length) : name
}

/**
 * The endpoint clients are told to use.
 *
 * Absolute, because it goes into every action href in a batch response and the
 * client has to be able to reach it - the path this process sees is not
 * necessarily the URL anybody else does.
 */
export function endpointFor(request: Request, owner: string, name: string): string {
  const url = new URL(request.url)
  const base = `${url.protocol}//${url.host}`

  return `${base}/${owner}/${stripGitSuffix(name)}.git/info/lfs`
}

/**
 * Locks, in the database.
 *
 * The `LockStore` interface is four methods, and this is the whole
 * implementation of it against `repository_lfs_locks`. Scoped by repository:
 * two repositories may each hold a lock on `src/art.psd`, and they are not the
 * same lock.
 */
export class DatabaseLockStore implements LockStore {
  constructor(private readonly repositoryId: number) {}

  async find(path: string): Promise<LockRecord | null> {
    const row = await db
      .selectFrom('repository_lfs_locks')
      .selectAll()
      .where('repository_id', '=', this.repositoryId)
      .where('path', '=', path)
      .executeTakeFirst()

    return row ? toRecord(row) : null
  }

  async byId(id: string): Promise<LockRecord | null> {
    const row = await db
      .selectFrom('repository_lfs_locks')
      .selectAll()
      .where('repository_id', '=', this.repositoryId)
      .where('lock_id', '=', id)
      .executeTakeFirst()

    return row ? toRecord(row) : null
  }

  async list(filter: { path?: string, id?: string, refspec?: string }): Promise<LockRecord[]> {
    let query = db
      .selectFrom('repository_lfs_locks')
      .selectAll()
      .where('repository_id', '=', this.repositoryId)

    // One column per call rather than a composed predicate: the query builder
    // renders a chain of single-column `where`s correctly and has been wrong
    // about anything cleverer.
    if (filter.path)
      query = query.where('path', '=', filter.path)
    if (filter.id)
      query = query.where('lock_id', '=', filter.id)
    if (filter.refspec)
      query = query.where('ref', '=', filter.refspec)

    const rows: any[] = await query.execute()

    return rows.map(toRecord)
  }

  async create(lock: LockRecord): Promise<void> {
    await db.insertInto('repository_lfs_locks').values({
      repository_id: this.repositoryId,
      lock_id: lock.id,
      path: lock.path,
      owner_id: Number(lock.ownerId),
      owner_name: lock.owner.name,
      ref: lock.ref ?? null,
      locked_at: lock.locked_at,
    }).execute()
  }

  async remove(id: string): Promise<void> {
    await db
      .deleteFrom('repository_lfs_locks')
      .where('repository_id', '=', this.repositoryId)
      .where('lock_id', '=', id)
      .execute()
  }
}

function toRecord(row: any): LockRecord {
  return {
    id: String(row.lock_id),
    path: String(row.path),
    locked_at: String(row.locked_at),
    owner: { name: String(row.owner_name) },
    ownerId: Number(row.owner_id),
    ref: row.ref ? String(row.ref) : undefined,
  }
}

/** The actor a lock is taken by, from whoever the request authenticated as. */
export function actorFrom(user: { id: unknown, name?: unknown, handle?: unknown } | null | undefined, mayForce = false): Actor | undefined {
  if (!user || user.id === undefined || user.id === null)
    return undefined

  const name = String(user.handle ?? user.name ?? '').trim()

  return { id: Number(user.id), name: name || `user ${user.id}`, mayForce }
}

/** Where an object lives on disk, for the maintenance sweep and size accounting. */
export function objectPathIn(owner: string, name: string, oid: string): string {
  return join(storeRoot(owner, name), oid.slice(0, 2), oid.slice(2, 4), oid)
}

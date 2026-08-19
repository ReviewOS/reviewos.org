/**
 * Rebuilding a repository from the database and the blob store.
 *
 * This is what "disk is a cache" means in practice. A node that does not have
 * a repository, or has one whose refs have fallen behind the ledger, fetches
 * the checkpoint bundle and the write-ahead log suffix and puts the refs where
 * the ledger says - and then serves it.
 *
 * Kept out of `storage.ts` deliberately: that module is the path builder every
 * git route already imports, and it must not drag the blob store, the log and
 * the ledger into every one of them. `ensureLocal` reaches in here only when
 * something is actually missing.
 *
 * ## The one rule
 *
 * **Materializing never destroys.** A repository that is present but divergent
 * is topped up - objects fetched, refs moved forward - and one that is absent
 * is built from nothing. Nothing here removes a repository or a ref that the
 * ledger does not know about, because the ledger deliberately does not track
 * every ref a repository may legitimately hold (notes, a mirror's remotes, a
 * stash), and "tidying" those would delete somebody's data to make an index
 * look right.
 */

import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { db } from '@stacksjs/database'
import { blobStore } from './blobs'
import { latestCheckpoint } from './checkpoint'
import { initBare, runGit } from './git'
import { ledgerFor, writeLedgerToDisk } from './refs'
import { entriesFor } from './wal'

export interface MaterializeOutcome {
  ok: boolean
  /** Whether the repository had to be created rather than topped up. */
  created: boolean
  bundlesFetched: number
  refsWritten: number
  reason?: string
}

/**
 * Bring a repository on this node up to what the database says it is.
 *
 * Returns `ok: false` with a reason when it cannot - a repository with no
 * checkpoint and no log has nothing to materialize *from*, which on a
 * single-node instance is every repository and is why this is only reached
 * when something is already wrong.
 */
export async function materialize(
  repositoryId: number,
  repositoryPath: string,
  options: { defaultBranch?: string } = {},
): Promise<MaterializeOutcome> {
  const outcome: MaterializeOutcome = { ok: false, created: false, bundlesFetched: 0, refsWritten: 0 }

  const ledger = await ledgerFor(repositoryId)

  if (ledger.length === 0) {
    outcome.reason = 'the ledger has no refs for this repository, so there is nothing to materialize to'

    return outcome
  }

  const present = await Bun.file(join(repositoryPath, 'HEAD')).exists()

  if (!present) {
    await mkdir(dirname(repositoryPath), { recursive: true })
    const created = await initBare(repositoryPath, options.defaultBranch ?? 'main')

    if (!created.ok) {
      outcome.reason = `the repository could not be created: ${created.stderr}`

      return outcome
    }

    outcome.created = true
  }

  const store = await blobStore()
  const scratch = join(repositoryPath, 'materialize')
  await mkdir(scratch, { recursive: true })

  /*
   * The checkpoint first, then the log after it.
   *
   * A bundle's prerequisites are commits it does not contain, so order is
   * load bearing rather than tidy: entry N+1 can only be fetched once N is
   * in. The checkpoint's sequence says where the suffix starts.
   */
  const checkpoint = await latestCheckpoint(repositoryId, store)

  if (checkpoint) {
    if (await fetchBundle(store, checkpoint.key, scratch, repositoryPath))
      outcome.bundlesFetched += 1
  }

  const entries = await entriesFor(repositoryId)

  for (const entry of entries) {
    if (entry.status === 'void' || !entry.blobKey)
      continue

    // Everything the checkpoint already carries is skipped rather than
    // re-fetched: it is the same objects, and on a busy repository that is
    // the difference between a fast materialization and a pointless one.
    if (checkpoint && entry.sequence <= checkpoint.sequence)
      continue

    if (await fetchBundle(store, entry.blobKey, scratch, repositoryPath))
      outcome.bundlesFetched += 1
  }

  /*
   * The refs last, from the ledger rather than from the bundles.
   *
   * The bundles carry whatever ref names they were made under - including the
   * `refs/reviewos-wal/*` the log parks tips beneath - and those are an
   * artefact of how the objects travelled. Where the refs *belong* is the
   * ledger's answer, which is the whole point of the ledger.
   */
  const written = await writeLedgerToDisk(repositoryPath, ledger)
  outcome.refsWritten = written.written

  if (written.failed.length > 0) {
    // Partial rather than silent: the objects for a ref may genuinely not have
    // arrived, and a node that then serves that ref would be serving a
    // dangling pointer.
    outcome.reason = `some refs could not be written: ${written.failed.slice(0, 3).join('; ')}`
  }

  outcome.ok = outcome.refsWritten > 0

  return outcome
}

/** Fetch one bundle from the store into the repository. */
async function fetchBundle(
  store: Awaited<ReturnType<typeof blobStore>>,
  key: string,
  scratch: string,
  repositoryPath: string,
): Promise<boolean> {
  const stream = await store.get(key).catch(() => null)

  if (!stream)
    return false

  const path = join(scratch, `${key.replace(/[^A-Za-z0-9]/g, '-')}.bundle`)
  await Bun.write(path, await new Response(stream).arrayBuffer())

  // `--force` because the log is the authority: an entry moving a ref
  // backwards is a force push that really happened, and refusing to replay it
  // would materialize a repository that never existed.
  const fetched = await runGit(repositoryPath, ['fetch', '--force', path, '+refs/*:refs/*'], {
    timeoutMs: 30 * 60_000,
    priority: 'background',
  })

  return fetched.ok
}

/** The repository row for a path, for callers that only know where it lives. */
export async function repositoryIdFor(owner: string, name: string): Promise<number | null> {
  for (const table of ['users', 'organizations'] as const) {
    const found: any = await db
      .selectFrom(table)
      .select(['id'])
      .where('handle', '=', owner)
      .executeTakeFirst()
      .catch(() => null)

    if (!found)
      continue

    const repository: any = await db
      .selectFrom('repositories')
      .select(['id'])
      .where('owner_type', '=', table === 'users' ? 'user' : 'organization')
      .where('owner_id', '=', Number(found.id))
      .where('name', '=', name)
      .executeTakeFirst()
      .catch(() => null)

    if (repository)
      return Number(repository.id)
  }

  return null
}

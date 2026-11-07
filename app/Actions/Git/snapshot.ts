import type { BlobStore } from './blobs'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, statfs } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { blobDigest } from '../Storage/transfer'
import { LocalBlobStore } from './blobs'
import { repositoryPath, REPOSITORY_ROOT } from './storage'
import { refsOnDisk } from './refs'
import { runGit } from './git'

// Keep background Git compression bounded on a shared application host.
const SNAPSHOT_GIT_OPTIONS = ['-c', 'pack.threads=2', '-c', 'pack.windowMemory=128m', '-c', 'pack.deltaCacheSize=64m']

/** A portable Git snapshot. The live bare repository is never removed or modified. */
export async function snapshotRepository(repository: { id: number, owner: string, name: string }, store: BlobStore, options: { repositoryRoot?: string, scratchRoot?: string } = {}) {
  const located = repositoryPath(repository.owner, repository.name, options.repositoryRoot ?? REPOSITORY_ROOT)
  if (!located.ok) throw new Error('Invalid repository snapshot identity')
  if (!await Bun.file(join(located.path!, 'HEAD')).exists()) throw new Error('Repository storage is unavailable; no snapshot was claimed')
  const refs = [...(await refsOnDisk(located.path!)).entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
  if (!refs.length) return { empty: true, bytes: 0 }
  const headResult = await runGit(located.path!, ['symbolic-ref', '-q', 'HEAD'], { priority: 'background' })
  const head = headResult.ok ? headResult.stdout.trim() : null
  const revision = createHash('sha256').update(JSON.stringify({ refs, head })).digest('hex')
  const manifestKey = `repositories/${repository.id}/snapshots/${revision}.json`
  const existing = await store.get(manifestKey)
  if (existing) {
    const manifest = await new Response(existing).json() as { key: string, bytes: number, revision: string }
    if (manifest.revision !== revision || !manifest.key.startsWith(`repositories/${repository.id}/bundles/`)) throw new Error('Invalid stored repository manifest')
    const object = await store.stat(manifest.key)
    if (!object || object.size !== manifest.bytes) throw new Error('Stored repository snapshot is incomplete')
    return { empty: false, bytes: manifest.bytes, manifestKey, unchanged: true }
  }
  const scratchRoot = resolve(options.scratchRoot || process.env.BLOB_SCRATCH_ROOT || 'storage/scratch/object-storage')
  await mkdir(scratchRoot, { recursive: true })
  const capacity = await statfs(scratchRoot)
  const objectCount = await runGit(located.path!, ['count-objects', '-v'], { priority: 'background' })
  if (!objectCount.ok) throw new Error('Cannot inspect repository snapshot capacity')
  const reported = Object.fromEntries(objectCount.stdout.trim().split('\n').map(line => line.split(': ')))
  const required = (Number(reported.size) + Number(reported['size-pack'])) * 1024 * 2 + 5 * 1024 ** 3
  if (!Number.isFinite(required) || capacity.bavail * capacity.bsize < required) throw new Error('Repository snapshot scratch volume needs at least 5 GiB free')
  const scratch = await mkdtemp(join(scratchRoot, 'repository-snapshot-'))
  try {
    const file = join(scratch, 'repository.bundle')
    const created = await runGit(located.path!, [...SNAPSHOT_GIT_OPTIONS, 'bundle', 'create', file, '--all'], { timeoutMs: 50 * 60_000, priority: 'background' })
    if (!created.ok) throw new Error(`Repository bundle failed: ${created.stderr.slice(-500)}`)
    const restored = await runGit(scratch, [...SNAPSHOT_GIT_OPTIONS, 'clone', '--mirror', file, join(scratch, 'restored.git')], { timeoutMs: 50 * 60_000, priority: 'background' })
    if (!restored.ok) throw new Error('Snapshot could not be restored into a new bare repository')
    if (head) { const restoredHead = await runGit(join(scratch, 'restored.git'), ['symbolic-ref', 'HEAD', head]); if (!restoredHead.ok) throw new Error('Could not restore snapshot default branch') }
    const restoredRefs = [...(await refsOnDisk(join(scratch, 'restored.git'))).entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    // Git captured its own consistent ref set while the live repository stayed writable.
    const snapshotRevision = createHash('sha256').update(JSON.stringify({ refs: restoredRefs, head })).digest('hex')
    const snapshotManifestKey = `repositories/${repository.id}/snapshots/${snapshotRevision}.json`
    const source = new LocalBlobStore(scratch)
    const digest = await blobDigest(source, 'repository.bundle')
    const key = `repositories/${repository.id}/bundles/${digest.sha256}.bundle`
    const present = await store.stat(key)
    if (!present) await store.put(key, Bun.file(file).stream())
    const remote = await blobDigest(store, key)
    if (remote.sha256 !== digest.sha256 || remote.bytes !== digest.bytes) throw new Error('Repository snapshot round-trip checksum failed')
    const manifest = JSON.stringify({ version: 1, repositoryId: repository.id, owner: repository.owner, name: repository.name, revision: snapshotRevision,
      key, sha256: digest.sha256, bytes: digest.bytes, refs: restoredRefs, head, verifiedAt: new Date().toISOString() })
    await store.put(snapshotManifestKey, manifest)
    if ((await blobDigest(store, snapshotManifestKey)).sha256 !== createHash('sha256').update(manifest).digest('hex')) throw new Error('Repository manifest verification failed')
    return { empty: false, bytes: digest.bytes, manifestKey: snapshotManifestKey, unchanged: false }
  } finally { await rm(scratch, { recursive: true, force: true }) }
}

/** Restore into a new directory only; never replace the working repository. */
export async function restoreRepositorySnapshot(repositoryId: number, manifestKey: string, destination: string, store: BlobStore, options: { scratchRoot?: string } = {}) {
  if (!Number.isSafeInteger(repositoryId) || repositoryId < 1 || !manifestKey.startsWith(`repositories/${repositoryId}/snapshots/`)) throw new Error('Invalid repository snapshot selection')
  if (!destination.startsWith('/') || destination === '/') throw new Error('Restore destination must be an absolute new directory')
  const { lstat } = await import('node:fs/promises')
  try { await lstat(destination); throw new Error('Restore destination already exists; no files were changed') } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  const body = await store.get(manifestKey)
  if (!body) throw new Error('Repository snapshot manifest is missing')
  const manifest = await new Response(body).json() as { repositoryId: number, key: string, sha256: string, bytes: number, head?: string, refs: string[][] }
  if (manifest.repositoryId !== repositoryId || !manifest.key.startsWith(`repositories/${repositoryId}/bundles/`) || !/^[a-f0-9]{64}$/.test(manifest.sha256) || !Array.isArray(manifest.refs)) throw new Error('Invalid repository snapshot manifest')
  const base = resolve(options.scratchRoot || process.env.BLOB_SCRATCH_ROOT || 'storage/scratch/object-storage')
  await mkdir(base, { recursive: true })
  const scratch = await mkdtemp(join(base, 'repository-restore-'))
  try {
    const stream = await store.get(manifest.key)
    if (!stream) throw new Error('Repository snapshot bundle is missing')
    const file = join(scratch, 'repository.bundle')
    await Bun.write(file, new Response(stream))
    const digest = await blobDigest(new LocalBlobStore(scratch), 'repository.bundle')
    if (digest.sha256 !== manifest.sha256 || digest.bytes !== manifest.bytes) throw new Error('Repository restore checksum failed')
    const restored = await runGit(scratch, [...SNAPSHOT_GIT_OPTIONS, 'clone', '--mirror', file, destination], { timeoutMs: 50 * 60_000, priority: 'background' })
    if (!restored.ok) throw new Error('Repository snapshot restore failed; existing repositories were preserved')
    if (manifest.head) {
      const head = await runGit(destination, ['symbolic-ref', 'HEAD', manifest.head])
      if (!head.ok) throw new Error('Repository default branch could not be restored')
    }
    const refs = [...(await refsOnDisk(destination)).entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    if (JSON.stringify(refs) !== JSON.stringify(manifest.refs)) throw new Error('Restored repository refs differ from the verified manifest')
    return { repositoryId, destination, refs: refs.length, bytes: digest.bytes, sha256: digest.sha256 }
  } finally { await rm(scratch, { recursive: true, force: true }) }
}

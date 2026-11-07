import type { BlobStore } from './blobs'
import { createHash } from 'node:crypto'
import { statfs } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { blobDigest } from '../Storage/transfer'
import { LocalBlobStore } from './blobs'
import { repositoryPath, REPOSITORY_ROOT } from './storage'
import { refsOnDisk } from './refs'
import { runGit } from './git'
import { createRepositoryWorkspace } from './snapshotWorkspace'

// Keep background Git compression bounded on a shared application host.
const SNAPSHOT_GIT_OPTIONS = ['-c', 'pack.threads=2', '-c', 'pack.windowMemory=128m', '-c', 'pack.deltaCacheSize=64m', '-c', 'core.deltaBaseCacheLimit=256m']
// Bound each durable queue phase to 90 minutes of Git work. Large bundles
// must not recompress on every verification retry. The existing two-hour job
// leaves 30 minutes for object transfer and checkpoint cleanup.
const REPOSITORY_GIT_BUDGET_MS = 90 * 60_000

interface RepositoryCandidate {
  version: number
  repositoryId: number
  revision: string
  key: string
  sha256: string
  bytes: number
  head: string | null
  refs: string[][]
  snapshotRevision: string
}

interface SnapshotResult {
  empty: boolean
  bytes: number
  manifestKey?: string
  unchanged?: boolean
  pending?: boolean
  candidateKey?: string
}

/** A portable Git snapshot. The live bare repository is never removed or modified. */
export async function snapshotRepository(repository: { id: number, owner: string, name: string }, store: BlobStore, options: {
  repositoryRoot?: string, scratchRoot?: string, prepareBatch?: boolean, candidateKey?: string
} = {}): Promise<SnapshotResult> {
  const located = repositoryPath(repository.owner, repository.name, options.repositoryRoot ?? REPOSITORY_ROOT)
  if (!located.ok) throw new Error('Invalid repository snapshot identity')
  if (!await Bun.file(join(located.path!, 'HEAD')).exists()) throw new Error('Repository storage is unavailable; no snapshot was claimed')
  const refs = [...(await refsOnDisk(located.path!, { strict: true })).entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
  if (!refs.length && !options.candidateKey) return { empty: true, bytes: 0 }
  const headResult = await runGit(located.path!, ['symbolic-ref', '-q', 'HEAD'], { priority: 'background' })
  const head = headResult.ok ? headResult.stdout.trim() : null
  const revision = createHash('sha256').update(JSON.stringify({ refs, head })).digest('hex')
  const manifestKey = `repositories/${repository.id}/snapshots/${revision}.json`
  const existing = !options.candidateKey && await store.get(manifestKey)
  if (existing) {
    const manifest = await new Response(existing).json() as { key: string, bytes: number, revision: string }
    if (manifest.revision !== revision || !manifest.key.startsWith(`repositories/${repository.id}/bundles/`)) throw new Error('Invalid stored repository manifest')
    const object = await store.stat(manifest.key)
    if (!object || object.size !== manifest.bytes) throw new Error('Stored repository snapshot is incomplete')
    return { empty: false, bytes: manifest.bytes, manifestKey, unchanged: true }
  }
  // Candidates are durable preparation checkpoints, never verified backups.
  // Pin a queued continuation to its candidate even if the live refs change.
  const candidatePrefix = `repositories/${repository.id}/candidates/`
  const candidateKey = options.candidateKey || `${candidatePrefix}${revision}.json`
  const candidateRevision = candidateKey.slice(candidatePrefix.length, -5)
  if (!candidateKey.startsWith(candidatePrefix) || !/^[a-f0-9]{64}$/.test(candidateRevision) || !candidateKey.endsWith('.json')) throw new Error('Invalid repository preparation checkpoint')
  const storedCandidate = await store.get(candidateKey)
  let candidate: RepositoryCandidate | null = storedCandidate ? await new Response(storedCandidate).json() : null
  if (options.candidateKey && !candidate) throw new Error('Repository preparation checkpoint is missing; no backup was claimed')
  if (candidate && (candidate.version !== 1 || candidate.repositoryId !== repository.id || candidate.revision !== candidateRevision
    || !/^[a-f0-9]{64}$/.test(candidate.sha256) || candidate.key !== `repositories/${repository.id}/bundles/${candidate.sha256}.bundle`
    || !Number.isSafeInteger(candidate.bytes) || candidate.bytes < 1
    || !Array.isArray(candidate.refs) || !candidate.refs.length || candidate.refs.some(ref => !Array.isArray(ref) || ref.length !== 2 || typeof ref[0] !== 'string' || !ref[0].startsWith('refs/') || !/^[a-f0-9]{40}$/.test(ref[1]!))
    || candidate.snapshotRevision !== createHash('sha256').update(JSON.stringify({ refs: candidate.refs, head: candidate.head })).digest('hex')
    || (candidate.head !== null && (typeof candidate.head !== 'string' || !candidate.head.startsWith('refs/'))))) throw new Error('Invalid repository preparation checkpoint')
  if (candidate) {
    const completedKey = `repositories/${repository.id}/snapshots/${candidate.snapshotRevision}.json`
    const completed = await store.get(completedKey)
    if (completed) {
      const manifest = await new Response(completed).json() as any
      const object = await store.stat(candidate.key)
      if (manifest.repositoryId !== repository.id || manifest.revision !== candidate.snapshotRevision || manifest.key !== candidate.key
        || manifest.sha256 !== candidate.sha256 || manifest.bytes !== candidate.bytes || !manifest.verifiedAt
        || JSON.stringify(manifest.refs) !== JSON.stringify(candidate.refs) || manifest.head !== candidate.head || object?.size !== candidate.bytes) throw new Error('Completed repository preparation proof is invalid')
      return { empty: false, bytes: candidate.bytes, manifestKey: completedKey, unchanged: true }
    }
  }
  const scratchRoot = resolve(options.scratchRoot || process.env.BLOB_SCRATCH_ROOT || 'storage/scratch/object-storage')
  const workspace = await createRepositoryWorkspace(scratchRoot, `snapshot-${repository.id}`)
  const scratch = workspace.path
  const deadline = performance.now() + REPOSITORY_GIT_BUDGET_MS
  try {
    const capacity = await statfs(scratchRoot)
    const objectCount = await runGit(located.path!, ['count-objects', '-v'], { priority: 'background' })
    if (!objectCount.ok) throw new Error('Cannot inspect repository snapshot capacity')
    const reported = Object.fromEntries(objectCount.stdout.trim().split('\n').map(line => line.split(': ')))
    const required = (candidate?.bytes ?? (Number(reported.size) + Number(reported['size-pack'])) * 1024) * 2 + 5 * 1024 ** 3
    if (!Number.isFinite(required) || capacity.bavail * capacity.bsize < required) throw new Error('Repository snapshot scratch volume needs at least 5 GiB free')
    const file = join(scratch, 'repository.bundle')
    const source = new LocalBlobStore(scratch)
    if (!candidate) {
      const created = await runGit(located.path!, [...SNAPSHOT_GIT_OPTIONS, 'bundle', 'create', file, '--all'], { timeoutMs: REPOSITORY_GIT_BUDGET_MS, deadline, priority: 'background' })
      if (!created.ok) throw new Error(`Repository bundle failed: ${created.stderr.slice(-500)}`)
      const digest = await blobDigest(source, 'repository.bundle')
      const key = `repositories/${repository.id}/bundles/${digest.sha256}.bundle`
      if (!await store.stat(key)) await store.put(key, Bun.file(file).stream())
      const remote = await blobDigest(store, key)
      if (remote.sha256 !== digest.sha256 || remote.bytes !== digest.bytes) throw new Error('Repository snapshot round-trip checksum failed')
      const listed = await runGit(scratch, ['bundle', 'list-heads', file], { deadline, priority: 'background' })
      if (!listed.ok || listed.truncated) throw new Error('Cannot inspect prepared repository refs')
      const bundleRefs = listed.stdout.trim().split('\n').map(line => line.split(' ')).filter(([sha, ref]) => /^[a-f0-9]{40}$/.test(sha!) && ref?.startsWith('refs/')).map(([sha, ref]) => [ref!, sha!]).sort(([a], [b]) => a! < b! ? -1 : a! > b! ? 1 : 0)
      if (!bundleRefs.length) throw new Error('Prepared repository contains no advertised refs')
      const snapshotRevision = createHash('sha256').update(JSON.stringify({ refs: bundleRefs, head })).digest('hex')
      candidate = { version: 1, repositoryId: repository.id, revision, key, sha256: digest.sha256, bytes: digest.bytes, head, refs: bundleRefs, snapshotRevision }
      const prepared = JSON.stringify(candidate)
      await store.put(candidateKey, prepared)
      if ((await blobDigest(store, candidateKey)).sha256 !== createHash('sha256').update(prepared).digest('hex')) throw new Error('Repository preparation checkpoint verification failed')
      // The next native queue batch restores this exact durable bundle. Its
      // Git budget is independent of compression, without extending any job.
      if (options.prepareBatch) return { empty: false, bytes: 0, pending: true, candidateKey }
    }
    else {
      const stream = await store.get(candidate.key)
      if (!stream) throw new Error('Prepared repository bundle is missing')
      await Bun.write(file, new Response(stream))
      const downloaded = await blobDigest(source, 'repository.bundle')
      if (downloaded.sha256 !== candidate.sha256 || downloaded.bytes !== candidate.bytes) throw new Error('Prepared repository bundle checksum failed; no backup was claimed')
    }
    const restored = await runGit(scratch, [...SNAPSHOT_GIT_OPTIONS, 'clone', '--mirror', file, join(scratch, 'restored.git')], { timeoutMs: REPOSITORY_GIT_BUDGET_MS, deadline, priority: 'background' })
    if (!restored.ok) throw new Error(`Snapshot could not be restored into a new bare repository: ${restored.stderr.slice(-500)}`)
    if (candidate.head) { const restoredHead = await runGit(join(scratch, 'restored.git'), ['symbolic-ref', 'HEAD', candidate.head]); if (!restoredHead.ok) throw new Error('Could not restore snapshot default branch') }
    const restoredRefs = [...(await refsOnDisk(join(scratch, 'restored.git'), { strict: true })).entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    if (JSON.stringify(restoredRefs) !== JSON.stringify(candidate.refs)) throw new Error('Restored repository differs from its prepared refs')
    const snapshotRevision = candidate.snapshotRevision
    const snapshotManifestKey = `repositories/${repository.id}/snapshots/${snapshotRevision}.json`
    const manifest = JSON.stringify({ version: 1, repositoryId: repository.id, owner: repository.owner, name: repository.name, revision: snapshotRevision,
      key: candidate.key, sha256: candidate.sha256, bytes: candidate.bytes, refs: restoredRefs, head: candidate.head, verifiedAt: new Date().toISOString() })
    await store.put(snapshotManifestKey, manifest)
    if ((await blobDigest(store, snapshotManifestKey)).sha256 !== createHash('sha256').update(manifest).digest('hex')) throw new Error('Repository manifest verification failed')
    return { empty: false, bytes: candidate.bytes, manifestKey: snapshotManifestKey, unchanged: false }
  } finally { workspace.complete() }
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
  const workspace = await createRepositoryWorkspace(base, `restore-${repositoryId}`)
  const scratch = workspace.path
  try {
    const capacity = await statfs(base)
    if (!Number.isSafeInteger(manifest.bytes) || manifest.bytes < 1 || capacity.bavail * capacity.bsize < manifest.bytes * 2 + 5 * 1024 ** 3) throw new Error('Repository restore scratch volume needs room for the bundle, restored objects and 5 GiB free')
    const stream = await store.get(manifest.key)
    if (!stream) throw new Error('Repository snapshot bundle is missing')
    const file = join(scratch, 'repository.bundle')
    await Bun.write(file, new Response(stream))
    const digest = await blobDigest(new LocalBlobStore(scratch), 'repository.bundle')
    if (digest.sha256 !== manifest.sha256 || digest.bytes !== manifest.bytes) throw new Error('Repository restore checksum failed')
    const restored = await runGit(scratch, [...SNAPSHOT_GIT_OPTIONS, 'clone', '--mirror', file, destination], { timeoutMs: REPOSITORY_GIT_BUDGET_MS, priority: 'background' })
    if (!restored.ok) throw new Error(`Repository snapshot restore failed; existing repositories were preserved: ${restored.stderr.slice(-500)}`)
    if (manifest.head) {
      const head = await runGit(destination, ['symbolic-ref', 'HEAD', manifest.head])
      if (!head.ok) throw new Error('Repository default branch could not be restored')
    }
    const refs = [...(await refsOnDisk(destination, { strict: true })).entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    if (JSON.stringify(refs) !== JSON.stringify(manifest.refs)) throw new Error('Restored repository refs differ from the verified manifest')
    return { repositoryId, destination, refs: refs.length, bytes: digest.bytes, sha256: digest.sha256 }
  } finally { workspace.complete() }
}

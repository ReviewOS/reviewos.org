import type { BlobStore } from '../Git/blobs'
import { createHash } from 'node:crypto'

/** Metadata stays bounded even when a page contains many tiny objects. */
export const TRANSFER_PAGE_SIZE = 512
export function boundedTransferBatch<T extends { size: number }>(files: T[]): T[] {
  const batch: T[] = []; let bytes = 0
  for (const file of files.slice(0, TRANSFER_PAGE_SIZE)) {
    if (batch.length && bytes + file.size > 512 * 1024 * 1024) break
    batch.push(file); bytes += file.size
  }
  return batch
}

/** Hash incrementally. Migration never treats size or an S3 ETag as proof. */
export async function blobDigest(store: BlobStore, key: string): Promise<{ sha256: string, bytes: number }> {
  const stream = await store.get(key)
  if (!stream) throw new Error(`Missing transfer object: ${key}`)
  const hash = createHash('sha256'); let bytes = 0
  for await (const chunk of stream) { hash.update(chunk); bytes += chunk.byteLength }
  return { sha256: hash.digest('hex'), bytes }
}

/** Preserve existing objects, including a conflicting destination, and all source bytes. */
export async function copyVerifiedBlob(source: BlobStore, target: BlobStore, key: string, options: { receiptScope?: string } = {}): Promise<{ bytes: number, copied: boolean }> {
  const local = await source.stat(key)
  if (!local) throw new Error(`Missing transfer source: ${key}`)
  const existing = await target.stat(key)
  const receiptKey = options.receiptScope && /^[a-f0-9]{64}$/.test(options.receiptScope)
    ? `migration-proofs/${options.receiptScope}/${createHash('sha256').update(key).digest('hex')}.json` : null
  if (receiptKey && local.fingerprint && existing?.etag) {
    const stored = await target.get(receiptKey)
    if (stored) {
      const proof = await new Response(stored).json() as { key: string, fingerprint: string, etag: string, bytes: number }
      if (proof.key === key && proof.fingerprint === local.fingerprint && proof.etag === existing.etag && proof.bytes === local.size && existing.size === local.size)
        return { bytes: local.size, copied: false }
    }
  }
  const before = await blobDigest(source, key)
  const receipt = async (): Promise<void> => {
    const current = await source.stat(key)
    if (local.fingerprint && current?.fingerprint !== local.fingerprint) throw new Error(`Transfer source changed; retry required: ${key}`)
    const remote = await target.stat(key)
    if (receiptKey && local.fingerprint && remote?.etag) await target.put(receiptKey, JSON.stringify({ key, fingerprint: local.fingerprint,
      etag: remote.etag, bytes: before.bytes, sha256: before.sha256, verifiedAt: new Date().toISOString() }))
  }
  if (existing) {
    const remote = await blobDigest(target, key)
    if (remote.sha256 !== before.sha256 || remote.bytes !== before.bytes) throw new Error(`Destination conflict, both copies preserved: ${key}`)
    await receipt()
    return { bytes: before.bytes, copied: false }
  }
  const stream = await source.get(key)
  if (!stream) throw new Error(`Transfer source disappeared: ${key}`)
  await target.put(key, stream)
  const after = await blobDigest(target, key)
  if (after.sha256 !== before.sha256 || after.bytes !== before.bytes) throw new Error(`Transfer checksum mismatch: ${key}`)
  await receipt()
  return { bytes: after.bytes, copied: true }
}


/** Four active streams, filling free slots while checkpoints remain strictly ordered. */
export async function copyVerifiedBlobs(source: BlobStore, target: BlobStore, files: Array<{ key: string }>, options: { receiptScope?: string }, verified: (key: string, result: { bytes: number, copied: boolean }) => void) {
  const completed: Array<{ bytes: number, copied: boolean } | undefined> = new Array(files.length)
  const failures: Array<{ index: number, error: unknown }> = []
  let next = 0; let cursor = 0; let stopped = false; let checkpointFailed = false
  const flush = () => {
    if (checkpointFailed) return
    while (completed[cursor]) {
      try { verified(files[cursor]!.key, completed[cursor]!) }
      catch (error) { checkpointFailed = true; throw error }
      cursor += 1
    }
  }
  const run = async () => {
    while (!stopped && next < files.length) {
      const index = next++
      try {
        completed[index] = await copyVerifiedBlob(source, target, files[index]!.key, options)
        flush()
      } catch (error) { failures.push({ index, error }); stopped = true }
    }
  }
  // Each slot catches its own failure. All active copies drain before any
  // failure escapes; a slow early key never idles the other available slots.
  await Promise.all(Array.from({ length: Math.min(4, files.length) }, run))
  if (failures.length) throw failures.sort((a, b) => a.index - b.index)[0]!.error
}

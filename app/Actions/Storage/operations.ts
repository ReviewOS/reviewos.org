import { db } from '@stacksjs/database'
import { transaction } from '@stacksjs/orm'
import { captureProcessLeaseOwner, processLeaseOwnerStatus } from '@stacksjs/queue'
import { randomUUID, createHash } from 'node:crypto'
import process from 'node:process'
import { s3StoreFromEnvironment } from '../Git/blobsS3'
import { dbTimestamp } from '../Support/sql'

export function transferTarget(): { bucket: string, provider: string, prefix: string, fingerprint: string } {
  const bucket = String(process.env.BLOB_MIGRATION_S3_BUCKET || process.env.BLOB_S3_BUCKET || '').trim()
  const provider = String(process.env.BLOB_S3_PROVIDER || 'hetzner').trim()
  const prefix = String(process.env.BLOB_S3_PREFIX || '').trim()
  if (!bucket) throw new Error('No object storage migration destination is configured')
  return { bucket, provider, prefix, fingerprint: createHash('sha256').update(JSON.stringify({ bucket, provider, prefix })).digest('hex') }
}

export async function transferStore() {
  const target = transferTarget()
  // Cold missing-object lookups have taken almost a minute at the provider.
  // Bulk jobs can allow that bounded response without changing interactive defaults.
  const store = await s3StoreFromEnvironment({ ...target, metadataTimeoutMs: 120_000 })
  if (!store) throw new Error('Object storage migration destination unavailable')
  return store
}

export async function startTransfer(kind: 'storage.blobs' | 'storage.repositories'): Promise<number> {
  const target = transferTarget()
  const now = dbTimestamp()
  const found = await db.insertInto('operations').values({ uuid: randomUUID(), kind, status: 'queued', actor_id: null,
    result: JSON.stringify({ fingerprint: target.fingerprint, cursor: '', verified: 0, bytes: 0 }), created_at: now, updated_at: now } as any).returning(['id']).executeTakeFirst()
  if (!found?.id) throw new Error('Could not create storage transfer operation')
  return Number(found.id)
}

/** A DB compare-and-swap lease also protects against a retried queue reservation. */
export async function claimTransfer(kind: string, operationId?: number) {
  let query = db.selectFrom('operations').selectAll().where('kind', '=', kind)
  if (operationId) query = query.where('id', '=', operationId)
  else query = query.where('status', 'in', ['queued', 'running']).orderBy('id', 'asc').limit(1)
  const row: any = await query.executeTakeFirst()
  if (!row || ['succeeded', 'cancelled', 'failed'].includes(row.status)) return null
  const progress = JSON.parse(String(row.result || '{}'))
  if (row.status === 'running') {
    const owner = processLeaseOwnerStatus(progress.owner)
    if (owner === 'alive') return null
    if (owner !== 'dead' && Date.now() - Date.parse(String(row.started_at)) < (kind === 'storage.repositories' ? 150 : 35) * 60_000) return null
  }
  if (progress.fingerprint !== transferTarget().fingerprint) throw new Error('Storage destination changed; resume requires the original configuration')
  const lease = new Date().toISOString()
  progress.owner = captureProcessLeaseOwner()
  let claim = db.updateTable('operations').set({ status: 'running', started_at: lease, error: null, result: JSON.stringify(progress) }).where('id', '=', row.id).where('status', '=', row.status)
  claim = claim.where('result', '=', row.result)
  if (row.started_at) claim = claim.where('started_at', '=', row.started_at)
  const claimed = await claim.executeTakeFirst()
  if (Number(claimed.numUpdatedRows) !== 1) return null
  return { row, progress, lease }
}

/** Cancel the operation identity; its checkpoint and every source remain intact. */
export async function cancelTransfer(operationId: number): Promise<void> {
  if (!Number.isSafeInteger(operationId) || operationId < 1) throw new Error('Invalid transfer operation')
  const row: any = await db.selectFrom('operations').select(['kind', 'status']).where('id', '=', operationId).executeTakeFirst()
  if (!row || !['storage.blobs', 'storage.repositories'].includes(row.kind)) throw new Error('Storage transfer not found')
  if (row.status === 'cancelled') return
  if (!['queued', 'running'].includes(row.status)) throw new Error('Only an unfinished transfer can be cancelled')
  const result = await db.updateTable('operations').set({ status: 'cancelled', finished_at: new Date().toISOString() })
    .where('id', '=', operationId).where('status', '=', row.status).executeTakeFirst()
  if (Number(result.numUpdatedRows) !== 1) throw new Error('Transfer changed before cancellation; inspect its current state')
}

/** An explicit restart creates a new identity, preserving the last durable prefix. */
export async function restartTransfer(operationId: number): Promise<{ id: number, kind: 'storage.blobs' | 'storage.repositories' }> {
  if (!Number.isSafeInteger(operationId) || operationId < 1) throw new Error('Invalid transfer operation')
  return transaction(async (tx) => {
    const row: any = await tx.selectFrom('operations').selectAll().where('id', '=', operationId).lockForUpdate().executeTakeFirst()
    if (!row || !['storage.blobs', 'storage.repositories'].includes(row.kind)) throw new Error('Storage transfer not found')
    if (!['cancelled', 'failed'].includes(row.status)) throw new Error('Cancel an unfinished transfer before restarting it')
    const progress = JSON.parse(String(row.result || '{}'))
    if (progress.fingerprint !== transferTarget().fingerprint) throw new Error('Storage destination changed; checkpoint restart refused')
    if (progress.successorOperationId) return { id: Number(progress.successorOperationId), kind: row.kind }
    if (typeof progress.cursor !== 'string' || !Number.isSafeInteger(progress.verified) || progress.verified < 0
      || !Number.isSafeInteger(progress.bytes) || progress.bytes < 0) throw new Error('Invalid saved transfer checkpoint')
    const now = dbTimestamp()
    const next: any = await tx.insertInto('operations').values({ uuid: randomUUID(), kind: row.kind, status: 'queued', actor_id: row.actor_id,
      result: JSON.stringify({ fingerprint: progress.fingerprint, cursor: progress.cursor, verified: progress.verified, bytes: progress.bytes, restartedFrom: operationId }),
      created_at: now, updated_at: now } as any).returning(['id']).executeTakeFirst()
    if (!next?.id) throw new Error('Could not create replacement transfer')
    await tx.updateTable('operations').set({ result: JSON.stringify({ ...progress, successorOperationId: Number(next.id) }) }).where('id', '=', operationId).execute()
    return { id: Number(next.id), kind: row.kind }
  })
}

export async function saveTransfer(claim: NonNullable<Awaited<ReturnType<typeof claimTransfer>>>, complete: boolean, error?: unknown): Promise<void> {
  const result = await db.updateTable('operations').set({ status: error ? 'queued' : complete ? 'succeeded' : 'queued',
    result: JSON.stringify(claim.progress), error: error ? String(error).slice(0, 2000) : null,
    finished_at: complete ? new Date().toISOString() : null }).where('id', '=', claim.row.id).where('status', '=', 'running').where('started_at', '=', claim.lease).executeTakeFirst()
  if (Number(result.numUpdatedRows) !== 1) throw new Error('Storage operation lease changed before checkpoint')
}

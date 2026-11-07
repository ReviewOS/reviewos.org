import { db } from '@stacksjs/database'
import { randomUUID, createHash } from 'node:crypto'
import process from 'node:process'
import { s3StoreFromEnvironment } from '../Git/blobsS3'

export function transferTarget(): { bucket: string, provider: string, prefix: string, fingerprint: string } {
  const bucket = String(process.env.BLOB_MIGRATION_S3_BUCKET || process.env.BLOB_S3_BUCKET || '').trim()
  const provider = String(process.env.BLOB_S3_PROVIDER || 'hetzner').trim()
  const prefix = String(process.env.BLOB_S3_PREFIX || '').trim()
  if (!bucket) throw new Error('No object storage migration destination is configured')
  return { bucket, provider, prefix, fingerprint: createHash('sha256').update(JSON.stringify({ bucket, provider, prefix })).digest('hex') }
}

export async function transferStore() {
  const target = transferTarget()
  const store = await s3StoreFromEnvironment(target)
  if (!store) throw new Error('Object storage migration destination unavailable')
  return store
}

export async function startTransfer(kind: 'storage.blobs' | 'storage.repositories'): Promise<number> {
  const target = transferTarget()
  const now = new Date().toISOString()
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
  if (row.status === 'running' && Date.now() - Date.parse(String(row.started_at)) < (kind === 'storage.repositories' ? 150 : 35) * 60_000) return null
  const progress = JSON.parse(String(row.result || '{}'))
  if (progress.fingerprint !== transferTarget().fingerprint) throw new Error('Storage destination changed; resume requires the original configuration')
  const lease = new Date().toISOString()
  let claim = db.updateTable('operations').set({ status: 'running', started_at: lease, error: null }).where('id', '=', row.id).where('status', '=', row.status)
  if (row.started_at) claim = claim.where('started_at', '=', row.started_at)
  const claimed = await claim.executeTakeFirst()
  if (Number(claimed.numUpdatedRows) !== 1) return null
  return { row, progress, lease }
}

export async function saveTransfer(claim: NonNullable<Awaited<ReturnType<typeof claimTransfer>>>, complete: boolean, error?: unknown): Promise<void> {
  const result = await db.updateTable('operations').set({ status: error ? 'queued' : complete ? 'succeeded' : 'queued',
    result: JSON.stringify(claim.progress), error: error ? String(error).slice(0, 2000) : null,
    finished_at: complete ? new Date().toISOString() : null }).where('id', '=', claim.row.id).where('status', '=', 'running').where('started_at', '=', claim.lease).executeTakeFirst()
  if (Number(result.numUpdatedRows) !== 1) throw new Error('Storage operation lease changed before checkpoint')
}

import { Job } from '@stacksjs/queue'
import { db } from '@stacksjs/database'
import process from 'node:process'
import { ownerHandleFor } from '../Actions/Repo/owner'
import { snapshotRepository } from '../Actions/Git/snapshot'
import { claimTransfer, saveTransfer, startTransfer, transferStore } from '../Actions/Storage/operations'

export default new Job({
  name: 'SnapshotRepositoriesJob',
  queue: 'storage',
  tries: 6,
  backoff: 120,
  timeout: 3600,
  description: 'Store and verify one repository snapshot per durable queue batch',
  async handle(payload: { operationId?: number } = {}) {
    // An operator can bootstrap before S3 activation; scheduled backups require it active.
    if (!payload.operationId && !process.env.BLOB_S3_BUCKET) return { skipped: 'object storage is not active' }
    const id = payload.operationId || await startTransfer('storage.repositories')
    const claim = await claimTransfer('storage.repositories', id)
    if (!claim) return { skipped: 'no available snapshot operation' }
    try {
      const rows: any[] = await db.selectFrom('repositories').select(['id', 'name', 'owner_id', 'owner_type']).where('id', '>', Number(claim.progress.cursor) || 0).orderBy('id', 'asc').limit(2).execute()
      const row = rows[0]
      if (row) {
        const owner = await ownerHandleFor(row)
        if (!owner) throw new Error('Repository owner binding is unavailable')
        const result = await snapshotRepository({ id: Number(row.id), owner, name: String(row.name) }, await transferStore())
        claim.progress.cursor = String(row.id); claim.progress.verified += 1; claim.progress.bytes += result.bytes
      }
      const complete = rows.length <= 1
      await saveTransfer(claim, complete)
      if (!complete) await (await import('./SnapshotRepositoriesJob')).default.dispatch({ operationId: Number(claim.row.id) })
      return { complete, ...claim.progress }
    } catch (error) { await saveTransfer(claim, false, error); throw error }
  },
})

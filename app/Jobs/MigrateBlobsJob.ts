import { Job } from '@stacksjs/queue'
import process from 'node:process'
import { LocalBlobStore } from '../Actions/Git/blobs'
import { claimTransfer, saveTransfer, transferStore } from '../Actions/Storage/operations'
import { boundedTransferBatch, copyVerifiedBlobs, TRANSFER_PAGE_SIZE } from '../Actions/Storage/transfer'

export default new Job({
  name: 'MigrateBlobsJob',
  queue: 'storage',
  tries: 6,
  backoff: 60,
  timeout: 1800,
  description: 'Copy and checksum existing blobs to object storage without deleting sources',
  async handle(payload: { operationId?: number } = {}) {
    const claim = await claimTransfer('storage.blobs', payload.operationId)
    if (!claim) return { skipped: 'no available transfer' }
    let checkpointSaved = false
    try {
      const source = new LocalBlobStore(process.env.BLOB_LOCAL_ROOT || 'storage')
      const target = await transferStore()
      const page = await source.page(claim.progress.cursor, TRANSFER_PAGE_SIZE)
      const batch = boundedTransferBatch(page.entries)
      let processed = 0
      await copyVerifiedBlobs(source, target, batch, { receiptScope: claim.progress.fingerprint }, (key, result) => {
        claim.progress.cursor = key; claim.progress.verified += 1; claim.progress.bytes += result.bytes
        processed += 1
      })
      const complete = !page.more && processed === page.entries.length
      await saveTransfer(claim, complete)
      checkpointSaved = true
      // The operation checkpoint is durable before the next bounded queue job.
      // The scheduled reconciler resumes queued or abandoned operations too.
      if (!complete) await (await import('./MigrateBlobsJob')).default.dispatch({ operationId: Number(claim.row.id) })
      return { complete, ...claim.progress }
    } catch (error) { if (!checkpointSaved) await saveTransfer(claim, false, error); throw error }
  },
})

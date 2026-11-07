import type { CLI } from '@stacksjs/types'
import { db } from '@stacksjs/database'
import { startTransfer, transferTarget } from '../Actions/Storage/operations'
import MigrateBlobsJob from '../Jobs/MigrateBlobsJob'

export default function (cli: CLI) {
  cli.command('storage:migrate', 'Queue a checksum-verified copy of local blobs into object storage')
    .option('--status <id>', 'Read a durable transfer operation')
    .option('--resume <id>', 'Resume a queued operation after an interrupted dispatch')
    .action(async (options: { status?: string, resume?: string }) => {
      if (options.status) {
        const row = await db.selectFrom('operations').select(['id', 'kind', 'status', 'result', 'error']).where('id', '=', Number(options.status)).where('kind', '=', 'storage.blobs').executeTakeFirst()
        console.log(JSON.stringify(row)); return
      }
      const operationId = options.resume ? Number(options.resume) : await startTransfer('storage.blobs')
      await MigrateBlobsJob.dispatch({ operationId })
      console.log(JSON.stringify({ operationId, target: transferTarget(), queued: true }))
    })
}

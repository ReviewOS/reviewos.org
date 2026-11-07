import type { CLI } from '@stacksjs/types'
import { restartTransfer } from '../Actions/Storage/operations'
import MigrateBlobsJob from '../Jobs/MigrateBlobsJob'
import SnapshotRepositoriesJob from '../Jobs/SnapshotRepositoriesJob'

export default function (cli: CLI) {
  cli.command('storage:restart-transfer', 'Queue a new transfer identity from a cancelled or failed checkpoint')
    .option('--operation <id>', 'The cancelled or failed transfer operation')
    .action(async (options: { operation?: string }) => {
      const next = await restartTransfer(Number(options.operation))
      if (next.kind === 'storage.blobs') await MigrateBlobsJob.dispatch({ operationId: next.id })
      else await SnapshotRepositoriesJob.dispatch({ operationId: next.id })
      console.log(JSON.stringify({ operationId: next.id, restartedFrom: Number(options.operation), queued: true, sourcesPreserved: true }))
    })
}

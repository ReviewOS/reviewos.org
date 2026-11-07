import type { CLI } from '@stacksjs/types'
import { db } from '@stacksjs/database'
import { startTransfer } from '../Actions/Storage/operations'
import SnapshotRepositoriesJob from '../Jobs/SnapshotRepositoriesJob'

export default function (cli: CLI) {
  cli.command('storage:snapshot-repositories', 'Queue restore-verified Git bundles in object storage without removing local repositories')
    .option('--status <id>', 'Read a durable snapshot operation')
    .option('--resume <id>', 'Resume an interrupted snapshot operation')
    .action(async (options: { status?: string, resume?: string }) => {
      if (options.status) {
        console.log(JSON.stringify(await db.selectFrom('operations').select(['id', 'kind', 'status', 'result', 'error']).where('id', '=', Number(options.status)).where('kind', '=', 'storage.repositories').executeTakeFirst())); return
      }
      const operationId = options.resume ? Number(options.resume) : await startTransfer('storage.repositories')
      await SnapshotRepositoriesJob.dispatch({ operationId }); console.log(JSON.stringify({ operationId, queued: true }))
    })
}

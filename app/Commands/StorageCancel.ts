import type { CLI } from '@stacksjs/types'
import { cancelTransfer } from '../Actions/Storage/operations'

export default function (cli: CLI) {
  cli.command('storage:cancel-transfer', 'Cancel a transfer while preserving its checkpoint and all data')
    .option('--operation <id>', 'The unfinished transfer operation')
    .action(async (options: { operation?: string }) => {
      await cancelTransfer(Number(options.operation))
      console.log(JSON.stringify({ operationId: Number(options.operation), status: 'cancelled', sourcesPreserved: true }))
    })
}

import type { CLI } from '@stacksjs/types'
import { restoreRepositorySnapshot } from '../Actions/Git/snapshot'
import { transferStore } from '../Actions/Storage/operations'

export default function (cli: CLI) {
  cli.command('storage:restore-repository <id>', 'Restore a verified object-store repository snapshot into a new directory')
    .option('--manifest <key>', 'The repository snapshot manifest key')
    .option('--into <path>', 'A new absolute destination directory')
    .action(async (id: string, options: { manifest?: string, into?: string }) => {
      if (!options.manifest || !options.into) throw new Error('Both --manifest and --into are required')
      console.log(JSON.stringify(await restoreRepositorySnapshot(Number(id), options.manifest, options.into, await transferStore())))
    })
}

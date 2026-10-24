import type { CLI } from '@stacksjs/types'
import settings from '../../config/github-sync'
import { syncAccount } from '../Actions/Mirror/account'

export default function (cli: CLI) {
  cli.command('github:sync', 'Discover owned GitHub organizations and register continuous mirrors')
    .action(async () => {
      if (!settings.user) throw new Error('Set GITHUB_SYNC_USER to the linked administrator handle')
      console.log(await syncAccount(settings.user, settings.credential))
    })
}

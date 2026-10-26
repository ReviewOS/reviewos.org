import type { CLI } from '@stacksjs/types'
import { bootAppListeners } from '@stacksjs/events'
import settings from '../../config/github-sync'
import { syncAccount } from '../Actions/Mirror/account'

export default function (cli: CLI) {
  cli.command('github:sync', 'Discover owned GitHub organizations and register continuous mirrors')
    .option('--public-organizations', 'Show discovered organization memberships on your public profile', { default: false })
    .action(async (options: { publicOrganizations?: boolean }) => {
      if (!settings.user) throw new Error('Set GITHUB_SYNC_USER to the linked administrator handle')
      await bootAppListeners()
      console.log(await syncAccount(settings.user, settings.credential, undefined, options))
    })
}

import { Job } from '@stacksjs/queue'
import settings from '../../config/github-sync'
import { syncAccount } from '../Actions/Mirror/account'

export default new Job({
  name: 'SyncGitHubAccountJob',
  description: 'Discover owned GitHub organizations and repositories for account mirroring',
  queue: 'mirrors',
  tries: 2,
  backoff: 300,
  async handle() {
    if (!settings.user) return { skipped: true }
    return syncAccount(settings.user, settings.credential)
  },
})

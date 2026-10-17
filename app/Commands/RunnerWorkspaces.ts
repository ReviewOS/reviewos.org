import { defineCommand, log } from '@stacksjs/cli'
import { maintainRunnerWorkspaces } from '../Actions/Runner/workspaceMaintenance'

/** Maintenance uses the real registered runner credential and never creates an actor. */
export default defineCommand({
  name: 'runner:workspaces:clean',
  description: 'Preview or retire controller-confirmed terminal workspaces with full local inspection',
  options: {
    '--url <url>': 'The configured ReviewOS instance (or REVIEWOS_URL)',
    '--runner-id <id>': { description: 'The registered runner identity', type: [Number] },
    '--journal-root <path>': 'The runner owner\'s private workspace-journals directory',
    '--temporary-root <path>': 'The runner\'s original temporary root when different from the operator\'s',
    '--owner-uid <uid>': { description: 'Journal owner; only root may maintain another UID', type: [Number] },
    '--apply': { description: 'Retire verified workspaces; otherwise preview only', default: false },
  },
  async handle(options) {
    const baseUrl = String(options.url ?? process.env.REVIEWOS_URL ?? '').trim().replace(/\/+$/, '')
    const token = process.env.REVIEWOS_RUNNER_TOKEN ?? ''
    const result = await maintainRunnerWorkspaces({ baseUrl, token, runnerId: options.runnerId, journalRoot: options.journalRoot, ownerUid: options.ownerUid, temporaryRoot: options.temporaryRoot, apply: options.apply })
    log.info(JSON.stringify({ mode: options.apply ? 'apply' : 'preview', ...result }))
  },
})

import { parsePositiveId } from '@stacksjs/validation'
import { confirmRetirableWorkspaces } from './httpClient'
import { recoverWorkspaces } from './workspaceJournal'

/** Shared by Buddy and the standalone runner; no registration or database access. */
export async function maintainRunnerWorkspaces(options: {
  baseUrl: string
  token: string
  runnerId?: number
  journalRoot?: string
  ownerUid?: number
  temporaryRoot?: string
  apply: boolean
}): Promise<{ retired: number, ready: number, preserved: number }> {
  const journalRoot = options.journalRoot
  if (!options.baseUrl || !options.token || !journalRoot)
    throw new Error('Configure REVIEWOS_URL, REVIEWOS_RUNNER_TOKEN and --journal-root')
  let runnerId: number
  try { runnerId = parsePositiveId(options.runnerId) }
  catch { throw new Error('--runner-id must identify the registered runner') }
  if (options.ownerUid !== undefined && (!Number.isSafeInteger(options.ownerUid) || options.ownerUid < 0))
    throw new Error('--owner-uid must be a non-negative integer')
  const target = new URL(options.baseUrl)
  if (target.username || target.password || target.search || target.hash)
    throw new Error('Use a canonical controller URL; runner credentials belong in REVIEWOS_RUNNER_TOKEN')
  const confirm = (ids: number[]): Promise<number[]> => confirmRetirableWorkspaces(target.href, options.token, runnerId, ids)
  // Verify identity even when this machine has no journaled candidates.
  await confirm([])
  return recoverWorkspaces({ baseUrl: target.href, runnerId, workspaceJournalRoot: journalRoot, workspaceOwnerUid: options.ownerUid, workspaceTemporaryRoot: options.temporaryRoot }, confirm, options.apply)
}

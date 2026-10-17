import { lstatSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { TemporaryWorkspaceJournal } from '@stacksjs/storage'

interface JournalOptions {
  baseUrl: string
  runnerId?: number
  workspaceRoot?: string
  workspaceJournalRoot?: string
  workspaceOwnerUid?: number
  workspaceTemporaryRoot?: string
}

const journals = new Map<string, TemporaryWorkspaceJournal>()

/** Separate controllers and runner identities even when they share one operating-system user. */
export function workspaceJournal(options: JournalOptions, existingOnly = false): TemporaryWorkspaceJournal | null {
  if (options.workspaceRoot || !Number.isSafeInteger(options.runnerId) || Number(options.runnerId) <= 0) return null
  const controller = new URL(options.baseUrl)
  if (controller.search || controller.hash || controller.username || controller.password) throw new Error('Use a canonical controller URL without credentials, query or fragment')
  const identity = new Bun.CryptoHasher('sha256').update(`${controller.href.replace(/\/+$/, '')}\0${options.runnerId}`).digest('hex')
  const directory = join(options.workspaceJournalRoot ?? join(homedir(), '.local/share/reviewos/workspace-journals'), identity)
  if (existingOnly) {
    try { lstatSync(directory) }
    catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null
      throw error
    }
  }
  const temporaryRoot = options.workspaceTemporaryRoot ?? tmpdir()
  const cacheKey = `${directory}:${options.workspaceOwnerUid ?? process.getuid?.()}:${temporaryRoot}`
  let journal = journals.get(cacheKey)
  if (!journal) {
    journal = new TemporaryWorkspaceJournal({ directory, temporaryRoot, prefix: 'reviewos-job-', ownerUid: options.workspaceOwnerUid })
    journals.set(cacheKey, journal)
  }
  return journal
}

/** Only controller-confirmed terminal IDs can pass the storage layer's local ownership checks. */
export async function recoverWorkspaces(
  options: JournalOptions,
  confirm: (jobIds: number[]) => Promise<number[]>,
  apply = true,
): Promise<{ retired: number, ready: number, preserved: number }> {
  const journal = workspaceJournal(options, true)
  if (!journal) return { retired: 0, ready: 0, preserved: 0 }
  const candidates = journal.list().filter(record => /^[1-9]\d*$/.test(record.key) && Number.isSafeInteger(Number(record.key)))
  if (!candidates.length) return { retired: 0, ready: 0, preserved: 0 }
  let removed = 0
  let ready = 0
  let preserved = 0
  for (let start = 0; start < candidates.length; start += 100) {
    const batch = candidates.slice(start, start + 100)
    const requested = new Set(batch.map(record => Number(record.key)))
    const terminal = new Set((await confirm([...requested])).filter(id => Number.isSafeInteger(id) && requested.has(id)))
    for (const record of batch) {
      if (!terminal.has(Number(record.key))) continue
      const allowed = (row: { key: string }): boolean => terminal.has(Number(row.key))
      const inspection = await journal.inspectRetirement(record.id, allowed)
      if (!inspection.ready) { preserved++; continue }
      ready++
      if (apply) {
        if (await journal.retire(record.id, allowed)) removed++
        else preserved++
      }
    }
  }
  return { retired: removed, ready, preserved }
}

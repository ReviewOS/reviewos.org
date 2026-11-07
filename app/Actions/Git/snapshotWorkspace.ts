import { captureProcessLeaseOwner, processLeaseOwnerStatus } from '@stacksjs/queue'
import { TemporaryWorkspaceJournal } from '@stacksjs/storage'
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Only journaled, positively abandoned scratch directories are recovery candidates. */
export async function createRepositoryWorkspace(root: string, key: string) {
  await mkdir(root, { recursive: true })
  const journal = new TemporaryWorkspaceJournal({ directory: join(root, 'repository-journal'), temporaryRoot: root, prefix: 'repository-work-' })
  for (const record of journal.list().slice(0, 8)) {
    try {
      const file = join(record.path, 'workspace-owner.json')
      const stat = await lstat(file)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== journal.ownerUid || (stat.mode & 0o077) || stat.size > 4096) continue
      const owner = JSON.parse(await readFile(file, 'utf8')).owner
      if (processLeaseOwnerStatus(owner) === 'dead') await journal.retire(record.id, () => processLeaseOwnerStatus(owner) === 'dead')
    }
    catch { /* Missing or unverifiable recovery ownership preserves the directory. */ }
  }
  const record = journal.create(key)
  try {
    await writeFile(join(record.path, 'workspace-owner.json'), JSON.stringify({ owner: captureProcessLeaseOwner() }), { flag: 'wx', mode: 0o600 })
  }
  catch (error) { journal.complete(record); throw error }
  return {
    path: record.path,
    complete() {
      if (!journal.complete(record)) throw new Error('Repository scratch cleanup was refused; the journal and workspace were preserved')
    },
  }
}

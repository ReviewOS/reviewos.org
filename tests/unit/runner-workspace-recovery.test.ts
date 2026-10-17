import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { recoverWorkspaces, workspaceJournal } from '../../app/Actions/Runner/workspaceJournal'

const roots: string[] = []
const workspaces: string[] = []
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'reviewos-journal-test-'))
  roots.push(root)
  const options = { baseUrl: 'https://controller.example.test', runnerId: 42, token: crypto.randomUUID(), workspaceJournalRoot: join(root, 'journals') }
  const journal = workspaceJournal(options)
  if (!journal) throw new Error('An ephemeral runner requires a journal')
  const create = (key: string) => {
    const record = journal.create(key)
    workspaces.push(record.path)
    return record
  }
  return { root, options, journal, create }
}

afterEach(() => {
  for (const path of workspaces.splice(0)) rmSync(path, { recursive: true, force: true })
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

test('a recovery preview asks about only journaled IDs and never removes any workspace', async () => {
  const { options, create } = fixture()
  const terminal = create('643')
  const active = create('661')
  const unknown = create('700')
  const preview = await recoverWorkspaces(options, async (ids) => {
    expect(new Set(ids)).toEqual(new Set([643, 661, 700]))
    return [643, 999999]
  }, false)
  expect(preview.retired).toBe(0)
  expect(existsSync(terminal.path)).toBe(true)
  expect(existsSync(active.path)).toBe(true)
  expect(existsSync(unknown.path)).toBe(true)
})

test('an unconfirmed terminal state never authorizes deletion', async () => {
  const { options, create } = fixture()
  const record = create('643')
  expect(await recoverWorkspaces(options, async () => [])).toEqual({ retired: 0, ready: 0, preserved: 0 })
  expect(existsSync(record.path)).toBe(true)
})

test('an unreachable controller never becomes permission to reclaim a directory', async () => {
  const { options, create } = fixture()
  const record = create('643')
  await expect(recoverWorkspaces(options, async () => { throw new Error('controller unavailable') })).rejects.toThrow('controller unavailable')
  expect(existsSync(record.path)).toBe(true)
})

test('controller and runner identity separate journals belonging to the same OS user', () => {
  const { options, journal } = fixture()
  const otherRunner = workspaceJournal({ ...options, runnerId: 43 })
  const otherController = workspaceJournal({ ...options, baseUrl: 'https://other.example.test' })
  expect(otherRunner?.directory).not.toBe(journal.directory)
  expect(otherController?.directory).not.toBe(journal.directory)
  const rotatedCredential = { ...options, token: crypto.randomUUID() }
  expect(workspaceJournal(rotatedCredential)?.directory).toBe(journal.directory)
})

test('an explicitly retained workspace root is outside automatic temporary recovery', async () => {
  const { root, options } = fixture()
  expect(workspaceJournal({ ...options, workspaceRoot: root })).toBeNull()
  expect(await recoverWorkspaces({ ...options, workspaceRoot: root }, async () => { throw new Error('must not query') })).toEqual({ retired: 0, ready: 0, preserved: 0 })
})

test('a recovery preview does not create a missing journal directory', async () => {
  const root = mkdtempSync(join(tmpdir(), 'reviewos-journal-preview-'))
  roots.push(root)
  const workspaceJournalRoot = join(root, 'missing')
  const result = await recoverWorkspaces({ baseUrl: 'https://controller.example.test', runnerId: 42, workspaceJournalRoot }, async () => { throw new Error('No candidates exist') }, false)
  expect(result).toEqual({ retired: 0, ready: 0, preserved: 0 })
  expect(existsSync(workspaceJournalRoot)).toBe(false)
})

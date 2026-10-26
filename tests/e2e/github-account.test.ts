import { afterAll, beforeAll, expect, test } from 'bun:test'
import { rm } from 'node:fs/promises'
import { db } from '@stacksjs/database'
import { syncAccount } from '../../app/Actions/Mirror/account'
import { GitHubClient } from '../../app/Actions/Mirror/github-client'
import { addMirror } from '../../app/Commands/MirrorAdd'
import { repositoryPath } from '../../app/Actions/Git/storage'
import { branchSha, createCommit } from '../../app/Actions/Git/write'
import { bootAppListeners } from '@stacksjs/events'

const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 12)
const handle = `sync${suffix}`
const organization = `org${suffix}`
let userId = 0
let legacyUserId = 0
let available = false

beforeAll(async () => {
  try {
    await db.selectFrom('users').select(['id']).limit(1).execute()
    await bootAppListeners()
    const user = await db.insertInto('users').values({ handle, email: `${handle}@example.com`, password: '', is_admin: true, github_username: handle }).returning(['id']).executeTakeFirst()
    userId = Number(user?.id)
    const legacy = await db.insertInto('users').values({ handle: `old${suffix}`, email: `old${suffix}@example.com`, password: '' }).returning(['id']).executeTakeFirst()
    legacyUserId = Number(legacy?.id)
    available = true
  }
  catch (error) { console.warn('[github-account] skipping:', String(error)) }
})

afterAll(async () => {
  if (!userId) return
  const org = await db.selectFrom('organizations').select(['id']).where('handle', '=', organization).executeTakeFirst()
  const repositories = await db.selectFrom('repositories').select(['id', 'name', 'owner_id', 'owner_type']).execute()
  for (const repository of repositories.filter(row => (row.owner_type === 'user' && Number(row.owner_id) === userId) || (org && row.owner_type === 'organization' && Number(row.owner_id) === Number(org.id)))) {
    await db.deleteFrom('repository_mirrors').where('repository_id', '=', Number(repository.id)).execute()
    await db.deleteFrom('repositories').where('id', '=', Number(repository.id)).execute()
    const owner = repository.owner_type === 'user' ? handle : organization
    await rm(repositoryPath(owner, String(repository.name)).path!, { recursive: true, force: true })
  }
  if (org) {
    await db.deleteFrom('org_members').where('organization_id', '=', Number(org.id)).execute()
    await db.deleteFrom('organizations').where('id', '=', Number(org.id)).execute()
  }
  await db.deleteFrom('users').where('id', '=', userId).execute()
  if (legacyUserId) await db.deleteFrom('users').where('id', '=', legacyUserId).execute()
})

function client(login = handle, personal = 'personal') {
  return new GitHubClient({ fetchImpl: (async (url: string) => {
    const path = new URL(url).pathname
    if (path === '/user') return Response.json({ login })
    if (path === '/user/memberships/orgs') return Response.json([{ state: 'active', role: 'admin', organization: { login: organization } }])
    if (path === '/user/repos') return Response.json([
      { owner: { login: handle }, name: personal, private: true },
      { owner: { login: organization }, name: 'shared', private: true },
    ])
    throw new Error('Unexpected GitHub request')
  }) as typeof fetch })
}

test('account discovery is idempotent and preserves private mirrors, credentials and workflow policy', async () => {
  if (!available) return
  expect(await syncAccount(handle, 'fixture', client())).toEqual({ organizations: 1, repositories: 2, added: 2 })
  const org = await db.selectFrom('organizations').select(['id']).where('handle', '=', organization).executeTakeFirst()
  const membership = await db.selectFrom('org_members').select(['role']).where('organization_id', '=', Number(org?.id)).where('user_id', '=', userId).executeTakeFirst()
  expect(membership?.role).toBe('owner')
  const repository = await db.selectFrom('repositories').select(['id', 'visibility']).where('owner_type', '=', 'user').where('owner_id', '=', userId).executeTakeFirst()
  expect(repository?.visibility).toBe('private')
  const mirror = await db.selectFrom('repository_mirrors').selectAll().where('repository_id', '=', Number(repository?.id)).executeTakeFirst()
  expect(Boolean(mirror?.run_workflows)).toBe(false)
  expect(Boolean(mirror?.sync_metadata)).toBe(true)
  await db.updateTable('repository_mirrors').set({ credential_ref: 'keep_existing', run_workflows: true, remote_owner: handle.toUpperCase() }).where('id', '=', Number(mirror?.id)).execute()
  expect((await syncAccount(handle, 'fixture', client())).added).toBe(0)
  const unchanged = await db.selectFrom('repository_mirrors').selectAll().where('id', '=', Number(mirror?.id)).executeTakeFirst()
  expect(unchanged?.credential_ref).toBe('keep_existing')
  expect(Boolean(unchanged?.run_workflows)).toBe(true)
  await expect(syncAccount(handle, 'fixture', client('someone-else'))).rejects.toThrow('different GitHub account')
})

test('discovery repairs legacy personal ownership without replacing Git history or mirror policy', async () => {
  if (!available) return
  await addMirror({ remote: `${handle}/legacy`, owner: `old${suffix}`, credential: 'fixture', private: true, quiet: true })
  const before = await db.selectFrom('repositories').select(['id']).where('owner_type', '=', 'user')
    .where('owner_id', '=', legacyUserId).where('name', '=', 'legacy').executeTakeFirst()
  const oldPath = repositoryPath(`old${suffix}`, 'legacy').path!
  const commit = await createCommit(oldPath, { branch: 'main', parentSha: null, message: 'Existing history', author: { name: 'Chris', email: 'chris@example.com' }, files: { 'README.md': 'Keep this history\n' } })
  expect(commit.ok).toBe(true)
  const mirror = await db.selectFrom('repository_mirrors').select(['id']).where('repository_id', '=', Number(before?.id)).executeTakeFirst()
  await db.updateTable('repository_mirrors').set({ credential_ref: 'keep_existing', run_workflows: true }).where('id', '=', Number(mirror?.id)).execute()

  expect((await syncAccount(handle, 'fixture', client(handle, 'legacy'), { publicOrganizations: true })).added).toBe(0)
  const after = await db.selectFrom('repositories').select(['id', 'owner_type', 'owner_id', 'visibility']).where('id', '=', Number(before?.id)).executeTakeFirst()
  expect(after).toMatchObject({ owner_type: 'user', visibility: 'private' })
  expect(Number(after?.owner_id)).toBe(userId)
  expect(await branchSha(repositoryPath(handle, 'legacy').path!, 'main')).toBe(commit.ok ? commit.sha : '')
  expect(await Bun.file(`${oldPath}/HEAD`).exists()).toBe(false)
  const policy = await db.selectFrom('repository_mirrors').select(['credential_ref', 'run_workflows']).where('id', '=', Number(mirror?.id)).executeTakeFirst()
  expect(policy?.credential_ref).toBe('keep_existing')
  expect(Boolean(policy?.run_workflows)).toBe(true)
  const org = await db.selectFrom('organizations').select(['id']).where('handle', '=', organization).executeTakeFirst()
  const membership = await db.selectFrom('org_members').select(['is_public']).where('organization_id', '=', Number(org?.id)).where('user_id', '=', userId).executeTakeFirst()
  expect(Boolean(membership?.is_public)).toBe(true)
  await syncAccount(handle, 'fixture', client())
  const preserved = await db.selectFrom('org_members').select(['is_public']).where('organization_id', '=', Number(org?.id)).where('user_id', '=', userId).executeTakeFirst()
  expect(Boolean(preserved?.is_public)).toBe(true)
})

import { afterAll, beforeAll, expect, test } from 'bun:test'
import { rm } from 'node:fs/promises'
import { db } from '@stacksjs/database'
import { syncAccount } from '../../app/Actions/Mirror/account'
import { GitHubClient } from '../../app/Actions/Mirror/github-client'

const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 12)
const handle = `sync${suffix}`
const organization = `org${suffix}`
let userId = 0
let available = false

beforeAll(async () => {
  try {
    await db.selectFrom('users').select(['id']).limit(1).execute()
    const user = await db.insertInto('users').values({ handle, email: `${handle}@example.com`, password: '', is_admin: true, github_username: handle }).returning(['id']).executeTakeFirst()
    userId = Number(user?.id)
    available = true
  }
  catch (error) { console.warn('GitHub account integration test needs a migrated database:', String(error)) }
})

afterAll(async () => {
  if (!userId) return
  const org = await db.selectFrom('organizations').select(['id']).where('handle', '=', organization).executeTakeFirst()
  const repositories = await db.selectFrom('repositories').select(['id', 'disk_path', 'owner_id', 'owner_type']).execute()
  for (const repository of repositories.filter(row => (row.owner_type === 'user' && Number(row.owner_id) === userId) || (org && row.owner_type === 'organization' && Number(row.owner_id) === Number(org.id)))) {
    await db.deleteFrom('repository_mirrors').where('repository_id', '=', Number(repository.id)).execute()
    await db.deleteFrom('repositories').where('id', '=', Number(repository.id)).execute()
    if (repository.disk_path) await rm(String(repository.disk_path), { recursive: true, force: true })
  }
  if (org) {
    await db.deleteFrom('org_members').where('organization_id', '=', Number(org.id)).execute()
    await db.deleteFrom('organizations').where('id', '=', Number(org.id)).execute()
  }
  await db.deleteFrom('users').where('id', '=', userId).execute()
})

function client(login = handle) {
  return new GitHubClient({ fetchImpl: (async (url: string) => {
    const path = new URL(url).pathname
    if (path === '/user') return Response.json({ login })
    if (path === '/user/memberships/orgs') return Response.json([{ state: 'active', role: 'admin', organization: { login: organization } }])
    if (path === '/user/repos') return Response.json([
      { owner: { login: handle }, name: 'personal', private: true },
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
  await db.updateTable('repository_mirrors').set({ credential_ref: 'keep_existing', run_workflows: true }).where('id', '=', Number(mirror?.id)).execute()
  expect((await syncAccount(handle, 'fixture', client())).added).toBe(0)
  const unchanged = await db.selectFrom('repository_mirrors').selectAll().where('id', '=', Number(mirror?.id)).executeTakeFirst()
  expect(unchanged?.credential_ref).toBe('keep_existing')
  expect(Boolean(unchanged?.run_workflows)).toBe(true)
  await expect(syncAccount(handle, 'fixture', client('someone-else'))).rejects.toThrow('different GitHub account')
})

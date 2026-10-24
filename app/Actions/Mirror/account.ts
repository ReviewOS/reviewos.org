import { db } from '@stacksjs/database'
import { randomUUID } from 'node:crypto'
import { GitHubClient } from './github-client'
import { mirrorToken } from './credentials'
import { addMirror } from '../../Commands/MirrorAdd'
import { dbTimestamp } from '../Support/sql'

/** Only the viewer's own repositories and organizations they actively administer. */
export async function discoverAccount(client: GitHubClient) {
  const viewer = await client.viewer()
  if (!viewer.ok) throw new Error(viewer.message)
  const memberships = await client.collect<any>('/user/memberships/orgs?state=active')
  const repositories = await client.collect<any>('/user/repos?affiliation=owner,organization_member&sort=full_name')
  for (const page of [memberships, repositories]) {
    if (!page.ok || page.truncated) throw new Error(page.error ?? 'GitHub discovery was truncated')
  }
  const organizations = memberships.items.filter(row => row.state === 'active' && row.role === 'admin').map(row => row.organization)
  const owners = new Set([viewer.login, ...organizations.map(org => String(org.login))].map(login => login.toLowerCase()))
  return { login: viewer.login, organizations, repositories: repositories.items.filter(row => owners.has(String(row.owner?.login).toLowerCase())) }
}

/** Additive discovery never deletes repositories or removes an existing membership. */
export async function syncAccount(handle: string, credential: string, client?: GitHubClient) {
  const user = await db.selectFrom('users').select(['id', 'github_username', 'is_admin']).where('handle', '=', handle).executeTakeFirst()
  if (!user?.is_admin || !user.github_username) throw new Error('Discovery requires an administrator with an explicitly linked GitHub identity')
  const token = await mirrorToken(credential)
  if (!token && !client) throw new Error('The GitHub discovery credential is missing')
  const inventory = await discoverAccount(client ?? new GitHubClient({ token }))
  if (inventory.login.toLowerCase() !== String(user.github_username).toLowerCase()) throw new Error('The credential belongs to a different GitHub account')
  const ownerMap = new Map<string, string>([[inventory.login.toLowerCase(), handle]])
  const mapped = await db.selectFrom('repository_mirrors')
    .innerJoin('repositories', 'repositories.id', '=', 'repository_mirrors.repository_id')
    .innerJoin('organizations', 'organizations.id', '=', 'repositories.owner_id')
    .select(['repository_mirrors.remote_owner', 'organizations.handle'])
    .where('repositories.owner_type', '=', 'organization').execute()
  for (const row of mapped) ownerMap.set(String(row.remote_owner).toLowerCase(), String(row.handle))
  for (const upstream of inventory.organizations) {
    const login = String(upstream.login).toLowerCase()
    const localHandle = ownerMap.get(login) ?? login
    if (!/^[a-z0-9][a-z0-9-]{0,38}$/.test(localHandle)) throw new Error('An upstream organization has an unsupported handle')
    let organization = await db.selectFrom('organizations').select(['id']).where('handle', '=', localHandle).executeTakeFirst()
    if (!organization) {
      const collision = await db.selectFrom('users').select(['id']).where('handle', '=', localHandle).executeTakeFirst()
      if (collision) throw new Error(`The organization handle ${localHandle} belongs to a user`)
      organization = await db.insertInto('organizations').values({ uuid: randomUUID(), handle: localHandle, name: String(upstream.login), avatar_url: upstream.avatar_url ?? null }).returning(['id']).executeTakeFirst()
    }
    const membership = await db.selectFrom('org_members').select(['id']).where('organization_id', '=', Number(organization!.id)).where('user_id', '=', Number(user.id)).executeTakeFirst()
    if (membership) await db.updateTable('org_members').set({ role: 'owner' }).where('id', '=', Number(membership.id)).execute()
    else await db.insertInto('org_members').values({ organization_id: Number(organization!.id), user_id: Number(user.id), role: 'owner', invited_by_id: Number(user.id), joined_at: dbTimestamp() }).execute()
    ownerMap.set(login, localHandle)
  }
  const registered = new Map<string, any>()
  for (const mirror of await db.selectFrom('repository_mirrors').selectAll().where('provider', '=', 'github').execute()) {
    const key = `${mirror.remote_owner}/${mirror.remote_name}`.toLowerCase()
    if (!registered.has(key)) registered.set(key, mirror)
  }
  let added = 0
  for (const repository of inventory.repositories) {
    const remoteOwner = String(repository.owner.login)
    const existing = registered.get(`${remoteOwner}/${repository.name}`.toLowerCase())
    if (existing) {
      await db.updateTable('repository_mirrors').set({ enabled: true, sync_metadata: true, credential_ref: existing.credential_ref || credential }).where('id', '=', Number(existing.id)).execute()
      if (repository.private) await db.updateTable('repositories').set({ visibility: 'private' }).where('id', '=', Number(existing.repository_id)).execute()
      continue
    }
    await addMirror({ remote: `${remoteOwner}/${repository.name}`, owner: ownerMap.get(remoteOwner.toLowerCase()), metadata: true, credential, private: Boolean(repository.private), quiet: true })
    added += 1
  }
  return { organizations: inventory.organizations.length, repositories: inventory.repositories.length, added }
}

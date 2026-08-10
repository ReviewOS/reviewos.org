// Taking access away, and whether it actually goes.
//
// The claim this file exists to check is the one every forge makes and few can
// demonstrate: **removing somebody ends their reach on the next request, not at
// the next cache expiry.** It is easy to be wrong about, because the wrong
// version passes every functional test - access works when it should, and the
// only difference is a window of minutes after a removal, which nobody exercises
// by hand.
//
// A credential that outlives the access it was granted under is the whole
// failure mode. Somebody leaves, their membership is deleted, and the token
// pasted into a build server three months ago keeps cloning.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

const created = {
  ownerId: 0,
  memberId: 0,
  memberToken: '',
  memberTokenId: 0,
  organizationId: 0,
  organizationHandle: '',
  repositoryId: 0,
  repositoryName: '',
  diskPath: '',
}

let available = false
let port = 0
let server: any = null

function unique(prefix: string): string {
  return `${prefix}${Buffer.from(crypto.getRandomValues(new Uint8Array(5))).toString('hex')}`
}

/**
 * Read the private repository as the member, with their token.
 *
 * `/repos/branches` rather than a metadata endpoint: it goes through
 * `authorizeRepository` and then touches the repository on disk, so it is a
 * read somebody would actually be doing when their access is taken away.
 */
async function readRepository(): Promise<number> {
  const answer = await fetch(
    `http://127.0.0.1:${port}/api/repos/branches?owner=${created.organizationHandle}&repo=${created.repositoryName}`,
    { headers: { Authorization: `Bearer ${created.memberToken}`, Accept: 'application/json' } },
  )

  await answer.text()

  return answer.status
}

beforeAll(async () => {
  try {
    const { injectGlobalAutoImports } = await import('@stacksjs/server')
    const { route } = await import('@stacksjs/router')

    await injectGlobalAutoImports()
    const db = (globalThis as any).db
    await db.selectFrom('users').select(['id']).limit(1).execute()

    await route.importRoutes()
    server = await route.serve({ port: 0, hostname: '127.0.0.1' })
    port = Number((server as any)?.port ?? (server as any)?.server?.port ?? 0)

    if (!port)
      throw new Error('the router did not report a port')

    const make = async (prefix: string) => {
      const handle = unique(prefix)
      const row: any = await db
        .insertInto('users')
        .values({ name: 'Deprovision Person', email: `${handle}@example.com`, handle, password: 'x' })
        .returning(['id'])
        .executeTakeFirst()

      return Number(row?.id)
    }

    created.ownerId = await make('deprovowner')
    created.memberId = await make('deprovmember')

    const { generateToken } = await import('../../app/Actions/Tokens/secret')
    const token = generateToken()

    const tokenRow: any = await db.insertInto('access_tokens').values({
      user_id: created.memberId,
      name: 'a build server',
      prefix: token.prefix,
      token_hash: token.hash,
      selection: 'all',
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    }).returning(['id']).executeTakeFirst()

    created.memberToken = token.token
    created.memberTokenId = Number(tokenRow?.id)

    await db.insertInto('access_token_permissions').values({
      access_token_id: created.memberTokenId,
      scope: 'contents',
      level: 'read',
    }).execute()

    created.organizationHandle = unique('deprovorg')
    const organization: any = await db
      .insertInto('organizations')
      .values({ name: 'Deprovisioned', handle: created.organizationHandle })
      .returning(['id'])
      .executeTakeFirst()

    created.organizationId = Number(organization?.id)

    for (const [userId, role] of [[created.ownerId, 'owner'], [created.memberId, 'member']] as const) {
      await db.insertInto('org_members').values({
        organization_id: created.organizationId,
        user_id: userId,
        role,
        joined_at: new Date().toISOString(),
      }).execute()
    }

    created.repositoryName = unique('deprovrepo')
    const repository: any = await db
      .insertInto('repositories')
      .values({
        owner_type: 'organization',
        owner_id: created.organizationId,
        name: created.repositoryName,
        // Private, so membership is the only thing granting access. Against a
        // public repository this test would pass for the wrong reason.
        visibility: 'private',
        default_branch: 'main',
        // The layout the path builder computes, so the browse endpoints find
        // it. A random path here would 404 for the wrong reason and the
        // control below would fail while proving nothing.
        disk_path: `${created.organizationHandle}/${created.repositoryName}.git`,
      })
      .returning(['id'])
      .executeTakeFirst()

    created.repositoryId = Number(repository?.id)

    /*
     * The grant, as a direct collaborator row.
     *
     * Not through plain membership, which grants nothing here on purpose -
     * `organizationRoleGrants` gives an owner or admin everything and a member
     * nothing, because otherwise every new hire silently gains write on
     * everything. So the access being taken away has to be an access that
     * existed, and a collaborator row is the ordinary way somebody has one.
     */
    await db.insertInto('repo_collaborators').values({
      repository_id: created.repositoryId,
      user_id: created.memberId,
      permission: 'read',
    }).execute()

    // A real bare repository, because the read under test touches disk. Without
    // it the endpoint answers the same way it answers somebody with no access,
    // and the two would be indistinguishable.
    const { repositoryPath } = await import('../../app/Actions/Git/storage')
    const { initBare } = await import('../../app/Actions/Git/git')
    const resolved = repositoryPath(created.organizationHandle, created.repositoryName)

    if (!resolved.ok)
      throw new Error('the repository path could not be built')

    const { mkdir } = await import('node:fs/promises')
    const { dirname } = await import('node:path')

    await mkdir(dirname(resolved.path!), { recursive: true })
    await initBare(resolved.path!, 'main')

    created.diskPath = resolved.path!
    available = true
  }
  catch (error) {
    console.warn(`[deprovisioning] skipping: ${error instanceof Error ? error.message : String(error)}`)
    available = false
  }
}, 120_000)

afterAll(async () => {
  const db = (globalThis as any).db

  try {
    if (db) {
      const users = [created.ownerId, created.memberId].filter(Boolean)

      if (created.organizationId) {
        await db.deleteFrom('audit_events').where('organization_id', '=', created.organizationId).execute()
        await db.deleteFrom('org_members').where('organization_id', '=', created.organizationId).execute()
      }

      if (created.repositoryId) {
        await db.deleteFrom('repo_collaborators').where('repository_id', '=', created.repositoryId).execute()
        await db.deleteFrom('repositories').where('id', '=', created.repositoryId).execute()
      }

      if (created.diskPath) {
        const { rm } = await import('node:fs/promises')
        await rm(created.diskPath, { recursive: true, force: true })
      }

      if (created.organizationId)
        await db.deleteFrom('organizations').where('id', '=', created.organizationId).execute()

      if (users.length > 0) {
        await db.deleteFrom('audit_events').where('actor_id', 'in', users).execute()
        await db.deleteFrom('access_token_permissions').where('access_token_id', '=', created.memberTokenId).execute()
        await db.deleteFrom('access_tokens').where('user_id', 'in', users).execute()
        await db.deleteFrom('users').where('id', 'in', users).execute()
      }
    }
  }
  finally {
    server?.stop?.()
  }
}, 60_000)

describe('a token reaching a private repository through a grant', () => {
  test('works while the membership does', async () => {
    if (!available)
      return

    /*
     * The control. Without it, the assertion below passes on a broken fixture
     * and proves nothing - which is the usual way a revocation test lies.
     *
     * A real bare repository exists on disk for this, so a 200 here is a
     * genuine read rather than an authorization that happened to get through.
     */
    expect(await readRepository()).toBe(200)
  }, 30_000)

  test('stops on the very next request once the grant is gone', async () => {
    if (!available)
      return

    /*
     * The property. Not "within a minute", not "after the cache expires" - the
     * next request. Every check in this path queries the grant tables live, and
     * this is what stops somebody adding a cache in front of them for a
     * respectable-sounding reason.
     *
     * The token itself is untouched: it is still valid, still unexpired, still
     * scoped to `contents: read`. What changed is the person behind it, and the
     * answer has to follow the person.
     */
    await (globalThis as any).db
      .deleteFrom('repo_collaborators')
      .where('repository_id', '=', created.repositoryId)
      .where('user_id', '=', created.memberId)
      .execute()

    // 404 rather than 403: a private repository answers a stranger the same way
    // it answers somebody asking about a repository that does not exist.
    expect([403, 404]).toContain(await readRepository())
  }, 30_000)

  test('and the token is still a perfectly good token', async () => {
    if (!available)
      return

    // The point of the previous test. If the token had been revoked, this would
    // pass for the wrong reason - the reach ended, not the credential, and
    // those are different repairs.
    const answer = await fetch(`http://127.0.0.1:${port}/api/user`, {
      headers: { Authorization: `Bearer ${created.memberToken}`, Accept: 'application/json' },
    })

    await answer.text()

    expect(answer.status).toBe(200)
  }, 30_000)
})

describe('reach that came from an organization role', () => {
  test('ends the moment the role is demoted', async () => {
    if (!available)
      return

    /*
     * The other route to access, and the one an SSO deprovisioning would take:
     * an owner or admin administers every repository the organization holds,
     * and a plain member holds nothing implicitly.
     *
     * Worth its own test because it is a *derived* permission. The collaborator
     * case above is a row that was deleted; this is a row that still exists
     * with one column changed, which is exactly the shape a cache gets wrong.
     */
    const db = (globalThis as any).db

    await db
      .updateTable('org_members')
      .set({ role: 'admin' })
      .where('organization_id', '=', created.organizationId)
      .where('user_id', '=', created.memberId)
      .execute()

    expect(await readRepository()).toBe(200)

    await db
      .updateTable('org_members')
      .set({ role: 'member' })
      .where('organization_id', '=', created.organizationId)
      .where('user_id', '=', created.memberId)
      .execute()

    expect([403, 404]).toContain(await readRepository())
  }, 30_000)

  test('and being removed from the organization entirely does the same', async () => {
    if (!available)
      return

    const db = (globalThis as any).db

    await db
      .updateTable('org_members')
      .set({ role: 'admin' })
      .where('organization_id', '=', created.organizationId)
      .where('user_id', '=', created.memberId)
      .execute()

    expect(await readRepository()).toBe(200)

    // What "removing someone upstream" comes down to here. The token is
    // untouched and still valid; what it can reach follows the person.
    await db
      .deleteFrom('org_members')
      .where('organization_id', '=', created.organizationId)
      .where('user_id', '=', created.memberId)
      .execute()

    expect([403, 404]).toContain(await readRepository())
  }, 30_000)
})

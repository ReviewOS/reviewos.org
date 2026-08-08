// A team grant, all the way through the permission resolver.
//
// `repositoryPermissionFor` has always unioned a `teamPermissions` array into
// its answer, so the rule looked implemented - but `permissionOn` passed `[]`
// and there was no table for a team to be granted anything. The team branch had
// never once been reached with a value in it: a team was a list of names with
// no effect on access.
//
// So the assertion that matters is not "the union works" - the unit tests cover
// that against literals - it is that a grant written to the database changes
// what `permissionOn` answers. That is the wiring, and wiring is what was
// missing.
//
// Like the rest of tests/e2e it needs a database, and skips itself loudly when
// there is not one.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

const created = {
  orgId: 0,
  ownerId: 0,
  memberId: 0,
  outsiderId: 0,
  repositoryId: 0,
  parentTeamId: 0,
  childTeamId: 0,
  otherTeamId: 0,
}

let available = false
let permissionOn: any
let repositoryPermissionFor: any
let repository: any

function unique(prefix: string): string {
  return `${prefix}${Buffer.from(crypto.getRandomValues(new Uint8Array(4))).toString('hex')}`
}

/** What this person may do on the repository, through the real resolver. */
async function permissionFor(userId: number | null): Promise<string | null> {
  const grants = await permissionOn(repository, userId)

  return repositoryPermissionFor({
    ...grants,
    userId,
    visibility: String(repository.visibility),
    ownerUserId: null,
  })
}

async function grant(teamId: number, permission: string): Promise<void> {
  await (globalThis as any).db.insertInto('team_repositories').values({
    team_id: teamId,
    repository_id: created.repositoryId,
    permission,
  }).execute()
}

beforeAll(async () => {
  try {
    const { injectGlobalAutoImports } = await import('@stacksjs/server')
    await injectGlobalAutoImports()
    const db = (globalThis as any).db
    await db.selectFrom('users').select(['id']).limit(1).execute()

    ;({ permissionOn } = await import('../../app/Actions/Git/access'))
    ;({ repositoryPermissionFor } = await import('../../app/Permissions'))

    const make = async (prefix: string): Promise<number> => {
      const handle = unique(prefix)
      const row: any = await db
        .insertInto('users')
        .values({ name: 'Team Person', email: `${handle}@example.com`, handle, password: 'x' })
        .returning(['id'])
        .executeTakeFirst()

      return Number(row?.id)
    }

    created.ownerId = await make('tmo')
    created.memberId = await make('tmm')
    created.outsiderId = await make('tmx')

    const org: any = await db
      .insertInto('organizations')
      .values({ handle: unique('torg'), name: 'Team Org' })
      .returning(['id'])
      .executeTakeFirst()

    created.orgId = Number(org?.id)

    for (const [userId, role] of [[created.ownerId, 'owner'], [created.memberId, 'member']] as const) {
      await db.insertInto('org_members').values({
        organization_id: created.orgId,
        user_id: userId,
        role,
      }).execute()
    }

    const name = unique('trepo')
    const repo: any = await db
      .insertInto('repositories')
      .values({
        owner_type: 'organization',
        owner_id: created.orgId,
        name,
        description: 'created by the team access test',
        // Private on purpose: a public repository grants read to everybody, so
        // a team grant would be invisible under one.
        visibility: 'private',
        default_branch: 'main',
        disk_path: `x/${name}.git`,
      })
      .returning(['id'])
      .executeTakeFirst()

    created.repositoryId = Number(repo?.id)
    repository = await db.selectFrom('repositories').selectAll().where('id', '=', created.repositoryId).executeTakeFirst()

    const team = async (slug: string, parent: number | null): Promise<number> => {
      const row: any = await db
        .insertInto('teams')
        .values({ organization_id: created.orgId, name: slug, slug, parent_team_id: parent })
        .returning(['id'])
        .executeTakeFirst()

      return Number(row?.id)
    }

    created.parentTeamId = await team(unique('platform'), null)
    created.childTeamId = await team(unique('reviewers'), created.parentTeamId)
    created.otherTeamId = await team(unique('design'), null)

    available = true
  }
  catch (error) {
    console.warn(`[team-access] skipping: ${error instanceof Error ? error.message : String(error)}`)
    available = false
  }
}, 120_000)

afterAll(async () => {
  const db = (globalThis as any).db
  if (!db)
    return

  const users = [created.ownerId, created.memberId, created.outsiderId].filter(Boolean)

  if (created.repositoryId) {
    await db.deleteFrom('team_repositories').where('repository_id', '=', created.repositoryId).execute()
    await db.deleteFrom('repositories').where('id', '=', created.repositoryId).execute()
  }

  if (created.orgId) {
    await db.deleteFrom('team_members').where('team_id', 'in', [created.parentTeamId, created.childTeamId, created.otherTeamId].filter(Boolean)).execute()
    await db.deleteFrom('teams').where('organization_id', '=', created.orgId).execute()
    await db.deleteFrom('org_members').where('organization_id', '=', created.orgId).execute()
    await db.deleteFrom('organizations').where('id', '=', created.orgId).execute()
  }

  if (users.length > 0)
    await db.deleteFrom('users').where('id', 'in', users).execute()
}, 30_000)

describe('before any team grant', () => {
  test('a plain organization member gets nothing, because membership is not access', async () => {
    if (!available)
      return

    // The baseline, and a deliberate one: `organizationRoleGrants` gives a
    // plain member nothing implicitly, or every new hire would silently gain
    // write on everything. It also makes the rest of this file sharper - a team
    // grant is then the *only* thing that can give them access.
    expect(await permissionFor(created.memberId)).toBeNull()
  })

  test('and somebody outside the organization gets nothing', async () => {
    if (!available)
      return

    expect(await permissionFor(created.outsiderId)).toBeNull()
  })
})

describe('a grant to a team the person is in', () => {
  test('reaches the resolver', async () => {
    if (!available)
      return

    // The wiring. `permissionOn` used to pass `[]` here whatever the database
    // said, so this exact assertion was the one nothing could satisfy.
    const db = (globalThis as any).db
    await db.insertInto('team_members').values({ team_id: created.childTeamId, user_id: created.memberId, role: 'member' }).execute()
    await grant(created.childTeamId, 'write')

    expect(await permissionFor(created.memberId)).toBe('write')
  })

  test('and does nothing for somebody not in it', async () => {
    if (!available)
      return

    expect(await permissionFor(created.outsiderId)).toBeNull()
  })
})

describe('inheritance', () => {
  test('a member of the child gets what the parent was granted', async () => {
    if (!available)
      return

    // "The reviewers team is part of platform", so reviewers can reach what
    // platform can. The member is in the child only.
    await grant(created.parentTeamId, 'maintain')

    expect(await permissionFor(created.memberId)).toBe('maintain')
  })

  test('but a member of the parent gets nothing from the child', async () => {
    if (!available)
      return

    // The direction that matters. Reversing it silently widens every parent
    // team the day somebody creates a narrow child under it.
    const db = (globalThis as any).db
    await db.insertInto('team_members').values({ team_id: created.parentTeamId, user_id: created.ownerId, role: 'member' }).execute()

    // The owner is an organization owner, so their role already grants admin -
    // which is why this asserts on the *member* path instead, with a third
    // person who is only in the parent.
    const only: any = await db
      .insertInto('users')
      .values({ name: 'Parent Only', email: `${unique('tpo')}@example.com`, handle: unique('tpo'), password: 'x' })
      .returning(['id'])
      .executeTakeFirst()

    await db.insertInto('org_members').values({ organization_id: created.orgId, user_id: Number(only.id), role: 'member' }).execute()
    await db.insertInto('team_members').values({ team_id: created.parentTeamId, user_id: Number(only.id), role: 'member' }).execute()

    // Parent grants maintain; the child's `write` must not reach them - and it
    // would not raise the answer anyway, so the child is regranted `admin` to
    // make the assertion mean something.
    await db.updateTable('team_repositories').set({ permission: 'admin' }).where('team_id', '=', created.childTeamId).execute()

    expect(await permissionFor(Number(only.id))).toBe('maintain')

    await db.deleteFrom('team_members').where('user_id', '=', Number(only.id)).execute()
    await db.deleteFrom('org_members').where('user_id', '=', Number(only.id)).execute()
    await db.deleteFrom('users').where('id', '=', Number(only.id)).execute()
  })
})

describe('two teams', () => {
  test('give the union, not the last one read', async () => {
    if (!available)
      return

    const db = (globalThis as any).db

    // Child is admin from the test above; drop it back so the union is the
    // thing being measured rather than a leftover.
    await db.updateTable('team_repositories').set({ permission: 'read' }).where('team_id', '=', created.childTeamId).execute()
    await db.updateTable('team_repositories').set({ permission: 'read' }).where('team_id', '=', created.parentTeamId).execute()

    await db.insertInto('team_members').values({ team_id: created.otherTeamId, user_id: created.memberId, role: 'member' }).execute()
    await grant(created.otherTeamId, 'admin')

    // Most permissive wins, and it comes from the team that is not first by id.
    expect(await permissionFor(created.memberId)).toBe('admin')
  })

  test('and revoking one leaves the other', async () => {
    if (!available)
      return

    // The reason to grant through a team at all: it comes back in one action,
    // and it comes back cleanly.
    const db = (globalThis as any).db
    await db.deleteFrom('team_repositories').where('team_id', '=', created.otherTeamId).execute()

    // Back to what the child and its parent grant, which is read from both.
    expect(await permissionFor(created.memberId)).toBe('read')
  })
})

describe('deleting a team', () => {
  test('takes its grants with it', async () => {
    if (!available)
      return

    // Through the cascade on `team_repositories`. A dangling grant is the kind
    // that survives a reorganisation and gives somebody write on something
    // nobody remembers.
    const db = (globalThis as any).db
    await db.updateTable('team_repositories').set({ permission: 'admin' }).where('team_id', '=', created.childTeamId).execute()

    expect(await permissionFor(created.memberId)).toBe('admin')

    await db.deleteFrom('teams').where('id', '=', created.childTeamId).execute()

    const left: any[] = await db
      .selectFrom('team_repositories')
      .select(['id'])
      .where('team_id', '=', created.childTeamId)
      .execute()

    expect(left).toHaveLength(0)

    /*
     * Null, not the parent's read - and that is the interesting part.
     *
     * Their only route to the parent team was through the child, because
     * inheritance flows downward. Deleting the child removes the inherited
     * access too, which is what somebody deleting a team means and is easy to
     * get wrong in the direction that leaves access behind.
     */
    expect(await permissionFor(created.memberId)).toBeNull()
  })
})

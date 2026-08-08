// Organizations: the invitation, the pages, and the two deletes that refuse.
//
// The rule this file exists for is that **a pending invitation grants nothing**.
// It is a row in `org_members` carrying the role it will have, and every
// permission question in the product goes through `organizationRoleOf` - so if
// that function answered with the role before the invitee accepted, being
// invited would be the same as being a member. The invitation would hand out
// the access it is offering at the moment it is offered.
//
// The pages are asked rather than the functions, because stx fails silently: a
// server script that throws renders its page with every variable undefined and
// says nothing, so the organizations list would show its empty state to
// somebody in four of them. That does not look like a failure; it looks like
// "nothing here yet".
//
// Like the rest of tests/e2e it needs a database, and skips itself loudly when
// there is not one. It needs no git.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

const created = {
  ownerId: 0,
  ownerToken: '',
  inviteeId: 0,
  inviteeToken: '',
  outsiderId: 0,
  outsiderToken: '',
  orgId: 0,
  orgHandle: '',
  repositoryId: 0,
}

let available = false
let port = 0
let server: any = null
let organizationRoleOf: any

function unique(prefix: string): string {
  return `${prefix}${Buffer.from(crypto.getRandomValues(new Uint8Array(5))).toString('hex')}`
}

async function page(path: string, token?: string): Promise<string> {
  const answer = await fetch(`http://127.0.0.1:${port}${path}`, {
    headers: { Accept: 'text/html', ...(token ? { Cookie: `auth-token=${token}` } : {}) },
  })

  return await answer.text()
}

async function post(path: string, token: string, body: Record<string, unknown>): Promise<{ status: number, json: any }> {
  const answer = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    // A bearer bypasses the CSRF check by design, which is what makes it the
    // right credential for an API test and the wrong one for a form test.
    // Forms are covered in `csrf-forms.test.ts`.
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify(body),
  })

  return { status: answer.status, json: await answer.json().catch(() => null) }
}

beforeAll(async () => {
  try {
    const { injectGlobalAutoImports } = await import('@stacksjs/server')
    const { route } = await import('@stacksjs/router')

    await injectGlobalAutoImports()
    const db = (globalThis as any).db
    await db.selectFrom('users').select(['id']).limit(1).execute()

    ;({ organizationRoleOf } = await import('../../app/Actions/Identity/lookup'))

    await route.importRoutes()
    server = await route.serve({ port: 0, hostname: '127.0.0.1' })
    port = Number((server as any)?.port ?? (server as any)?.server?.port ?? 0)

    if (!port)
      throw new Error('the router did not report a port')

    const { createToken } = await import('@stacksjs/auth')

    const make = async (prefix: string): Promise<{ id: number, token: string }> => {
      const handle = unique(prefix)
      const row: any = await db
        .insertInto('users')
        .values({ name: 'Org Person', email: `${handle}@example.com`, handle, password: 'x' })
        .returning(['id'])
        .executeTakeFirst()

      const id = Number(row?.id)
      const issued: any = await createToken(id, 'organizations test')

      return { id, token: String(issued?.plainTextToken ?? issued?.token ?? issued) }
    }

    const owner = await make('oorg')
    const invitee = await make('oinv')
    const outsider = await make('oout')

    created.ownerId = owner.id
    created.ownerToken = owner.token
    created.inviteeId = invitee.id
    created.inviteeToken = invitee.token
    created.outsiderId = outsider.id
    created.outsiderToken = outsider.token

    created.orgHandle = unique('oteam')
    const org: any = await db
      .insertInto('organizations')
      .values({ handle: created.orgHandle, name: 'Org Under Test' })
      .returning(['id'])
      .executeTakeFirst()

    created.orgId = Number(org?.id)

    await db.insertInto('org_members').values({
      organization_id: created.orgId,
      user_id: created.ownerId,
      role: 'owner',
      joined_at: new Date().toISOString(),
    }).execute()

    available = true
  }
  catch (error) {
    console.warn(`[organizations] skipping: ${error instanceof Error ? error.message : String(error)}`)
    available = false
  }
}, 120_000)

afterAll(async () => {
  const db = (globalThis as any).db

  try {
    if (db) {
      if (created.repositoryId)
        await db.deleteFrom('repositories').where('id', '=', created.repositoryId).execute()

      if (created.orgId)
        await db.deleteFrom('organizations').where('id', '=', created.orgId).execute()

      const users = [created.ownerId, created.inviteeId, created.outsiderId].filter(Boolean)
      if (users.length > 0)
        await db.deleteFrom('users').where('id', 'in', users).execute()
    }
  }
  finally {
    server?.stop?.()
  }
}, 30_000)

describe('an invitation', () => {
  test('is a row that grants nothing', async () => {
    if (!available)
      return

    const sent = await post('/api/orgs/members', created.ownerToken, {
      organization_id: created.orgId,
      handle: (await handleOf(created.inviteeId)),
      role: 'admin',
    })

    expect(sent.status).toBe(201)
    expect(sent.json?.pending).toBe(true)

    // The row exists and carries the role it will have.
    const row: any = await (globalThis as any).db
      .selectFrom('org_members')
      .select(['role', 'joined_at'])
      .where('organization_id', '=', created.orgId)
      .where('user_id', '=', created.inviteeId)
      .executeTakeFirst()

    expect(String(row?.role)).toBe('admin')
    expect(row?.joined_at).toBeFalsy()

    // And it answers null everywhere it matters. This is the assertion the
    // whole design hangs on: were it 'admin' here, being invited would be the
    // same as being a member.
    expect(await organizationRoleOf(created.orgId, created.inviteeId)).toBeNull()
  })

  test('shows up in the invitee inbox', async () => {
    if (!available)
      return

    const rows: any[] = await (globalThis as any).db
      .selectFrom('notifications')
      .select(['type', 'data'])
      .where('user_id', '=', created.inviteeId)
      .execute()

    expect(rows.some(row => String(row.type) === 'org:invited')).toBe(true)
  })

  test('is on their organizations page, marked', async () => {
    if (!available)
      return

    const html = await page('/settings/organizations', created.inviteeToken)

    expect(html).toContain('Waiting for you')
    expect(html).toContain('Invited as admin')
  })

  test('and accepting is what makes it access', async () => {
    if (!available)
      return

    const accepted = await post('/api/orgs/members/accept', created.inviteeToken, {
      organization_id: created.orgId,
    })

    expect(accepted.status).toBe(200)
    expect(await organizationRoleOf(created.orgId, created.inviteeId)).toBe('admin')
  })

  test('accepting twice is not an error', async () => {
    if (!available)
      return

    // The usual way to reach this is a second click on a notification still
    // sitting in the inbox, and the desired state holds either way.
    const again = await post('/api/orgs/members/accept', created.inviteeToken, {
      organization_id: created.orgId,
    })

    expect(again.status).toBe(200)
    expect(again.json?.already).toBe(true)
  })

  test('and there is none to accept for somebody never invited', async () => {
    if (!available)
      return

    const none = await post('/api/orgs/members/accept', created.outsiderToken, {
      organization_id: created.orgId,
    })

    expect(none.status).toBe(404)
  })
})

describe('the people page', () => {
  test('lists the members for somebody in the organization', async () => {
    if (!available)
      return

    const html = await page(`/${created.orgHandle}/people`, created.ownerToken)

    expect(html).toContain('people')
    expect(html).toContain(await handleOf(created.inviteeId))
  })

  test('is not found for somebody outside it', async () => {
    if (!available)
      return

    /*
     * The same answer an organization that does not exist would give. A page
     * that says "you cannot see this" has already confirmed the interesting
     * half, and a membership list is a target list.
     */
    const html = await page(`/${created.orgHandle}/people`, created.outsiderToken)

    expect(html).toContain('Not found')
    expect(html).not.toContain(await handleOf(created.inviteeId))
  })
})

describe('updating the organization', () => {
  test('refuses a website that is not http', async () => {
    if (!available)
      return

    // Rendered as an anchor on a page every reader visits, so `javascript:`
    // here is stored XSS with a form in front of it.
    const refused = await post('/api/orgs/update', created.ownerToken, {
      organization_id: created.orgId,
      website: 'javascript:alert(1)',
    })

    expect(refused.status).toBe(422)
  })

  test('refuses a handle that would shadow a route', async () => {
    if (!available)
      return

    const refused = await post('/api/orgs/update', created.ownerToken, {
      organization_id: created.orgId,
      handle: 'settings',
    })

    expect(refused.status).toBe(422)
  })

  test('and is refused entirely for an admin, since settings are the owner rung', async () => {
    if (!available)
      return

    // The invitee accepted as admin above.
    const refused = await post('/api/orgs/update', created.inviteeToken, {
      organization_id: created.orgId,
      name: 'Renamed by an admin',
    })

    expect(refused.status).toBe(403)
  })
})

describe('the orgCan middleware', () => {
  test('refuses a request that names no organization, rather than waving it through', async () => {
    if (!available)
      return

    // A gate whose subject is missing has not passed; it has failed to run, and
    // the two must never be the same answer.
    const refused = await post('/api/orgs/update', created.ownerToken, { name: 'No organization named' })

    expect(refused.status).toBe(422)
  })

  test('and a request from nobody', async () => {
    if (!available)
      return

    const answer = await fetch(`http://127.0.0.1:${port}/api/orgs/update`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ organization_id: created.orgId, name: 'Anonymous rename' }),
    })

    // 401 or 403 - which one is the auth middleware's business. What matters is
    // that it is neither 200 nor a 500 from the gate failing to find its
    // parameter, which is how a misread `_middlewareParams` would present.
    expect([401, 403]).toContain(answer.status)
  })
})

describe('deleting the organization', () => {
  test('needs the handle typed back', async () => {
    if (!available)
      return

    const refused = await post('/api/orgs/delete', created.ownerToken, {
      organization_id: created.orgId,
      confirm: 'not-the-handle',
    })

    expect(refused.status).toBe(422)
  })

  test('is refused while it still owns a repository, and names them', async () => {
    if (!available)
      return

    const name = unique('orepo')
    const repo: any = await (globalThis as any).db
      .insertInto('repositories')
      .values({
        owner_type: 'organization',
        owner_id: created.orgId,
        name,
        visibility: 'private',
        default_branch: 'main',
        disk_path: `x/${name}.git`,
      })
      .returning(['id'])
      .executeTakeFirst()

    created.repositoryId = Number(repo?.id)

    const refused = await post('/api/orgs/delete', created.ownerToken, {
      organization_id: created.orgId,
      confirm: created.orgHandle,
    })

    // A cascade here would take every repository and with them every issue,
    // pull request and review anybody wrote. The refusal comes back as a
    // to-do list rather than a wall.
    expect(refused.status).toBe(409)
    expect(refused.json?.repositories).toContain(name)
  })

  test('and goes through once they are gone, taking the memberships', async () => {
    if (!available)
      return

    const db = (globalThis as any).db
    await db.deleteFrom('repositories').where('id', '=', created.repositoryId).execute()
    created.repositoryId = 0

    const deleted = await post('/api/orgs/delete', created.ownerToken, {
      organization_id: created.orgId,
      confirm: created.orgHandle,
    })

    expect(deleted.status).toBe(200)

    // Through the cascade on `org_members`, which was missing: without it the
    // delete could not run at all while a single membership pointed at the row.
    const left: any[] = await db
      .selectFrom('org_members')
      .select(['id'])
      .where('organization_id', '=', created.orgId)
      .execute()

    expect(left).toHaveLength(0)
    created.orgId = 0
  })
})

/** Somebody's handle, for the endpoints and pages that speak in handles. */
async function handleOf(userId: number): Promise<string> {
  const row: any = await (globalThis as any).db
    .selectFrom('users')
    .select(['handle'])
    .where('id', '=', userId)
    .executeTakeFirst()

  return String(row?.handle ?? '')
}

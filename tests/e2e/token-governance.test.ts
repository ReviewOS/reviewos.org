// The half of access tokens nobody builds: who can see them, who can stop
// them, and what the log remembers.
//
// Three things, and each one is a question an administrator has and a forge
// usually cannot answer:
//
// - **What can currently reach our code.** Not "what are my tokens" - the
//   listing has to find a token nobody scoped to this organization at all, one
//   whose owner picked `all` and happens to be a member. That is the one that
//   gets missed, because nothing joins it to the organization; the link is the
//   membership, not a row about the token.
// - **Stopping one that is not yours.** The case is a contractor leaving or a
//   laptop lost, and in both the person who can act quickly is not the holder.
// - **A machine account.** An account that holds tokens and cannot sign in,
//   because the alternative - a shared human account with the password in a
//   password manager - happens anyway when the product does not offer this.
//
// Like the rest of tests/e2e it needs a database, and skips itself loudly when
// there is not one. It needs no git.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

const created = {
  ownerId: 0,
  ownerToken: '',
  memberId: 0,
  memberToken: '',
  outsiderId: 0,
  outsiderToken: '',
  orgId: 0,
  orgHandle: '',
  repositoryId: 0,
  machineId: 0,
  machineHandle: '',
  scopedTokenId: 0,
  allTokenId: 0,
  outsiderTokenId: 0,
}

let available = false
let port = 0
let server: any = null

function unique(prefix: string): string {
  return `${prefix}${Buffer.from(crypto.getRandomValues(new Uint8Array(5))).toString('hex')}`
}

async function call(method: string, path: string, token: string, body?: Record<string, unknown>): Promise<{ status: number, json: any }> {
  const answer = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })

  return { status: answer.status, json: await answer.json().catch(() => null) }
}

/** A page, as a signed-in browser sees it. */
async function page(path: string, token: string): Promise<string> {
  const answer = await fetch(`http://127.0.0.1:${port}${path}`, {
    headers: { Accept: 'text/html', Cookie: `auth-token=${token}` },
  })

  return await answer.text()
}

/** Issue a token directly, so the test controls its shape. */
async function issue(userId: number, selection: string, extra: Record<string, unknown> = {}): Promise<number> {
  const { generateToken } = await import('../../app/Actions/Tokens/secret')
  const token = generateToken()

  const row: any = await (globalThis as any).db
    .insertInto('access_tokens')
    .values({
      user_id: userId,
      name: unique('tok'),
      prefix: token.prefix,
      token_hash: token.hash,
      selection,
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
      ...extra,
    })
    .returning(['id'])
    .executeTakeFirst()

  return Number(row?.id)
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

    const { createToken } = await import('@stacksjs/auth')

    const make = async (prefix: string): Promise<{ id: number, token: string }> => {
      const handle = unique(prefix)
      const row: any = await db
        .insertInto('users')
        .values({ name: 'Token Person', email: `${handle}@example.com`, handle, password: 'x' })
        .returning(['id'])
        .executeTakeFirst()

      const id = Number(row?.id)
      const issued: any = await createToken(id, 'token governance test')

      return { id, token: String(issued?.plainTextToken ?? issued?.token ?? issued) }
    }

    const owner = await make('tgo')
    const member = await make('tgm')
    const outsider = await make('tgx')

    created.ownerId = owner.id
    created.ownerToken = owner.token
    created.memberId = member.id
    created.memberToken = member.token
    created.outsiderId = outsider.id
    created.outsiderToken = outsider.token

    created.orgHandle = unique('tgorg')
    const org: any = await db
      .insertInto('organizations')
      .values({ handle: created.orgHandle, name: 'Token Org' })
      .returning(['id'])
      .executeTakeFirst()

    created.orgId = Number(org?.id)

    for (const [userId, role] of [[created.ownerId, 'owner'], [created.memberId, 'member']] as const) {
      await db.insertInto('org_members').values({
        organization_id: created.orgId,
        user_id: userId,
        role,
        joined_at: new Date().toISOString(),
      }).execute()
    }

    const name = unique('tgrepo')
    const repo: any = await db
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

    // Scoped explicitly at the organization's repository.
    created.scopedTokenId = await issue(created.memberId, 'selected')
    await db.insertInto('access_token_repositories').values({
      access_token_id: created.scopedTokenId,
      repository_id: created.repositoryId,
    }).execute()

    // Scoped at nothing in particular. Reaches here because its owner is a
    // member, which is the link the listing has to find on its own.
    created.allTokenId = await issue(created.memberId, 'all')

    // The control: same shape, owner is not in the organization.
    created.outsiderTokenId = await issue(created.outsiderId, 'all')

    available = true
  }
  catch (error) {
    console.warn(`[token-governance] skipping: ${error instanceof Error ? error.message : String(error)}`)
    available = false
  }
}, 120_000)

afterAll(async () => {
  const db = (globalThis as any).db

  try {
    if (db) {
      // Permissions before tokens, because `access_token_permissions` has a
      // foreign key onto them and Postgres refuses the delete otherwise. Every
      // token here is issued through the endpoint, so each one has grant rows.
      const tokenIds = [created.scopedTokenId, created.allTokenId, created.outsiderTokenId].filter(Boolean)
      if (tokenIds.length > 0) {
        await db.deleteFrom('access_token_repositories').where('access_token_id', 'in', tokenIds).execute()
        await db.deleteFrom('access_token_permissions').where('access_token_id', 'in', tokenIds).execute()
        await db.deleteFrom('access_tokens').where('id', 'in', tokenIds).execute()
      }

      if (created.repositoryId)
        await db.deleteFrom('repositories').where('id', '=', created.repositoryId).execute()

      if (created.orgId)
        await db.deleteFrom('organizations').where('id', '=', created.orgId).execute()

      // The same ordering for anything issued to these accounts that the list
      // above did not name - a rotation, for one, creates a token nobody
      // recorded the id of.
      const users = [created.ownerId, created.memberId, created.outsiderId, created.machineId].filter(Boolean)
      if (users.length > 0) {
        const theirs = (await db
          .selectFrom('access_tokens')
          .select(['id'])
          .where('user_id', 'in', users)
          .execute()).map((row: any) => Number(row.id))

        if (theirs.length > 0) {
          await db.deleteFrom('access_token_repositories').where('access_token_id', 'in', theirs).execute()
          await db.deleteFrom('access_token_permissions').where('access_token_id', 'in', theirs).execute()
          await db.deleteFrom('access_tokens').where('id', 'in', theirs).execute()
        }

        // Audit rows before the accounts they name. `audit_events.actor_id`
        // has no `onDelete`, so the database refuses to remove a user who has
        // ever done anything auditable - which is worth knowing about beyond
        // this teardown, and is noted where the model declares it.
        await db.deleteFrom('audit_events').where('actor_id', 'in', users).execute()
        await db.deleteFrom('users').where('id', 'in', users).execute()
      }
    }
  }
  finally {
    server?.stop?.()
  }
}, 30_000)

describe('what can reach an organization', () => {
  test('includes a token scoped at one of its repositories', async () => {
    if (!available)
      return

    const listed = await call('GET', `/api/orgs/tokens?organization_id=${created.orgId}`, created.ownerToken)

    expect(listed.status).toBe(200)
    expect(listed.json?.tokens?.some((token: any) => token.id === created.scopedTokenId)).toBe(true)
  })

  test('and one scoped at nothing, whose owner is simply a member', async () => {
    if (!available)
      return

    /*
     * The one that gets missed. Nothing joins this token to the organization -
     * the link is the owner's membership, not a row about the token - so a
     * listing built by querying token tables finds the first case and reports a
     * clean answer that is wrong.
     */
    const listed = await call('GET', `/api/orgs/tokens?organization_id=${created.orgId}`, created.ownerToken)
    const found = listed.json?.tokens?.find((token: any) => token.id === created.allTokenId)

    expect(found).toBeDefined()
    expect(found?.via).toBe('membership')
  })

  test('but not one belonging to somebody outside it', async () => {
    if (!available)
      return

    const listed = await call('GET', `/api/orgs/tokens?organization_id=${created.orgId}`, created.ownerToken)

    expect(listed.json?.tokens?.some((token: any) => token.id === created.outsiderTokenId)).toBe(false)
  })

  test('and never a secret, in any form', async () => {
    if (!available)
      return

    const listed = await call('GET', `/api/orgs/tokens?organization_id=${created.orgId}`, created.ownerToken)
    const body = JSON.stringify(listed.json)

    expect(body).not.toContain('token_hash')
    expect(body).not.toContain('"secret"')
  })

  test('is not readable by a plain member', async () => {
    if (!available)
      return

    // A member can see who their colleagues are. Enumerating their credentials
    // is a different thing, and the refusal is a 404 so it does not confirm
    // that the list is worth asking about.
    const refused = await call('GET', `/api/orgs/tokens?organization_id=${created.orgId}`, created.memberToken)

    expect(refused.status).toBe(404)
  })
})

describe('revoking a token that is not yours', () => {
  test('an organization owner may stop one that reaches them', async () => {
    if (!available)
      return

    const revoked = await call('POST', '/api/user/tokens/revoke', created.ownerToken, {
      id: created.scopedTokenId,
      reason: 'contractor left',
    })

    expect(revoked.status).toBe(200)
    expect(revoked.json?.revoked_as_administrator).toBe(true)
  })

  test('and the log says who did it, and why', async () => {
    if (!available)
      return

    const rows: any[] = await (globalThis as any).db
      .selectFrom('audit_events')
      .select(['action', 'actor_id', 'reason', 'detail'])
      .where('subject_type', '=', 'access_token')
      .where('subject_id', '=', created.scopedTokenId)
      .execute()

    const revocation = rows.find(row => String(row.action) === 'token:revoked')

    expect(revocation).toBeDefined()
    // The distinction worth reading months later: somebody's token stopped by
    // somebody else.
    expect(Number(revocation?.actor_id)).toBe(created.ownerId)
    expect(String(revocation?.reason)).toBe('contractor left')

    const detail = JSON.parse(String(revocation?.detail ?? '{}'))
    expect(detail.owner_id).toBe(created.memberId)
    expect(detail.by_owner).toBe(false)
  })

  test('but not one that reaches nothing of theirs', async () => {
    if (!available)
      return

    // Reported as missing rather than forbidden, so token ids cannot be
    // enumerated by an administrator of any organization.
    const refused = await call('POST', '/api/user/tokens/revoke', created.ownerToken, {
      id: created.outsiderTokenId,
    })

    expect(refused.status).toBe(404)
  })

  test('and a plain member cannot stop a colleague\'s', async () => {
    if (!available)
      return

    const refused = await call('POST', '/api/user/tokens/revoke', created.memberToken, {
      id: created.outsiderTokenId,
    })

    expect(refused.status).toBe(404)
  })
})

describe('a machine account', () => {
  test('is created by an organization owner', async () => {
    if (!available)
      return

    created.machineHandle = unique('tgbot')

    const made = await call('POST', '/api/orgs/machine-accounts', created.ownerToken, {
      organization_id: created.orgId,
      handle: created.machineHandle,
      name: 'CI',
    })

    expect(made.status).toBe(201)
    created.machineId = Number(made.json?.id)
    expect(created.machineId).toBeGreaterThan(0)
  })

  test('cannot sign in, because its password is 64 random bytes nobody kept', async () => {
    if (!available)
      return

    /*
     * Enforced by the password rather than by a flag, which is the point: a
     * flag checked in one of three entry points is how these become back doors.
     * `Auth.attempt` fails for it through the code that already exists.
     */
    const row: any = await (globalThis as any).db
      .selectFrom('users')
      .select(['password', 'email', 'machine_for_organization_id'])
      .where('id', '=', created.machineId)
      .executeTakeFirst()

    expect(String(row?.password ?? '')).toStartWith('$')
    expect(Number(row?.machine_for_organization_id)).toBe(created.orgId)
    // And the address cannot receive a reset link, which is the one route back
    // into an account that is supposed to have no way in. `.invalid` is
    // reserved by RFC 2606 and can never resolve.
    expect(String(row?.email ?? '')).toEndWith('.invalid')
  })

  test('is a member at the floor, so it reaches nothing by existing', async () => {
    if (!available)
      return

    const { organizationRoleOf } = await import('../../app/Actions/Identity/lookup')

    // A machine that can read everything by existing is the shared account
    // again with a better name.
    expect(await organizationRoleOf(created.orgId, created.machineId)).toBe('member')
  })

  test('can be issued a token by somebody who administers its organization', async () => {
    if (!available)
      return

    // Without this the feature does not work at all: it cannot sign in, so it
    // can never ask for a token as itself.
    const issued = await call('POST', '/api/user/tokens', created.ownerToken, {
      machine_account_id: created.machineId,
      name: 'ci deploy',
      selection: 'organization',
      organization_id: created.orgId,
      permissions: [{ scope: 'contents', level: 'read' }],
    })

    expect(issued.status).toBe(201)

    // Belonging to the machine, not to the owner who asked.
    const row: any = await (globalThis as any).db
      .selectFrom('access_tokens')
      .select(['user_id'])
      .where('id', '=', Number(issued.json?.id))
      .executeTakeFirst()

    expect(Number(row?.user_id)).toBe(created.machineId)
  })

  test('and not by a plain member of that organization', async () => {
    if (!available)
      return

    const refused = await call('POST', '/api/user/tokens', created.memberToken, {
      machine_account_id: created.machineId,
      name: 'not mine to issue',
      selection: 'organization',
      organization_id: created.orgId,
      permissions: [{ scope: 'contents', level: 'read' }],
    })

    expect(refused.status).toBe(404)
  })

  test('and a person is never a valid target, which keeps this from being impersonation', async () => {
    if (!available)
      return

    const refused = await call('POST', '/api/user/tokens', created.ownerToken, {
      machine_account_id: created.memberId,
      name: 'a colleague',
      selection: 'organization',
      organization_id: created.orgId,
      permissions: [{ scope: 'contents', level: 'read' }],
    })

    expect(refused.status).toBe(404)
  })
})

describe('the pages', () => {
  test('the token list renders for an owner, with the reach that gets missed', async () => {
    if (!available)
      return

    /*
     * Asked of the page rather than the function, because stx fails silently: a
     * server script that throws renders with every variable undefined, so this
     * page would show "nothing can reach these repositories" to an organization
     * with four live tokens. That does not look like a failure - it looks like
     * good news.
     */
    const html = await page(`/${created.orgHandle}/tokens`, created.ownerToken)

    expect(html).toContain('live')
    expect(html).toContain(created.orgHandle)
    expect(html).toContain('reaches everything its owner can')
  })

  test('and is not found for a plain member', async () => {
    if (!available)
      return

    const html = await page(`/${created.orgHandle}/tokens`, created.memberToken)

    expect(html).toContain('Not found')
    expect(html).not.toContain('reaches everything its owner can')
  })

  test('the people page lists a machine account, separately from the people', async () => {
    if (!available)
      return

    const html = await page(`/${created.orgHandle}/people`, created.ownerToken)

    expect(html).toContain('Machine accounts')
    expect(html).toContain(created.machineHandle)
    // Said on the row, because it is the property that makes the account worth
    // having rather than a shared login.
    expect(html).toContain('cannot sign in')
  })
})

describe('the log', () => {
  test('records a token being created, with what it was born able to do', async () => {
    if (!available)
      return

    const rows: any[] = await (globalThis as any).db
      .selectFrom('audit_events')
      .select(['action', 'detail'])
      .where('action', '=', 'token:created')
      .execute()

    const mine = rows
      .map(row => JSON.parse(String(row.detail ?? '{}')))
      .filter(detail => detail.owner_id === created.machineId)

    expect(mine.length).toBeGreaterThan(0)
    // The whole set, not a count: every later question is read against this.
    expect(mine[0].permissions).toContain('contents:read')
  })

  test('records the first use, once, with no actor', async () => {
    if (!available)
      return

    const { recordTokenUse } = await import('../../app/Actions/Tokens/authenticate')

    await recordTokenUse(created.allTokenId, '203.0.113.9')
    await recordTokenUse(created.allTokenId, '203.0.113.9')

    const rows: any[] = await (globalThis as any).db
      .selectFrom('audit_events')
      .select(['actor_id'])
      .where('action', '=', 'token:first-used')
      .where('subject_id', '=', created.allTokenId)
      .execute()

    // Once. A log with a row per clone is a log nobody reads.
    expect(rows).toHaveLength(1)
    // And no actor: this is the token acting, not a person, and naming the
    // owner would read as them having done something.
    expect(rows[0]?.actor_id).toBeFalsy()
  })

  test('and never the secret, in any form', async () => {
    if (!available)
      return

    const rows: any[] = await (globalThis as any).db
      .selectFrom('audit_events')
      .select(['detail'])
      .where('subject_type', '=', 'access_token')
      .execute()

    const body = rows.map(row => String(row.detail ?? '')).join('\n')

    /*
     * An audit log is the thing most likely to be shipped somewhere central and
     * read by people who are not administrators. It must never be a place where
     * a credential can be recovered - not the token, not a truncated token, not
     * a hash.
     */
    expect(body).not.toContain('token_hash')
    expect(body).not.toContain('$2b$')
  })
})

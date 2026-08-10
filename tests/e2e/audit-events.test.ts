// The audit log, written the way it is actually written: by a listener, over
// the real event bus, from a real request.
//
// The reason this file exists rather than calling the listener directly - which
// is how the notification tests do it, deliberately - is that the bus is the
// part that was broken. `app/Events.ts` was read at runtime by nothing and the
// listener discovery was called by nothing, so every listener in this
// application was registered nowhere: `dispatch` returned normally and the row
// was never written. A test that calls the handler itself passes throughout
// that, which is exactly why the notification suite never caught it.
//
// So these go through HTTP. If registration breaks again, this file goes red.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

const created = {
  ownerId: 0,
  ownerToken: '',
  memberId: 0,
  otherId: 0,
  organizationId: 0,
  repositoryId: 0,
  repositoryName: '',
  ownerHandle: '',
  memberHandle: '',
}

let available = false
let port = 0
let server: any = null

function unique(prefix: string): string {
  return `${prefix}${Buffer.from(crypto.getRandomValues(new Uint8Array(5))).toString('hex')}`
}

/**
 * The base64 body of a fresh ed25519 public key.
 *
 * Built to the SSH wire format - a length-prefixed type followed by a
 * length-prefixed 32 bytes - rather than faked with random base64, because the
 * parser checks that the type inside the blob agrees with the type on the line.
 * Random bytes are rejected, and a test that quietly skipped on rejection would
 * assert nothing while looking green.
 */
function ed25519Body(): string {
  const type = Buffer.from('ssh-ed25519')
  const key = Buffer.from(crypto.getRandomValues(new Uint8Array(32)))
  const length = (value: Buffer) => {
    const header = Buffer.alloc(4)
    header.writeUInt32BE(value.length)

    return Buffer.concat([header, value])
  }

  return Buffer.concat([length(type), length(key)]).toString('base64')
}

async function post(path: string, body: Record<string, unknown>): Promise<{ status: number, body: any }> {
  const answer = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${created.ownerToken}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      // Recorded on the row, and asserted below: the fastest way to tell a
      // person from a script after the fact.
      'User-Agent': 'audit-events-test/1.0',
    },
    body: JSON.stringify(body),
  })

  return { status: answer.status, body: await answer.json().catch(() => null) }
}

/** The most recent audit row for an action, or null. */
async function lastAudit(action: string): Promise<any> {
  const row: any = await (globalThis as any).db
    .selectFrom('audit_events')
    .selectAll()
    .where('action', '=', action)
    .where('repository_id', '=', created.repositoryId)
    .orderBy('id', 'desc')
    .executeTakeFirst()

  return row ?? null
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

    const { generateToken } = await import('../../app/Actions/Tokens/secret')

    const make = async (prefix: string) => {
      const handle = unique(prefix)
      const row: any = await db
        .insertInto('users')
        .values({ name: 'Audit Person', email: `${handle}@example.com`, handle, password: 'x' })
        .returning(['id'])
        .executeTakeFirst()

      return { id: Number(row?.id), handle }
    }

    const owner = await make('auditevowner')
    created.ownerId = owner.id
    created.ownerHandle = owner.handle

    const member = await make('auditevmember')
    created.memberId = member.id
    created.memberHandle = member.handle

    const other = await make('auditevother')
    created.otherId = other.id

    const token = generateToken()
    const tokenRow: any = await db.insertInto('access_tokens').values({
      user_id: created.ownerId,
      name: 'audit events test',
      prefix: token.prefix,
      token_hash: token.hash,
      selection: 'all',
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    }).returning(['id']).executeTakeFirst()

    created.ownerToken = token.token

    // `administration` at `admin`, because these endpoints are the two that
    // `app/TokenScopes.ts` puts there: protecting a branch and handing out
    // access. The account's own permission is not enough on its own - a
    // fine-grained token is the narrower of the two, which is the point of it.
    await db.insertInto('access_token_permissions').values({
      access_token_id: Number(tokenRow?.id),
      scope: 'administration',
      level: 'admin',
    }).execute()

    const organization: any = await db
      .insertInto('organizations')
      .values({ name: 'Audited', handle: unique('auditevorg') })
      .returning(['id'])
      .executeTakeFirst()

    created.organizationId = Number(organization?.id)

    await db.insertInto('org_members').values({
      organization_id: created.organizationId,
      user_id: created.ownerId,
      role: 'owner',
      joined_at: new Date().toISOString(),
    }).execute()

    await db.insertInto('org_members').values({
      organization_id: created.organizationId,
      user_id: created.memberId,
      role: 'member',
      joined_at: new Date().toISOString(),
    }).execute()

    created.repositoryName = unique('auditevrepo')
    const repository: any = await db
      .insertInto('repositories')
      .values({
        owner_type: 'organization',
        owner_id: created.organizationId,
        name: created.repositoryName,
        visibility: 'private',
        default_branch: 'main',
        disk_path: `${unique('auditev')}/x.git`,
      })
      .returning(['id'])
      .executeTakeFirst()

    created.repositoryId = Number(repository?.id)
    available = true
  }
  catch (error) {
    console.warn(`[audit-events] skipping: ${error instanceof Error ? error.message : String(error)}`)
    available = false
  }
}, 120_000)

afterAll(async () => {
  const db = (globalThis as any).db

  try {
    if (db) {
      const users = [created.ownerId, created.memberId, created.otherId].filter(Boolean)

      if (created.organizationId)
        await db.deleteFrom('audit_events').where('organization_id', '=', created.organizationId).execute()

      if (users.length > 0)
        await db.deleteFrom('audit_events').where('actor_id', 'in', users).execute()

      if (created.repositoryId) {
        await db.deleteFrom('protected_branches').where('repository_id', '=', created.repositoryId).execute()
        await db.deleteFrom('repo_collaborators').where('repository_id', '=', created.repositoryId).execute()
        await db.deleteFrom('repositories').where('id', '=', created.repositoryId).execute()
      }

      if (created.organizationId) {
        await db.deleteFrom('org_members').where('organization_id', '=', created.organizationId).execute()
        await db.deleteFrom('organizations').where('id', '=', created.organizationId).execute()
      }

      if (users.length > 0) {
        await db.deleteFrom('access_tokens').where('user_id', 'in', users).execute()
        await db.deleteFrom('users').where('id', 'in', users).execute()
      }
    }
  }
  finally {
    server?.stop?.()
  }
}, 60_000)

describe('protected branch rules', () => {
  /** The owner handle of the organization, needed by every repository route. */
  let ownerHandle = ''

  beforeAll(async () => {
    if (!available)
      return

    const row: any = await (globalThis as any).db
      .selectFrom('organizations')
      .select(['handle'])
      .where('id', '=', created.organizationId)
      .executeTakeFirst()

    ownerHandle = String(row?.handle ?? '')
  })

  test('creating one records what it was set to', async () => {
    if (!available)
      return

    const answer = await post('/api/repos/protected-branches', {
      owner: ownerHandle,
      repo: created.repositoryName,
      pattern: 'main',
      required_approvals: 2,
      allow_force_push: 'false',
      required_checks: 'build, test',
    })

    expect(answer.status).toBe(201)

    const row = await lastAudit('branch:protection-changed')

    // The row exists at all, which is the whole point of this file: nothing
    // called the listener, the bus did.
    expect(row).not.toBeNull()
    expect(Number(row.actor_id)).toBe(created.ownerId)
    expect(Number(row.organization_id)).toBe(created.organizationId)

    const detail = JSON.parse(String(row.detail))
    expect(detail.pattern).toBe('main')
    expect(detail.created).toBe(true)
    expect(detail.to.required_approvals).toBe(2)
    // Both spellings of a check list arrive as the same stored JSON.
    expect(JSON.parse(detail.to.required_checks)).toEqual(['build', 'test'])
  })

  test('the request identifies itself on the row', async () => {
    if (!available)
      return

    const row = await lastAudit('branch:protection-changed')

    // A token, not a session. The audit log's job here is to say which
    // credential did it, not only which account.
    expect(Number(row.access_token_id)).toBeGreaterThan(0)
    expect(String(row.user_agent)).toBe('audit-events-test/1.0')
  })

  test('changing one records both sides', async () => {
    if (!available)
      return

    const answer = await post('/api/repos/protected-branches', {
      owner: ownerHandle,
      repo: created.repositoryName,
      pattern: 'main',
      required_approvals: 1,
    })

    expect(answer.status).toBe(200)

    const detail = JSON.parse(String((await lastAudit('branch:protection-changed')).detail))

    // The useful question is never what the rule says now.
    expect(detail.from.required_approvals).toBe(2)
    expect(detail.to.required_approvals).toBe(1)
    expect(detail.created).toBe(false)
  })

  test('removing one records what it required', async () => {
    if (!available)
      return

    /*
     * The event with the most to answer for. A force push at an unprotected
     * branch is an ordinary push and is recorded nowhere, so "remove the rule,
     * rewrite the history, put it back" leaves no trace unless the removal
     * itself does.
     */
    const answer = await post('/api/repos/protected-branches', {
      owner: ownerHandle,
      repo: created.repositoryName,
      pattern: 'main',
      operation: 'delete',
    })

    expect(answer.status).toBe(200)

    const row = await lastAudit('branch:protection-removed')
    expect(row).not.toBeNull()
    expect(JSON.parse(String(row.detail)).was.required_approvals).toBe(1)
  })

  test('a pattern that could never match a branch is refused', async () => {
    if (!available)
      return

    // A rule that silently protects nothing is worse than no rule: the settings
    // page shows it and everybody believes it.
    const answer = await post('/api/repos/protected-branches', {
      owner: ownerHandle,
      repo: created.repositoryName,
      pattern: 'main branch',
    })

    expect(answer.status).toBe(422)
  })
})

describe('collaborators', () => {
  let ownerHandle = ''

  beforeAll(async () => {
    if (!available)
      return

    const row: any = await (globalThis as any).db
      .selectFrom('organizations')
      .select(['handle'])
      .where('id', '=', created.organizationId)
      .executeTakeFirst()

    ownerHandle = String(row?.handle ?? '')
  })

  test('granting access records who got what', async () => {
    if (!available)
      return

    const answer = await post('/api/repos/collaborators', {
      owner: ownerHandle,
      repo: created.repositoryName,
      handle: created.memberHandle,
      permission: 'write',
    })

    expect(answer.status).toBe(201)

    const row = await lastAudit('collaborator:changed')
    expect(row).not.toBeNull()
    expect(Number(row.subject_id)).toBe(created.memberId)

    const detail = JSON.parse(String(row.detail))
    expect(detail.from).toBeNull()
    expect(detail.to).toBe('write')
  })

  test('revoking access records what was taken away', async () => {
    if (!available)
      return

    const answer = await post('/api/repos/collaborators', {
      owner: ownerHandle,
      repo: created.repositoryName,
      handle: created.memberHandle,
      operation: 'revoke',
    })

    expect(answer.status).toBe(200)

    const row = await lastAudit('collaborator:removed')
    expect(row).not.toBeNull()
    expect(JSON.parse(String(row.detail)).was).toBe('write')
  })
})

describe('visibility', () => {
  test('going public is recorded, and a rename is not', async () => {
    if (!available)
      return

    const db = (globalThis as any).db
    const organization: any = await db
      .selectFrom('organizations')
      .select(['handle'])
      .where('id', '=', created.organizationId)
      .executeTakeFirst()

    const before: any = await db
      .selectFrom('audit_events')
      .select(['id'])
      .where('repository_id', '=', created.repositoryId)
      .orderBy('id', 'desc')
      .executeTakeFirst()

    // A description change on its own writes nothing. Recording every settings
    // save would bury the one line that matters under merge-strategy toggles.
    await post('/api/repos/settings', {
      owner: String(organization?.handle ?? ''),
      repo: created.repositoryName,
      description: 'Nothing to see',
    })

    expect(await lastAudit('repository:visibility-changed')).toBeNull()

    await post('/api/repos/settings', {
      owner: String(organization?.handle ?? ''),
      repo: created.repositoryName,
      visibility: 'public',
    })

    const row = await lastAudit('repository:visibility-changed')
    expect(row).not.toBeNull()
    expect(Number(row.id)).toBeGreaterThan(Number(before?.id ?? 0))

    const detail = JSON.parse(String(row.detail))
    expect(detail.from).toBe('private')
    expect(detail.to).toBe('public')
  })
})

describe('keys', () => {
  test('adding an SSH key records its fingerprint, and removing it records the same one', async () => {
    if (!available)
      return

    const db = (globalThis as any).db

    // A genuinely well-formed key, built to the wire format rather than faked,
    // so the parser and the fingerprint are the ones this runs in production.
    const added = await post('/api/user/keys', {
      title: 'Audit test key',
      key: `ssh-ed25519 ${ed25519Body()} audit@test`,
    })

    expect(added.status).toBe(201)

    const row: any = await db
      .selectFrom('audit_events')
      .selectAll()
      .where('action', '=', 'key:added')
      .where('actor_id', '=', created.ownerId)
      .orderBy('id', 'desc')
      .executeTakeFirst()

    expect(row).not.toBeNull()

    const detail = JSON.parse(String(row.detail))
    expect(detail.kind).toBe('ssh')
    expect(String(detail.fingerprint).length).toBeGreaterThan(0)

    await post('/api/user/keys/delete', { id: Number(added.body?.id) })

    const removed: any = await db
      .selectFrom('audit_events')
      .selectAll()
      .where('action', '=', 'key:removed')
      .where('actor_id', '=', created.ownerId)
      .orderBy('id', 'desc')
      .executeTakeFirst()

    expect(removed).not.toBeNull()
    // The same key, named after the row that held its fingerprint is gone.
    expect(JSON.parse(String(removed.detail)).fingerprint).toBe(detail.fingerprint)
  })
})

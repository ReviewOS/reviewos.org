// Reading the audit log.
//
// The scope check is the only part of this that can hurt anybody, so most of
// these are about who sees what. An audit log that leaks across organizations
// is worse than no audit log: it hands anybody who can create an organization a
// window onto everybody else, and it does it on the one page people trust.
//
// The rest is the two properties that make a log usable after something has
// gone wrong - it can be searched by the things somebody actually knows, and it
// can be got out of the database in one piece.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

const created = {
  adminId: 0,
  adminToken: '',
  ownerId: 0,
  ownerToken: '',
  strangerId: 0,
  strangerToken: '',
  organizationId: 0,
  organizationHandle: '',
  otherOrganizationId: 0,
  repositoryId: 0,
  repositoryName: '',
  eventIds: [] as number[],
}

let available = false
let port = 0
let server: any = null

function unique(prefix: string): string {
  return `${prefix}${Buffer.from(crypto.getRandomValues(new Uint8Array(5))).toString('hex')}`
}

async function read(query: string, token: string): Promise<{ status: number, body: any }> {
  const answer = await fetch(`http://127.0.0.1:${port}/api/audit${query}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  })

  return { status: answer.status, body: await answer.json().catch(() => null) }
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

    const make = async (prefix: string, admin: boolean) => {
      const handle = unique(prefix)
      const row: any = await db
        .insertInto('users')
        .values({ name: 'Audit Person', email: `${handle}@example.com`, handle, password: 'x', is_admin: admin })
        .returning(['id'])
        .executeTakeFirst()

      const id = Number(row?.id)
      const token = generateToken()

      await db.insertInto('access_tokens').values({
        user_id: id,
        name: 'audit test',
        prefix: token.prefix,
        token_hash: token.hash,
        selection: 'all',
        expires_at: new Date(Date.now() + 86_400_000).toISOString(),
      }).execute()

      return { id, token: token.token }
    }

    const admin = await make('auditadmin', true)
    created.adminId = admin.id
    created.adminToken = admin.token

    const owner = await make('auditowner', false)
    created.ownerId = owner.id
    created.ownerToken = owner.token

    const stranger = await make('auditstranger', false)
    created.strangerId = stranger.id
    created.strangerToken = stranger.token

    const organization = async (prefix: string) => {
      const handle = unique(prefix)
      const row: any = await db
        .insertInto('organizations')
        .values({ name: 'Audited', handle })
        .returning(['id'])
        .executeTakeFirst()

      return { id: Number(row?.id), handle }
    }

    const own = await organization('auditorg')
    created.organizationId = own.id
    created.organizationHandle = own.handle

    const other = await organization('auditother')
    created.otherOrganizationId = other.id

    await db.insertInto('org_members').values({
      organization_id: created.organizationId,
      user_id: created.ownerId,
      role: 'owner',
    }).execute()

    // A member of the *other* organization, so "owner of one" and "member of
    // another" are distinguishable.
    await db.insertInto('org_members').values({
      organization_id: created.otherOrganizationId,
      user_id: created.strangerId,
      role: 'member',
    }).execute()

    created.repositoryName = unique('auditrepo')
    const repository: any = await db
      .insertInto('repositories')
      .values({
        owner_type: 'organization',
        owner_id: created.organizationId,
        name: created.repositoryName,
        visibility: 'private',
        default_branch: 'main',
        disk_path: `${unique('audit')}/x.git`,
      })
      .returning(['id'])
      .executeTakeFirst()

    created.repositoryId = Number(repository?.id)

    const { recordAudit } = await import('../../app/Actions/Git/audit')

    // Three events in this organization, one somewhere else.
    for (const action of ['repository.transferred', 'push.protection.bypassed', 'token:created']) {
      await recordAudit({
        action,
        subject: { type: 'repository', id: created.repositoryId },
        actorId: created.ownerId,
        organizationId: created.organizationId,
        repositoryId: created.repositoryId,
        userAgent: 'curl/8.4',
        ip: '203.0.113.9',
        detail: { note: action },
      })
    }

    await recordAudit({
      action: 'repository.deleted',
      subject: { type: 'repository', id: 999_999 },
      actorId: created.strangerId,
      organizationId: created.otherOrganizationId,
      detail: { note: 'elsewhere' },
    })

    available = true
  }
  catch (error) {
    console.warn(`[audit-log] skipping: ${error instanceof Error ? error.message : String(error)}`)
    available = false
  }
}, 120_000)

afterAll(async () => {
  const db = (globalThis as any).db

  try {
    if (db) {
      const organizations = [created.organizationId, created.otherOrganizationId].filter(Boolean)

      if (organizations.length > 0) {
        await db.deleteFrom('audit_events').where('organization_id', 'in', organizations).execute()
        await db.deleteFrom('org_members').where('organization_id', 'in', organizations).execute()
      }

      if (created.repositoryId)
        await db.deleteFrom('repositories').where('id', '=', created.repositoryId).execute()

      if (organizations.length > 0)
        await db.deleteFrom('organizations').where('id', 'in', organizations).execute()

      const users = [created.adminId, created.ownerId, created.strangerId].filter(Boolean)
      if (users.length > 0) {
        await db.deleteFrom('audit_events').where('actor_id', 'in', users).execute()
        await db.deleteFrom('access_tokens').where('user_id', 'in', users).execute()
        await db.deleteFrom('users').where('id', 'in', users).execute()
      }
    }
  }
  finally {
    server?.stop?.()
  }
}, 60_000)

describe('who may read it', () => {
  test('an instance administrator reads everything', async () => {
    if (!available)
      return

    const answer = await read('', created.adminToken)

    expect(answer.status).toBe(200)
    expect((answer.body?.events ?? []).length).toBeGreaterThan(0)
  })

  test('an organization owner reads their own', async () => {
    if (!available)
      return

    /*
     * The point of the whole scope column. Without this, reading the log means
     * asking an administrator to grep for you, which is why most instances
     * have an audit log nobody has ever read.
     */
    const answer = await read(`?organization_id=${created.organizationId}`, created.ownerToken)

    expect(answer.status).toBe(200)
    expect((answer.body?.events ?? []).length).toBe(3)
  })

  test('and nothing outside it', async () => {
    if (!available)
      return

    const answer = await read(`?organization_id=${created.organizationId}`, created.ownerToken)
    const scopes = new Set((answer.body?.events ?? []).map((event: any) => event.organization_id))

    expect([...scopes]).toEqual([created.organizationId])
  })

  test('an owner of one organization cannot read another', async () => {
    if (!available)
      return

    // The failure this exists to prevent: anybody who can create an
    // organization getting a window onto everybody else.
    const answer = await read(`?organization_id=${created.otherOrganizationId}`, created.ownerToken)

    expect(answer.status).toBe(404)
  })

  test('a member who is not an owner cannot read their own organization', async () => {
    if (!available)
      return

    /*
     * An audit log records what members do. Handing it to every member is
     * handing everybody a record of everybody, which is a different product
     * decision from "the owner can answer for their organization".
     */
    const answer = await read(`?organization_id=${created.otherOrganizationId}`, created.strangerToken)

    expect(answer.status).toBe(404)
  })

  test('and nobody reads the instance log without being an administrator', async () => {
    if (!available)
      return

    const answer = await read('', created.ownerToken)

    expect(answer.status).toBe(404)
  })

  test('a stranger is told the same thing as somebody asking about nothing', async () => {
    if (!available)
      return

    /*
     * 403-versus-404 here is a membership oracle: ask for each id in turn, and
     * the ones answering 403 are the organizations you are not in. So both are
     * 404.
     */
    const real = await read(`?organization_id=${created.organizationId}`, created.strangerToken)
    const imaginary = await read('?organization_id=999999999', created.strangerToken)

    expect(real.status).toBe(imaginary.status)
  })
})

describe('searching', () => {
  test('by action', async () => {
    if (!available)
      return

    const answer = await read(
      `?organization_id=${created.organizationId}&action=push.protection.bypassed`,
      created.ownerToken,
    )

    expect((answer.body?.events ?? []).map((event: any) => event.action)).toEqual(['push.protection.bypassed'])
  })

  test('by repository, named the way every other endpoint names one', async () => {
    if (!available)
      return

    // `owner` and `repo`, not an id. A third spelling for a thing the API
    // already has a word for is what the vocabulary test exists to stop, and it
    // caught this endpoint before it shipped.
    const answer = await read(
      `?organization_id=${created.organizationId}&owner=${created.organizationHandle}&repo=${created.repositoryName}`,
      created.ownerToken,
    )

    expect((answer.body?.events ?? []).length).toBe(3)
  })

  test('and a repository that does not exist is an empty log, not the whole one', async () => {
    if (!available)
      return

    /*
     * Silently dropping an unresolvable filter is how somebody reads a page of
     * unrelated events believing they are looking at one repository's.
     */
    const answer = await read(
      `?organization_id=${created.organizationId}&owner=${created.organizationHandle}&repo=does-not-exist`,
      created.ownerToken,
    )

    expect((answer.body?.events ?? []).length).toBe(0)
  })

  test('by time range, inclusive at both ends', async () => {
    if (!available)
      return

    /*
     * What a person means by "between Tuesday and Thursday" includes Thursday.
     *
     * This test is also the one that caught the timezone trap: `created_at`
     * holds the *database's* wall clock, this suite runs in UTC, and the two
     * Postgres here differ by seven hours - so an unconverted bound returned
     * nothing, which reads as "it did not happen".
     */
    const future = new Date(Date.now() + 60_000).toISOString()
    const past = new Date(Date.now() - 3_600_000).toISOString()

    const inside = await read(
      `?organization_id=${created.organizationId}&since=${past}&until=${future}`,
      created.ownerToken,
    )
    const before = await read(
      `?organization_id=${created.organizationId}&until=${past}`,
      created.ownerToken,
    )

    expect((inside.body?.events ?? []).length).toBe(3)
    expect((before.body?.events ?? []).length).toBe(0)
    // Two requests plus the one-off `LOCALTIMESTAMP` probe, which is more work
    // than Bun's five-second default was chosen for.
  }, 30_000)

  test('newest first, because the question is what just happened', async () => {
    if (!available)
      return

    const answer = await read(`?organization_id=${created.organizationId}`, created.ownerToken)
    const ids = (answer.body?.events ?? []).map((event: any) => event.id)

    expect(ids).toEqual([...ids].sort((a, b) => b - a))
  })

  test('and pages without repeating a row', async () => {
    if (!available)
      return

    /*
     * Keyset rather than offset, because this table is written to while
     * somebody reads it and offset paging over a table being written to
     * silently skips rows - on the one page whose whole purpose is
     * completeness.
     */
    const first = await read(`?organization_id=${created.organizationId}&limit=2`, created.ownerToken)
    const second = await read(
      `?organization_id=${created.organizationId}&limit=2&before=${first.body?.next}`,
      created.ownerToken,
    )

    const seen = [...(first.body?.events ?? []), ...(second.body?.events ?? [])].map((event: any) => event.id)

    expect(seen.length).toBe(3)
    expect(new Set(seen).size).toBe(3)
  })
})

describe('what a row carries', () => {
  test('the credential and the client, not only the person', async () => {
    if (!available)
      return

    // "chris deleted the repository" and "the deploy token chris issued in
    // March deleted the repository" send somebody to two different places.
    const answer = await read(`?organization_id=${created.organizationId}`, created.ownerToken)
    const event = (answer.body?.events ?? [])[0]

    expect(event.actor_id).toBe(created.ownerId)
    expect(event.user_agent).toBe('curl/8.4')
    expect(event.ip_address).toBe('203.0.113.9')
  })

  test('and detail parsed rather than as a string of JSON', async () => {
    if (!available)
      return

    const answer = await read(`?organization_id=${created.organizationId}`, created.ownerToken)
    const event = (answer.body?.events ?? [])[0]

    expect(typeof event.detail).toBe('object')
  })
})

describe('exporting', () => {
  test('is JSON lines, one object per line', async () => {
    if (!available)
      return

    /*
     * So it streams, so `grep` works on it, and so importing it elsewhere is a
     * loop rather than a parser. A single array would have to be built in
     * memory and read the same way.
     */
    const answer = await fetch(
      `http://127.0.0.1:${port}/api/audit?organization_id=${created.organizationId}&format=jsonl`,
      { headers: { Authorization: `Bearer ${created.ownerToken}` } },
    )

    expect(answer.headers.get('Content-Type')).toContain('x-ndjson')

    const lines = (await answer.text()).trim().split('\n')
    const rows = lines.map(line => JSON.parse(line))

    // Four, not the three this organization had: taking a copy of the log is
    // itself an auditable act, so the export records itself and then contains
    // that record. Written before the stream starts rather than after it
    // finishes, because a cancelled download is still a download that began.
    expect(lines).toHaveLength(4)
    expect(rows[0].action).toBe('audit:exported')
  })

  test('and respects the same scope as the reads', async () => {
    if (!available)
      return

    // A second format is a second place the scope check has to be right, which
    // is exactly why it is the same endpoint.
    const answer = await fetch(
      `http://127.0.0.1:${port}/api/audit?organization_id=${created.otherOrganizationId}&format=jsonl`,
      { headers: { Authorization: `Bearer ${created.ownerToken}` } },
    )

    expect(answer.status).toBe(404)
  })
})

describe('append-only', () => {
  test('there is no route that writes one', async () => {
    if (!available)
      return

    /*
     * Append-only is not a setting here - it is the absence of any endpoint
     * that could do otherwise, which is the only version that survives somebody
     * adding a convenience later.
     */
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const answer = await fetch(`http://127.0.0.1:${port}/api/audit`, {
        method,
        headers: { Authorization: `Bearer ${created.adminToken}`, 'Content-Type': 'application/json' },
        body: method === 'DELETE' ? undefined : '{}',
      })

      expect(answer.status).toBeGreaterThanOrEqual(400)
    }
  })
})

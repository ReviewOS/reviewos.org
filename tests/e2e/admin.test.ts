// The administration surface.
//
// Five reads and two writes behind one gate, and the gate is the whole test.
// An administrator sees across every organization and every private repository
// by definition, so a mistake here is not a bug in a page - it is every private
// repository on the instance, readable by whoever noticed.
//
// The rest is about the two levers being the right shape: the last
// administrator cannot demote themselves, and a retried job is moved rather
// than copied.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

const created = {
  adminId: 0,
  adminToken: '',
  personId: 0,
  personHandle: '',
  personToken: '',
  failedJobId: 0,
  repositoryId: 0,
  jobIds: [] as number[],
}

let available = false
let port = 0
let server: any = null

function unique(prefix: string): string {
  return `${prefix}${Buffer.from(crypto.getRandomValues(new Uint8Array(5))).toString('hex')}`
}

async function admin(body: Record<string, unknown>, token = created.adminToken): Promise<{ status: number, body: any }> {
  const answer = await fetch(`http://127.0.0.1:${port}/api/instance/admin`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify(body),
  })

  return { status: answer.status, body: await answer.json().catch(() => null) }
}

beforeAll(async () => {
  try {
    const { injectGlobalAutoImports } = await import('@stacksjs/server')
    const { route } = await import('@stacksjs/router')

    await injectGlobalAutoImports()
    const db = (globalThis as any).db
    await db.selectFrom('failed_jobs').select(['id']).limit(1).execute()

    await route.importRoutes()
    server = await route.serve({ port: 0, hostname: '127.0.0.1' })
    port = Number((server as any)?.port ?? (server as any)?.server?.port ?? 0)

    if (!port)
      throw new Error('the router did not report a port')

    const { generateToken } = await import('../../app/Actions/Tokens/secret')

    const make = async (prefix: string, isAdmin: boolean) => {
      const handle = unique(prefix)
      const row: any = await db
        .insertInto('users')
        .values({ name: 'Admin Person', email: `${handle}@example.com`, handle, password: 'x', is_admin: isAdmin })
        .returning(['id'])
        .executeTakeFirst()

      const id = Number(row?.id)
      const token = generateToken()

      await db.insertInto('access_tokens').values({
        user_id: id,
        name: 'admin test',
        prefix: token.prefix,
        token_hash: token.hash,
        selection: 'all',
        expires_at: new Date(Date.now() + 86_400_000).toISOString(),
      }).execute()

      return { id, handle, token: token.token }
    }

    const administrator = await make('adminuser', true)
    created.adminId = administrator.id
    created.adminToken = administrator.token

    const person = await make('adminother', false)
    created.personId = person.id
    created.personHandle = person.handle
    created.personToken = person.token

    // A failed job to retry. Written directly, because making a job fail for
    // real would mean a worker and a deliberately broken job class - and what
    // is under test is the retry, not the failing.
    const failed: any = await db
      .insertInto('failed_jobs')
      .values({
        connection: 'database',
        queue: 'default',
        payload: JSON.stringify({ name: 'SendNotificationJob', data: { marker: created.adminId } }),
        exception: 'Error: the receiver refused the connection\n    at deliver (app/Jobs/x.ts:1:1)',
        failed_at: new Date().toISOString(),
      })
      .returning(['id'])
      .executeTakeFirst()

    created.failedJobId = Number(failed?.id)

    /*
     * A repository to list.
     *
     * The repositories assertion used to read whatever the rest of the suite
     * had left behind, which is fine on a developer's database and false on
     * CI's: migrated fresh, this file's tests run before anything has made a
     * repository, and "largest first" failed against an empty list. A test
     * that only passes when another test ran first is not testing the thing it
     * names.
     *
     * Written directly rather than through the API, because what is under test
     * is the admin listing - the ordering and the resolved owner handle - and
     * not repository creation, which has its own suite.
     */
    const repository: any = await db
      .insertInto('repositories')
      .values({
        owner_type: 'user',
        owner_id: created.adminId,
        name: unique('adminrepo'),
        visibility: 'public',
        default_branch: 'main',
        disk_path: `${created.personHandle}/admin-listing.git`,
      })
      .returning(['id'])
      .executeTakeFirst()

    created.repositoryId = Number(repository?.id)
    available = true
  }
  catch (error) {
    console.warn(`[admin] skipping: ${error instanceof Error ? error.message : String(error)}`)
    available = false
  }
}, 120_000)

afterAll(async () => {
  const db = (globalThis as any).db

  try {
    if (db) {
      const users = [created.adminId, created.personId].filter(Boolean)

      if (created.failedJobId)
        await db.deleteFrom('failed_jobs').where('id', '=', created.failedJobId).execute()

      if (created.repositoryId)
        await db.deleteFrom('repositories').where('id', '=', created.repositoryId).execute()

      for (const id of created.jobIds)
        await db.deleteFrom('jobs').where('id', '=', id).execute()

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

describe('the gate', () => {
  test('an ordinary account gets a 404, not a 403', async () => {
    if (!available)
      return

    // Whether an instance has an administration API is not something to confirm
    // to somebody who may not use it.
    expect((await admin({ operation: 'stats' }, created.personToken)).status).toBe(404)
  }, 30_000)

  test('and every operation is behind the same one', async () => {
    if (!available)
      return

    /*
     * Five reads and two writes, checked one at a time. One gate in one place
     * is the design, and this is what says it stayed that way: a later
     * operation added below the check would pass every other test in this file.
     */
    for (const operation of ['stats', 'users', 'repositories', 'queue', 'promote', 'demote', 'retry-job'])
      expect((await admin({ operation }, created.personToken)).status).toBe(404)
  }, 30_000)
})

describe('what it shows', () => {
  test('statistics that add up', async () => {
    if (!available)
      return

    const answer = await admin({ operation: 'stats' })

    expect(answer.status).toBe(200)
    expect(answer.body?.users).toBeGreaterThan(0)
    expect(answer.body?.admins).toBeGreaterThan(0)

    // The parts have to sum to the whole, or the page is a set of numbers
    // somebody plans around and cannot reconcile.
    const repositories = answer.body?.repositories
    expect(repositories.private + repositories.public).toBe(repositories.total)

    expect(answer.body?.queue?.failed).toBeGreaterThan(0)
  }, 30_000)

  test('accounts, searchable by the half a handle somebody remembers', async () => {
    if (!available)
      return

    const answer = await admin({ operation: 'users', search: created.personHandle.slice(0, 12) })

    expect(answer.status).toBe(200)
    expect((answer.body?.users ?? []).some((one: any) => one.handle === created.personHandle)).toBe(true)
  }, 30_000)

  test('repositories, largest first', async () => {
    if (!available)
      return

    /*
     * Largest rather than newest, because the question somebody brings to this
     * list is nearly always about disk. Asserted as an ordering rather than
     * against fixed rows, since the instance's contents are whatever the rest
     * of the suite left behind.
     */
    const rows = (await admin({ operation: 'repositories', limit: 20 })).body?.repositories ?? []

    // At least the one this file made. See `beforeAll`.
    expect(rows.length).toBeGreaterThan(0)

    for (let i = 1; i < rows.length; i += 1)
      expect(rows[i - 1].size_kb).toBeGreaterThanOrEqual(rows[i].size_kb)

    // And the owner is a handle rather than a number, which is the only reason
    // the list is readable.
    expect(String(rows[0].owner)).not.toMatch(/^\d+$/)
  }, 30_000)

  test('the queue, with the first line of each failure', async () => {
    if (!available)
      return

    const answer = await admin({ operation: 'queue' })
    const failure = (answer.body?.failed ?? []).find((one: any) => one.id === created.failedJobId)

    expect(failure).toBeDefined()
    expect(failure.job).toBe('SendNotificationJob')

    // The first line only. A stack trace in a table cell makes the table
    // unreadable, and the first line is what somebody scans the column for.
    expect(failure.reason).toBe('Error: the receiver refused the connection')
  }, 30_000)
})

describe('the levers', () => {
  test('promoting somebody is by handle, and recorded', async () => {
    if (!available)
      return

    // By handle rather than by id: an id is a number somebody can mistype into
    // a different person, and this is the most consequential button here.
    const answer = await admin({ operation: 'promote', handle: created.personHandle })

    expect(answer.status).toBe(200)
    expect(answer.body?.is_admin).toBe(true)

    const row: any = await (globalThis as any).db
      .selectFrom('audit_events')
      .selectAll()
      .where('action', '=', 'admin:granted')
      .where('actor_id', '=', created.adminId)
      .orderBy('id', 'desc')
      .executeTakeFirst()

    expect(row).not.toBeNull()
    expect(JSON.parse(String(row.detail)).handle).toBe(created.personHandle)
  }, 30_000)

  test('and demoting them again works', async () => {
    if (!available)
      return

    expect((await admin({ operation: 'demote', handle: created.personHandle })).body?.is_admin).toBe(false)
  }, 30_000)

  test('an unknown handle is a 404 rather than a silent no-op', async () => {
    if (!available)
      return

    expect((await admin({ operation: 'promote', handle: 'nobody-by-that-name' })).status).toBe(404)
  }, 30_000)

  test('a retried job moves back onto the queue and out of the failures', async () => {
    if (!available)
      return

    const db = (globalThis as any).db
    const before: any[] = await db.selectFrom('jobs').select(['id']).execute()

    const answer = await admin({ operation: 'retry-job', id: created.failedJobId })

    expect(answer.status).toBe(200)
    expect(answer.body?.retried).toBe(true)

    /*
     * Moved rather than copied. A retry that left the row behind would show the
     * same failure on the page forever, and an operator working through a list
     * would never see it get shorter.
     */
    const stillFailed: any = await db
      .selectFrom('failed_jobs')
      .select(['id'])
      .where('id', '=', created.failedJobId)
      .executeTakeFirst()

    expect(stillFailed).toBeUndefined()

    const after: any[] = await db.selectFrom('jobs').select(['id']).execute()
    expect(after.length).toBe(before.length + 1)

    // Remembered so the teardown can remove it: this suite must not leave work
    // on the queue of a shared development instance.
    const known = new Set(before.map(row => Number(row.id)))
    created.jobIds.push(...after.map(row => Number(row.id)).filter(id => !known.has(id)))
  }, 30_000)

  test('retrying it a second time says so rather than failing', async () => {
    if (!available)
      return

    // Which is what a second click on the same button looks like. Reporting it
    // as an error teaches people the button is unreliable.
    const answer = await admin({ operation: 'retry-job', id: created.failedJobId })

    expect(answer.status).toBe(200)
    expect(answer.body?.retried).toBe(false)
  }, 30_000)
})

describe('the last administrator', () => {
  test('cannot demote themselves', async () => {
    if (!available)
      return

    /*
     * Unrecoverable otherwise: nobody left can promote a replacement and the
     * fix is an `UPDATE` in `psql`, which is exactly the situation an
     * administration page exists to prevent.
     *
     * The check counts *other* administrators, so this test only means
     * something when this account is the only one - which on a shared
     * development database it usually is not. Asserted conditionally rather
     * than by deleting everybody else's admin flag, which would be a
     * destructive fixture on a database other suites are using.
     */
    const others: any[] = await (globalThis as any).db
      .selectFrom('users')
      .select(['id'])
      .where('is_admin', '=', true)
      .execute()

    const alone = others.filter(row => Number(row.id) !== created.adminId).length === 0
    const answer = await admin({ operation: 'demote', handle: (await admin({ operation: 'users', search: '' })).body?.users?.find((one: any) => one.id === created.adminId)?.handle ?? '' })

    if (alone) {
      expect(answer.status).toBe(422)
      expect(String(answer.body?.error)).toContain('at least one administrator')
    }
    else {
      // Not alone, so demoting is allowed - and this account has to be put back
      // or every test after this one loses its gate.
      expect(answer.status).toBe(200)

      await (globalThis as any).db
        .updateTable('users')
        .set({ is_admin: true })
        .where('id', '=', created.adminId)
        .execute()
    }
  }, 30_000)
})

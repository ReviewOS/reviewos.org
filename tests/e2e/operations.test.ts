// Long-running work, as a resource.
//
// The pattern's whole claim is that a client which can follow one operation can
// follow all of them, so what is worth asserting is the shape rather than the
// mirror sync behind it: the start answers a status URL, a retry with the same
// key joins the operation it already started rather than beginning a second,
// polling is free, and a cancel needs the authority that created it.
//
// Needs a database and a socket. The work itself never runs - there is no queue
// worker here - which is exactly right: an operation that stays `queued` is a
// state the pattern has to describe honestly.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

const created = {
  userId: 0,
  handle: '',
  /** This project's own tokens, because an operation records which one started it. */
  first: '',
  firstId: 0,
  second: '',
  secondId: 0,
  strangerId: 0,
  strangerToken: '',
  name: '',
  repositoryId: 0,
  mirrorId: 0,
  operationIds: [] as number[],
}

let available = false
let port = 0
let server: any = null

function unique(prefix: string): string {
  return `${prefix}${Buffer.from(crypto.getRandomValues(new Uint8Array(5))).toString('hex')}`
}

async function sync(token: string, key?: string): Promise<{ status: number, body: any }> {
  const answer = await fetch(`http://127.0.0.1:${port}/api/mirrors/sync`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      ...(key ? { 'Idempotency-Key': key } : {}),
    },
    body: JSON.stringify({ owner: created.handle, repository: created.name }),
  })

  const body = await answer.json().catch(() => null)

  // Remembered so the cleanup can remove them however the run ends.
  const id = body?.operation?.id
  if (id)
    created.operationIds.push(id)

  return { status: answer.status, body }
}

/**
 * Put the mirror back, because the sync actually runs here.
 *
 * The queue is synchronous in tests, so `MirrorSyncJob` really tries to fetch
 * `example.invalid`, fails, and after enough failures disables the mirror -
 * which is the mirror code working correctly and has nothing to do with the
 * pattern under test.
 */
async function enableMirror(): Promise<void> {
  await (globalThis as any).db
    .updateTable('repository_mirrors')
    .set({ enabled: true, failure_count: 0, last_error: null, last_synced_at: null })
    .where('id', '=', created.mirrorId)
    .execute()
}

/**
 * An operation in a chosen state, written directly.
 *
 * The polling and cancelling tests are about the *resource*, and driving them
 * through a real sync would make them depend on whether a fetch of an invalid
 * host failed before or after the assertion - a race that has nothing to do
 * with what they are checking. The row is what the endpoints read.
 */
async function makeOperation(over: Record<string, unknown> = {}): Promise<string> {
  const uuid = crypto.randomUUID()

  await (globalThis as any).db
    .insertInto('operations')
    .values({
      kind: 'mirror.sync',
      status: 'queued',
      subject_type: 'repository',
      subject_id: created.repositoryId,
      actor_id: created.userId,
      access_token_id: created.firstId,
      uuid,
      ...over,
    })
    .execute()

  return uuid
}

async function status(id: string, token: string, extra: Record<string, string> = {}): Promise<{ status: number, headers: Headers, body: any }> {
  const answer = await fetch(`http://127.0.0.1:${port}/api/operations/${id}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...extra },
  })

  return { status: answer.status, headers: answer.headers, body: await answer.json().catch(() => null) }
}

async function cancel(id: string, token: string): Promise<{ status: number, body: any }> {
  const answer = await fetch(`http://127.0.0.1:${port}/api/operations/${id}/cancel`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'Content-Type': 'application/json' },
    body: '{}',
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

    const makeUser = async (prefix: string) => {
      const handle = unique(prefix)
      const row: any = await db
        .insertInto('users')
        .values({ name: 'Operator', email: `${handle}@example.com`, handle, password: 'x' })
        .returning(['id'])
        .executeTakeFirst()

      return { id: Number(row?.id), handle }
    }

    const issue = async (userId: number) => {
      const token = generateToken()
      const row: any = await db
        .insertInto('access_tokens')
        .values({
          user_id: userId,
          name: 'operations test',
          prefix: token.prefix,
          token_hash: token.hash,
          selection: 'all',
          expires_at: new Date(Date.now() + 86_400_000).toISOString(),
        })
        .returning(['id'])
        .executeTakeFirst()

      const id = Number(row?.id)

      for (const [scope, level] of [['contents', 'write'], ['administration', 'write']]) {
        await db
          .insertInto('access_token_permissions')
          .values({ access_token_id: id, scope, level })
          .execute()
      }

      return { token: token.token, id }
    }

    const owner = await makeUser('ops')
    created.userId = owner.id
    created.handle = owner.handle

    const first = await issue(created.userId)
    created.first = first.token
    created.firstId = first.id

    // A second token on the *same account*, which is the interesting case: two
    // agents under one person must not be able to stop each other.
    const second = await issue(created.userId)
    created.second = second.token
    created.secondId = second.id

    const stranger = await makeUser('opsx')
    created.strangerId = stranger.id
    const strangerToken = await issue(created.strangerId)
    created.strangerToken = strangerToken.token

    created.name = unique('opsrepo')
    const repository: any = await db
      .insertInto('repositories')
      .values({
        owner_type: 'user',
        owner_id: created.userId,
        name: created.name,
        visibility: 'public',
        default_branch: 'main',
        disk_path: `${created.handle}/${created.name}.git`,
      })
      .returning(['id'])
      .executeTakeFirst()

    created.repositoryId = Number(repository?.id)

    const mirror: any = await db
      .insertInto('repository_mirrors')
      .values({
        repository_id: created.repositoryId,
        remote_url: 'https://example.invalid/acme/api.git',
        remote_owner: 'acme',
        remote_name: 'api',
        enabled: true,
        sync_metadata: false,
      })
      .returning(['id'])
      .executeTakeFirst()

    created.mirrorId = Number(mirror?.id)

    available = true
  }
  catch (error) {
    console.warn(`[operations] skipping: ${error instanceof Error ? error.message : String(error)}`)
    available = false
  }
}, 120_000)

afterAll(async () => {
  const db = (globalThis as any).db

  try {
    if (db) {
      const tokens = [created.firstId, created.secondId].filter(Boolean)

      await db.deleteFrom('operations').where('subject_id', '=', created.repositoryId).execute().catch(() => {})

      if (created.mirrorId)
        await db.deleteFrom('repository_mirrors').where('id', '=', created.mirrorId).execute()

      if (created.repositoryId)
        await db.deleteFrom('repositories').where('id', '=', created.repositoryId).execute()

      const users = [created.userId, created.strangerId].filter(Boolean)
      if (users.length > 0) {
        const all: any[] = await db.selectFrom('access_tokens').select(['id']).where('user_id', 'in', users).execute()
        const ids = all.map(row => Number(row.id)).concat(tokens)

        if (ids.length > 0) {
          await db.deleteFrom('operations').where('access_token_id', 'in', ids).execute().catch(() => {})
          await db.deleteFrom('access_token_permissions').where('access_token_id', 'in', ids).execute()
        }

        await db.deleteFrom('access_tokens').where('user_id', 'in', users).execute()
        await db.deleteFrom('users').where('id', 'in', users).execute()
      }
    }
  }
  finally {
    server?.stop?.()
  }
}, 30_000)

describe('starting one', () => {
  test('answers a resource and a status URL, not a bare 202', async () => {
    if (!available)
      return

    await enableMirror()
    const started = await sync(created.first)

    expect(started.status).toBe(202)
    expect(started.body?.operation?.id).toBeTruthy()
    expect(started.body?.operation?.kind).toBe('mirror.sync')
    expect(started.body?.operation?.status).toBe('queued')
    expect(started.body?.operation?.url).toBe(`/api/operations/${started.body.operation.id}`)
  })

  test('and the URL it gave actually answers', async () => {
    if (!available)
      return

    /*
     * The circle that has to close. A status URL a client cannot follow is
     * worse than no URL: it looks like the pattern is implemented.
     */
    await enableMirror()
    const started = await sync(created.first)
    const followed = await status(started.body.operation.id, created.first)

    expect(followed.status).toBe(200)
    expect(followed.body?.operation?.id).toBe(started.body.operation.id)
  })
})

describe('retrying the start', () => {
  test('the same idempotency key joins the operation it already started', async () => {
    if (!available)
      return

    // Agents retry on timeout, and the current behaviour of every forge is to
    // start the work twice.
    const key = unique('key')

    await enableMirror()
    const first = await sync(created.first, key)
    const second = await sync(created.first, key)

    expect(second.body?.operation?.id).toBe(first.body.operation.id)
  })

  test('a different key starts a different one', async () => {
    if (!available)
      return

    // Two deliberate requests are two operations. Deduplicating by subject
    // would silently swallow the second.
    await enableMirror()
    const first = await sync(created.first, unique('key'))
    await enableMirror()
    const second = await sync(created.first, unique('key'))

    expect(second.body?.operation?.id).not.toBe(first.body.operation.id)
  })

  test('and another token\'s identical key does not join it', async () => {
    if (!available)
      return

    /*
     * A key is chosen by the client, and two clients will eventually choose the
     * same one - a bad seed, or the literal `1`. Unscoped, one caller's retry
     * would join another caller's work, which is a disclosure rather than a
     * duplicate.
     */
    const key = 'the-same-key-both-chose'

    await enableMirror()
    const mine = await sync(created.first, key)
    await enableMirror()
    const theirs = await sync(created.second, key)

    expect(theirs.body?.operation?.id).not.toBe(mine.body.operation.id)
  })
})

describe('polling it', () => {
  test('is free once nothing has changed', async () => {
    if (!available)
      return

    // The design asks clients to poll. A pattern that told them to and then
    // made it expensive would be advice nobody could follow.
    const id = await makeOperation()
    const first = await status(id, created.first)
    const tag = first.headers.get('ETag')

    expect(tag).toBeTruthy()

    const again = await status(id, created.first, { 'If-None-Match': String(tag) })

    expect(again.status).toBe(304)
  })

  test('and says when to come back while it is unfinished', async () => {
    if (!available)
      return

    // So a client does not have to guess a cadence, and does not hammer.
    const id = await makeOperation({ status: 'running', started_at: new Date().toISOString() })
    const followed = await status(id, created.first)

    expect(Number(followed.headers.get('Retry-After'))).toBeGreaterThan(0)
  })

  test('somebody else\'s reads as missing rather than forbidden', async () => {
    if (!available)
      return

    // An operation id names work on a subject, and "you may not see that one"
    // confirms the subject exists.
    const id = await makeOperation()
    const peeked = await status(id, created.strangerToken)

    expect(peeked.status).toBe(404)
  })
})

describe('cancelling it', () => {
  test('needs the token that started it', async () => {
    if (!available)
      return

    /*
     * The same *authority*, not merely the same person. Two agents under one
     * account must not be able to stop each other, which is a distinction that
     * only started mattering when agents began holding tokens.
     */
    const id = await makeOperation({ status: 'running' })
    const refused = await cancel(id, created.second)

    expect(refused.status).toBe(403)
    expect(String(refused.body?.error?.message ?? '')).toContain('different token')
  })

  test('and the token that did start it may', async () => {
    if (!available)
      return

    const id = await makeOperation()
    const stopped = await cancel(id, created.first)

    expect(stopped.status).toBe(200)
    // Queued work stops immediately: nothing has picked it up, so there is no
    // checkpoint to wait for.
    expect(stopped.body?.operation?.status).toBe('cancelled')
  })

  test('cancelling twice is not an error', async () => {
    if (!available)
      return

    // A client retrying a cancel it already sent wants to hear that it worked.
    // A 409 here sends it looking for a problem that is not there.
    const id = await makeOperation()
    await cancel(id, created.first)
    const again = await cancel(id, created.first)

    expect(again.status).toBe(200)
    expect(again.body?.operation?.status).toBe('cancelled')
  })
})

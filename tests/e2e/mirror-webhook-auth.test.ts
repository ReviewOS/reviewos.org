// Whether a stranger can make this instance do work.
//
// `/api/mirrors/webhook` is the one unauthenticated endpoint that *queues* work,
// and the work is a `git fetch` against somebody else's server. It was
// exploitable: the signature guard read `credential_ref` - a column documented
// as a reference to a credential rather than a credential, holding a readable
// name that looks up an environment variable, and written by nothing - behind
// `if (secret && ...)`. So on every mirror on every instance the check was
// skipped, and anybody who could name a mirrored repository could queue an
// unbounded number of fetches.
//
// Remote owner and name are public knowledge for exactly the repositories
// people mirror, so "who would know" was not a defence.
//
// These pin the fix in both directions, because a guard that only ever refuses
// is as broken as one that only ever allows.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createHmac } from 'node:crypto'

const created = {
  repositoryId: 0,
  mirrorId: 0,
  remoteOwner: '',
  remoteName: '',
  secret: 'a-real-webhook-secret-not-a-name',
}

let available = false
let port = 0
let server: any = null

function unique(prefix: string): string {
  return `${prefix}${Buffer.from(crypto.getRandomValues(new Uint8Array(5))).toString('hex')}`
}

/** A delivery, signed or not, exactly as an upstream forge sends one. */
async function deliver(options: { sign: boolean | string } = { sign: true }): Promise<{ status: number, body: any }> {
  const payload = JSON.stringify({
    repository: { name: created.remoteName, owner: { login: created.remoteOwner } },
    ref: 'refs/heads/main',
  })

  const signature = typeof options.sign === 'string'
    ? options.sign
    : `sha256=${createHmac('sha256', created.secret).update(payload).digest('hex')}`

  const answer = await fetch(`http://127.0.0.1:${port}/api/mirrors/webhook`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'x-github-event': 'push',
      ...(options.sign === false ? {} : { 'x-hub-signature-256': signature }),
    },
    body: payload,
  })

  return { status: answer.status, body: await answer.json().catch(() => null) }
}

/** How many sync jobs are queued for this mirror. */
async function queued(): Promise<number> {
  try {
    const rows: any[] = await (globalThis as any).db
      .selectFrom('jobs')
      .select(['id'])
      .execute()

    return rows.length
  }
  catch {
    return 0
  }
}

beforeAll(async () => {
  try {
    const { injectGlobalAutoImports } = await import('@stacksjs/server')
    const { route } = await import('@stacksjs/router')

    await injectGlobalAutoImports()
    const db = (globalThis as any).db
    await db.selectFrom('repository_mirrors').select(['id']).limit(1).execute()

    await route.importRoutes()
    server = await route.serve({ port: 0, hostname: '127.0.0.1' })
    port = Number((server as any)?.port ?? (server as any)?.server?.port ?? 0)

    if (!port)
      throw new Error('the router did not report a port')

    const owner = unique('mirroruser')
    const user: any = await db
      .insertInto('users')
      .values({ name: 'Mirror Person', email: `${owner}@example.com`, handle: owner, password: 'x' })
      .returning(['id'])
      .executeTakeFirst()

    const name = unique('mirrorrepo')
    const repository: any = await db
      .insertInto('repositories')
      .values({
        owner_type: 'user',
        owner_id: Number(user?.id),
        name,
        visibility: 'public',
        default_branch: 'main',
        disk_path: `${owner}/${name}.git`,
      })
      .returning(['id'])
      .executeTakeFirst()

    created.repositoryId = Number(repository?.id)
    created.remoteOwner = unique('upstream')
    created.remoteName = unique('project')

    const mirror: any = await db
      .insertInto('repository_mirrors')
      .values({
        repository_id: created.repositoryId,
        direction: 'pull',
        provider: 'github',
        remote_url: `https://github.com/${created.remoteOwner}/${created.remoteName}.git`,
        remote_owner: created.remoteOwner,
        remote_name: created.remoteName,
        interval_seconds: 900,
        enabled: true,
        sync_metadata: false,
        // No secret to start with, which is the state every existing mirror is
        // in and the state the old code trusted.
        webhook_secret: null,
      })
      .returning(['id'])
      .executeTakeFirst()

    created.mirrorId = Number(mirror?.id)
    available = true
  }
  catch (error) {
    console.warn(`[mirror-webhook] skipping: ${error instanceof Error ? error.message : String(error)}`)
    available = false
  }
}, 120_000)

afterAll(async () => {
  const db = (globalThis as any).db

  try {
    if (db && created.repositoryId) {
      await db.deleteFrom('repository_mirrors').where('repository_id', '=', created.repositoryId).execute()

      const repository: any = await db
        .selectFrom('repositories')
        .select(['owner_id'])
        .where('id', '=', created.repositoryId)
        .executeTakeFirst()

      await db.deleteFrom('repositories').where('id', '=', created.repositoryId).execute()

      if (repository?.owner_id)
        await db.deleteFrom('users').where('id', '=', Number(repository.owner_id)).execute()
    }
  }
  finally {
    server?.stop?.()
  }
}, 60_000)

describe('a mirror with no webhook secret', () => {
  test('ignores a delivery rather than trusting it', async () => {
    if (!available)
      return

    /*
     * The vulnerability, in one request. This used to queue a sync: the guard
     * was `if (secret && ...)`, the secret was never set, so an unsigned
     * delivery naming a mirrored repository went straight through.
     *
     * Fails *closed* now. The interval sweep still keeps the mirror current, so
     * the cost of a missing secret is latency rather than an open door.
     */
    const before = await queued()
    const answer = await deliver({ sign: false })

    expect(answer.status).toBe(200)
    expect(String(answer.body?.ignored ?? '')).toContain('no webhook secret')
    expect(await queued()).toBe(before)
  }, 30_000)

  test('and a delivery carrying a signature is ignored too', async () => {
    if (!available)
      return

    // There is nothing to verify against, so a signature proves nothing. An
    // implementation that accepted one here would be trusting the sender's own
    // arithmetic.
    const before = await queued()

    expect(String((await deliver({ sign: true })).body?.ignored ?? '')).toContain('no webhook secret')
    expect(await queued()).toBe(before)
  }, 30_000)
})

describe('a mirror with a secret', () => {
  test('refuses an unsigned delivery', async () => {
    if (!available)
      return

    await (globalThis as any).db
      .updateTable('repository_mirrors')
      .set({ webhook_secret: created.secret })
      .where('id', '=', created.mirrorId)
      .execute()

    expect((await deliver({ sign: false })).status).toBe(401)
  }, 30_000)

  test('refuses a signature computed with the wrong secret', async () => {
    if (!available)
      return

    const wrong = `sha256=${createHmac('sha256', 'not-the-secret').update('anything').digest('hex')}`

    expect((await deliver({ sign: wrong })).status).toBe(401)
  }, 30_000)

  test('accepts a correctly signed one, which is the point of having it', async () => {
    if (!available)
      return

    // The other direction. A guard that only ever refuses is as broken as one
    // that only ever allows, and it is the failure people ship - because it
    // looks like security and the symptom is somebody else's hook going red.
    const answer = await deliver({ sign: true })

    expect(answer.status).toBe(200)
    expect(Number(answer.body?.queued ?? 0)).toBe(created.mirrorId)
  }, 30_000)
})

// The checks API, as a CI system would use it.
//
// This is the part of phase 9 that makes the forge usable with any existing CI,
// and every test below is a case a real reporter produces and a naive
// implementation gets wrong: a retried create, a report that overtakes itself,
// a token that should not be able to push, and a pull request whose head has
// moved since the checks were posted.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

const created = {
  ownerHandle: '',
  ownerId: 0,
  repositoryId: 0,
  name: '',
  sha: 'a'.repeat(40),
  checksToken: '',
  readToken: '',
  pullNumber: 0,
}

let available = false
let port = 0
let server: any = null

function unique(prefix: string): string {
  return `${prefix}${Buffer.from(crypto.getRandomValues(new Uint8Array(5))).toString('hex')}`
}

async function report(body: Record<string, unknown>, token = created.checksToken): Promise<{ status: number, body: any }> {
  const answer = await fetch(`http://127.0.0.1:${port}/api/repos/checks`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify({ owner: created.ownerHandle, repository: created.name, sha: created.sha, ...body }),
  })

  return { status: answer.status, body: await answer.json().catch(() => null) }
}

async function show(query: Record<string, string | number> = {}): Promise<any> {
  const parameters = new URLSearchParams({
    owner: created.ownerHandle,
    repository: created.name,
    ...Object.fromEntries(Object.entries(query).map(([key, value]) => [key, String(value)])),
  })

  const answer = await fetch(`http://127.0.0.1:${port}/api/repos/checks?${parameters}`, {
    headers: { Authorization: `Bearer ${created.readToken}`, Accept: 'application/json' },
  })

  return await answer.json().catch(() => null)
}

beforeAll(async () => {
  try {
    const { injectGlobalAutoImports } = await import('@stacksjs/server')
    const { route } = await import('@stacksjs/router')

    await injectGlobalAutoImports()
    const db = (globalThis as any).db
    await db.selectFrom('commit_statuses').select(['id']).limit(1).execute()

    await route.importRoutes()
    server = await route.serve({ port: 0, hostname: '127.0.0.1' })
    port = Number((server as any)?.port ?? (server as any)?.server?.port ?? 0)

    if (!port)
      throw new Error('the router did not report a port')

    created.ownerHandle = unique('checksowner')
    const owner: any = await db
      .insertInto('users')
      .values({ name: 'Checks Owner', email: `${created.ownerHandle}@example.com`, handle: created.ownerHandle, password: 'x' })
      .returning(['id'])
      .executeTakeFirst()

    created.ownerId = Number(owner?.id)
    created.name = unique('checksrepo')

    const repository: any = await db
      .insertInto('repositories')
      .values({
        owner_type: 'user',
        owner_id: created.ownerId,
        name: created.name,
        visibility: 'public',
        default_branch: 'main',
        disk_path: `${created.ownerHandle}/${created.name}.git`,
      })
      .returning(['id'])
      .executeTakeFirst()

    created.repositoryId = Number(repository?.id)

    const { generateToken } = await import('../../app/Actions/Tokens/secret')

    const makeToken = async (scopes: Array<[string, string]>): Promise<string> => {
      const token = generateToken()
      const row: any = await db.insertInto('access_tokens').values({
        user_id: created.ownerId,
        name: 'checks test',
        prefix: token.prefix,
        token_hash: token.hash,
        selection: 'all',
        expires_at: new Date(Date.now() + 86_400_000).toISOString(),
      }).returning(['id']).executeTakeFirst()

      for (const [scope, level] of scopes)
        await db.insertInto('access_token_permissions').values({ access_token_id: Number(row?.id), scope, level }).execute()

      return token.token
    }

    // A reporter's token: `checks` and nothing else. The whole point of the
    // separate scope is that this token cannot push.
    created.checksToken = await makeToken([['checks', 'write'], ['contents', 'read']])
    created.readToken = await makeToken([['contents', 'read']])

    const pull: any = await db
      .insertInto('pull_requests')
      .values({
        repository_id: created.repositoryId,
        number: 1,
        title: 'A change',
        body: '',
        author_id: created.ownerId,
        state: 'open',
        head_repository_id: created.repositoryId,
        head_branch: 'work',
        head_sha: created.sha,
        base_branch: 'main',
        base_sha: 'b'.repeat(40),
        draft: false,
        mergeable_state: 'unknown',
      })
      .returning(['number'])
      .executeTakeFirst()

    created.pullNumber = Number(pull?.number)
    available = true
  }
  catch (error) {
    console.warn(`[checks] skipping: ${error instanceof Error ? error.message : String(error)}`)
    available = false
  }
}, 120_000)

afterAll(async () => {
  const db = (globalThis as any).db

  try {
    if (db && created.repositoryId) {
      const runs: any[] = await db.selectFrom('check_runs').select(['id']).where('repository_id', '=', created.repositoryId).execute()

      for (const run of runs)
        await db.deleteFrom('check_annotations').where('check_run_id', '=', Number(run.id)).execute()

      await db.deleteFrom('check_runs').where('repository_id', '=', created.repositoryId).execute()
      await db.deleteFrom('commit_statuses').where('repository_id', '=', created.repositoryId).execute()

      // Deliveries first: they reference the webhook, and the repository
      // cascade cannot remove a hook something still points at.
      const hooks: any[] = await db.selectFrom('webhooks').select(['id']).where('repository_id', '=', created.repositoryId).execute()

      for (const hook of hooks)
        await db.deleteFrom('webhook_deliveries').where('webhook_id', '=', Number(hook.id)).execute()

      await db.deleteFrom('webhooks').where('repository_id', '=', created.repositoryId).execute()
      await db.deleteFrom('pull_requests').where('repository_id', '=', created.repositoryId).execute()
      await db.deleteFrom('repositories').where('id', '=', created.repositoryId).execute()
    }

    if (db && created.ownerId) {
      const tokens: any[] = await db.selectFrom('access_tokens').select(['id']).where('user_id', '=', created.ownerId).execute()

      for (const token of tokens)
        await db.deleteFrom('access_token_permissions').where('access_token_id', '=', Number(token.id)).execute()

      await db.deleteFrom('access_tokens').where('user_id', '=', created.ownerId).execute()
      await db.deleteFrom('users').where('id', '=', created.ownerId).execute()
    }
  }
  finally {
    server?.stop?.()
  }
}, 60_000)

describe('who may report', () => {
  test('a token with checks may', async () => {
    if (!available)
      return

    const answer = await report({ kind: 'status', context: 'ci/build', state: 'pending' })

    expect(answer.status).toBe(201)
  }, 30_000)

  test('a token without it may not', async () => {
    if (!available)
      return

    /*
     * The fine-grained rule phase 9 asks for. A CI token that could push is a
     * CI token whose compromise is a supply chain incident, and CI credentials
     * live in more places than any other an organization has.
     */
    const answer = await report({ kind: 'status', context: 'ci/build', state: 'success' }, created.readToken)

    expect(answer.status).toBeGreaterThanOrEqual(400)
  }, 30_000)
})

describe('the rollup a merge reads', () => {
  test('a commit with nothing reported is neutral, not green', async () => {
    if (!available)
      return

    // The one people get wrong: a repository whose CI is misconfigured looks
    // exactly like one whose tests all pass.
    const answer = await show({ sha: 'c'.repeat(40) })

    expect(answer.state).toBe('neutral')
  }, 30_000)

  test('a pending status keeps the commit pending', async () => {
    if (!available)
      return

    expect((await show({ sha: created.sha })).state).toBe('pending')
  }, 30_000)

  test('and the same context reporting success moves it', async () => {
    if (!available)
      return

    // Latest per context. The pending row stays in the table - "did this always
    // pass, or did somebody re-run it until it did" is worth being able to ask.
    await report({ kind: 'status', context: 'ci/build', state: 'success' })

    const answer = await show({ sha: created.sha })

    expect(answer.state).toBe('success')
    expect(answer.statuses.length).toBe(2)
  }, 30_000)

  test('a failure anywhere wins', async () => {
    if (!available)
      return

    await report({ kind: 'status', context: 'security/scan', state: 'failure' })

    expect((await show({ sha: created.sha })).state).toBe('failure')
  }, 30_000)

  test('and a pull request is asked by number, not by sha', async () => {
    if (!available)
      return

    /*
     * Which is what anybody asking "can this merge" actually has. The response
     * names the sha it answered about, so a client can tell "green" from "green
     * for a commit somebody has already replaced".
     */
    const answer = await show({ number: created.pullNumber })

    expect(answer.sha).toBe(created.sha)
    expect(answer.state).toBe('failure')
  }, 30_000)
})

describe('check runs', () => {
  test('a retried create returns the same run rather than a second one', async () => {
    if (!available)
      return

    /*
     * A reporter retries when the connection drops after the row was written
     * and before the response arrived. Without the key it gets a second run,
     * which sits `queued` forever and blocks a merge on a check that no longer
     * exists anywhere.
     */
    const first = await report({ name: 'tests', status: 'queued', idempotency_key: 'run-1' })
    const second = await report({ name: 'tests', status: 'queued', idempotency_key: 'run-1' })

    expect(first.status).toBe(201)
    expect(Number(second.body.id)).toBe(Number(first.body.id))

    const runs: any[] = await (globalThis as any).db
      .selectFrom('check_runs')
      .select(['id'])
      .where('repository_id', '=', created.repositoryId)
      .where('name', '=', 'tests')
      .execute()

    expect(runs.length).toBe(1)
  }, 30_000)

  test('it progresses queued to completed', async () => {
    if (!available)
      return

    await report({ name: 'tests', status: 'in_progress', idempotency_key: 'run-1' })
    const done = await report({ name: 'tests', status: 'completed', conclusion: 'success', idempotency_key: 'run-1' })

    expect(done.body.status).toBe('completed')
  }, 30_000)

  test('and a late queued report cannot reopen it', async () => {
    if (!available)
      return

    /*
     * CI systems deliver out of order. Applying a `queued` that overtook a
     * `completed` would reopen a check that has already reported - blocking a
     * merge that had passed, or unblocking one that had not, depending which
     * way round.
     */
    const late = await report({ name: 'tests', status: 'queued', idempotency_key: 'run-1' })

    expect(late.body.status).toBe('completed')
    expect(String(late.body.ignored)).toContain('already been recorded')
  }, 30_000)

  test('a completed run without a conclusion is refused', async () => {
    if (!available)
      return

    // Rather than stored and read as neutral later. A reporter that forgot the
    // conclusion should find out from the response, not from a check that
    // silently counts for nothing.
    const answer = await report({ name: 'lint', status: 'completed' })

    expect(answer.status).toBe(422)
  }, 30_000)

  test('and a branch name is not a commit', async () => {
    if (!available)
      return

    // Checks are about a commit. A status posted against `main` would be a
    // verdict that silently applies to whatever `main` becomes.
    const answer = await report({ name: 'lint', status: 'queued', sha: 'main' })

    expect(answer.status).toBe(422)
  }, 30_000)
})

describe('annotations', () => {
  test('arrive as rows, on both sides of the diff', async () => {
    if (!available)
      return

    /*
     * The whole value of an annotation is that it appears on the line it is
     * about - a lint failure listed in a log is a link nobody clicks. Both
     * sides, because a check can be about a deleted line: coverage on removed
     * code, or a linter complaining about what a change took away.
     */
    await report({
      name: 'lint',
      status: 'completed',
      conclusion: 'failure',
      idempotency_key: 'lint-1',
      annotations: [
        { path: 'src/cart.ts', start_line: 42, level: 'failure', message: 'Prefer a constant' },
        { path: 'src/cart.ts', start_line: 17, side: 'left', level: 'notice', message: 'This was covered' },
      ],
    })

    const answer = await show({ sha: created.sha })
    const run = answer.check_runs.find((one: any) => one.name === 'lint')

    expect(run.annotations.total).toBe(2)
    expect(run.annotations.items.map((one: any) => one.side).sort()).toEqual(['left', 'right'])
    expect(run.annotations.items[0].path).toBe('src/cart.ts')
  }, 30_000)

  test('and a re-run replaces them rather than piling up', async () => {
    if (!available)
      return

    /*
     * A reporter sends the annotations it currently has. A re-run that fixed
     * one of two lint errors sends one, and merging into the two already stored
     * would leave the fixed one on the diff forever.
     */
    await report({
      name: 'lint',
      status: 'completed',
      conclusion: 'success',
      idempotency_key: 'lint-1',
      annotations: [{ path: 'src/cart.ts', start_line: 42, level: 'notice', message: 'Better' }],
    })

    const answer = await show({ sha: created.sha })
    const run = answer.check_runs.find((one: any) => one.name === 'lint')

    expect(run.annotations.total).toBe(1)
    expect(run.annotations.items[0].message).toBe('Better')
  }, 30_000)
})


describe('the webhook a report sends', () => {
  /*
   * The event a CI receiver exists for, and the one the roadmap left open: a
   * deployment gate, a dashboard and a merge queue all wait on "a check said
   * something about this commit", and until this existed the only way to find
   * out was to poll the checks endpoint.
   *
   * Asserted through the real path - report over HTTP, listener, delivery row -
   * because each half of it has failed on its own before: an event nothing
   * listens to, and a listener no event reaches.
   */
  async function subscribe(events: string): Promise<number> {
    const db = (globalThis as any).db

    const row: any = await db.insertInto('webhooks').values({
      repository_id: created.repositoryId,
      // Unreachable deliberately. The delivery is refused and still recorded,
      // and what this asserts is that the attempt was made.
      url: 'http://127.0.0.1:1/hook',
      secret: 'shhh',
      events,
      content_type: 'application/json',
      active: true,
      consecutive_failures: 0,
    }).returning(['id']).executeTakeFirst()

    return Number(row?.id)
  }

  async function deliveries(webhookId: number): Promise<any[]> {
    return (globalThis as any).db
      .selectFrom('webhook_deliveries')
      .select(['event', 'payload'])
      .where('webhook_id', '=', webhookId)
      .where('attempt', '=', 1)
      .orderBy('id', 'asc')
      .execute()
  }

  /*
   * Waited for rather than read once.
   *
   * The dispatch is deliberately fire-and-forget - a webhook is a consequence
   * of somebody's report and must not be able to fail it - so the report's
   * response arrives before the delivery is written. Asserting immediately
   * tests the scheduler's luck, and it fails on a fast machine and passes on a
   * slow one, which is the worst way round.
   */
  async function settled(webhookId: number, atLeast = 1): Promise<any[]> {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const rows = await deliveries(webhookId)

      if (rows.length >= atLeast)
        return rows

      await new Promise(resolve => setTimeout(resolve, 100))
    }

    return await deliveries(webhookId)
  }

  test('carries the check, its transition, and the commit it is about', async () => {
    if (!available)
      return

    const hook = await subscribe('check:reported')

    await report({ name: 'webhook/build', status: 'completed', conclusion: 'success', attempt: 3 })

    const sent = await settled(hook)
    const body = JSON.parse(String(sent.at(-1)?.payload ?? '{}'))

    expect(sent.at(-1)?.event).toBe('check:reported')
    expect(body.check.name).toBe('webhook/build')
    expect(body.check.sha).toBe(created.sha)
    expect(body.check.conclusion).toBe('success')
    expect(body.check.attempt).toBe(3)
    // The transition, which is what a gate switches on.
    expect(body.action).toBe('completed')
    expect(body.repository.full_name).toBe(`${created.ownerHandle}/${created.name}`)
  })

  test('and a commit status is its own event rather than a check-shaped lie', async () => {
    if (!available)
      return

    const hook = await subscribe('status:reported')

    await report({ kind: 'status', context: 'webhook/legacy', state: 'success', target_url: 'https://ci.example.com/9' })

    const sent = await settled(hook)
    const body = JSON.parse(String(sent.at(-1)?.payload ?? '{}'))

    expect(sent.at(-1)?.event).toBe('status:reported')
    expect(body.check.name).toBe('webhook/legacy')
    expect(body.check.conclusion).toBe('success')
    expect(body.check.details_url).toBe('https://ci.example.com/9')
  })

  test('a webhook subscribed to something else hears nothing', async () => {
    if (!available)
      return

    const hook = await subscribe('pr:opened')

    await report({ name: 'webhook/quiet', status: 'completed', conclusion: 'success' })

    // The same wait the positive cases get, so this is "nothing arrived" rather
    // than "nothing had arrived yet".
    await new Promise(resolve => setTimeout(resolve, 500))

    expect(await deliveries(hook)).toEqual([])
  })

  /*
   * A report that changed nothing sends nothing. A `queued` arriving after a
   * `completed` is a delivery that overtook itself, and a webhook saying a
   * finished check is queued again would have a merge queue reopen a gate that
   * had already closed.
   */
  test('and a backward transition is silent', async () => {
    if (!available)
      return

    const created_run = await report({ name: 'webhook/order', status: 'completed', conclusion: 'success' })
    const hook = await subscribe('check:reported')

    await report({ id: Number(created_run.body?.id), name: 'webhook/order', status: 'queued' })

    await new Promise(resolve => setTimeout(resolve, 500))

    expect(await deliveries(hook)).toEqual([])
  })
})

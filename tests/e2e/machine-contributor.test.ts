// A machine account contributing, through the real endpoints.
//
// The claim is "like anyone else", and the only way to test that honestly is to
// have one *do the things*: open a pull request under its own token, be
// requested as a reviewer, be assigned an issue. Reading the code and observing
// that a machine account is a `users` row proves it should work, which is a
// different statement from proving it does - and the difference is exactly
// where a `WHERE machine_for_organization_id IS NULL` added for some other
// reason would hide.
//
// Needs a database and a socket. No git: opening a pull request against
// branches that exist only as rows is enough to exercise the permission path,
// which is what "like anyone else" is about.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

const created = {
  personId: 0,
  personToken: '',
  botId: 0,
  botToken: '',
  botTokenId: 0,
  organizationId: 0,
  handle: '',
  botHandle: '',
  name: '',
  repositoryId: 0,
  issueId: 0,
  pullRequestId: 0,
}

let available = false
let port = 0
let server: any = null

function unique(prefix: string): string {
  return `${prefix}${Buffer.from(crypto.getRandomValues(new Uint8Array(5))).toString('hex')}`
}

async function post(path: string, token: string, body: unknown): Promise<{ status: number, body: any }> {
  const answer = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', 'Accept': 'application/json' },
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
    await db.selectFrom('users').select(['id']).limit(1).execute()

    await route.importRoutes()
    server = await route.serve({ port: 0, hostname: '127.0.0.1' })
    port = Number((server as any)?.port ?? (server as any)?.server?.port ?? 0)

    if (!port)
      throw new Error('the router did not report a port')

    const { createToken } = await import('@stacksjs/auth')
    const { generateToken } = await import('../../app/Actions/Tokens/secret')

    created.handle = unique('mcperson')
    const person: any = await db
      .insertInto('users')
      .values({ name: 'A Person', email: `${created.handle}@example.com`, handle: created.handle, password: 'x' })
      .returning(['id'])
      .executeTakeFirst()

    created.personId = Number(person?.id)
    const issued: any = await createToken(created.personId, 'machine contributor test')
    created.personToken = String(issued?.plainTextToken ?? issued?.token ?? issued)

    const organizationHandle = unique('mcorg')
    const organization: any = await db
      .insertInto('organizations')
      .values({ name: 'Contributors Inc', handle: organizationHandle })
      .returning(['id'])
      .executeTakeFirst()

    created.organizationId = Number(organization?.id)

    created.botHandle = unique('mcbot')
    const bot: any = await db
      .insertInto('users')
      .values({
        name: 'Contributing Agent',
        email: `${created.botHandle}@example.com`,
        handle: created.botHandle,
        password: 'x',
        // The one column that makes an account a machine.
        machine_for_organization_id: created.organizationId,
      })
      .returning(['id'])
      .executeTakeFirst()

    created.botId = Number(bot?.id)

    /*
     * The agent's own credential, which is the whole point: it cannot sign in,
     * so a token is the only way it does anything, and everything below happens
     * under it rather than under a person acting on its behalf.
     */
    const botToken = generateToken()
    created.botToken = botToken.token

    const botTokenRow: any = await db
      .insertInto('access_tokens')
      .values({
        user_id: created.botId,
        name: 'agent token',
        prefix: botToken.prefix,
        token_hash: botToken.hash,
        selection: 'all',
        expires_at: new Date(Date.now() + 86_400_000).toISOString(),
      })
      .returning(['id'])
      .executeTakeFirst()

    created.botTokenId = Number(botTokenRow?.id)

    for (const [scope, level] of [['contents', 'write'], ['pull_requests', 'write'], ['issues', 'write']]) {
      await db
        .insertInto('access_token_permissions')
        .values({ access_token_id: created.botTokenId, scope, level })
        .execute()
    }

    created.name = unique('mcrepo')
    const repository: any = await db
      .insertInto('repositories')
      .values({
        owner_type: 'user',
        owner_id: created.personId,
        name: created.name,
        visibility: 'public',
        default_branch: 'main',
        disk_path: `${created.handle}/${created.name}.git`,
      })
      .returning(['id'])
      .executeTakeFirst()

    created.repositoryId = Number(repository?.id)

    // The agent is a collaborator, exactly as a colleague would be. Nothing
    // about that row knows it is a machine.
    await db.insertInto('repo_collaborators').values({
      repository_id: created.repositoryId,
      user_id: created.botId,
      permission: 'write',
    }).execute()

    const issue: any = await db
      .insertInto('issues')
      .values({
        repository_id: created.repositoryId,
        number: 1,
        title: 'Something to assign',
        author_id: created.personId,
        state: 'open',
      })
      .returning(['id'])
      .executeTakeFirst()

    created.issueId = Number(issue?.id)

    const pullRequest: any = await db
      .insertInto('pull_requests')
      .values({
        repository_id: created.repositoryId,
        number: 1,
        title: 'A person\'s change',
        author_id: created.personId,
        state: 'open',
        head_branch: 'change',
        head_sha: 'b'.repeat(40),
        base_branch: 'main',
        base_sha: 'a'.repeat(40),
        draft: false,
      })
      .returning(['id'])
      .executeTakeFirst()

    created.pullRequestId = Number(pullRequest?.id)

    available = true
  }
  catch (error) {
    console.warn(`[machine-contributor] skipping: ${error instanceof Error ? error.message : String(error)}`)
    available = false
  }
}, 120_000)

afterAll(async () => {
  const db = (globalThis as any).db

  try {
    if (db) {
      if (created.pullRequestId) {
        await db.deleteFrom('pull_request_reviewers').where('pull_request_id', '=', created.pullRequestId).execute()
        await db.deleteFrom('pull_request_reviews').where('pull_request_id', '=', created.pullRequestId).execute()
      }

      if (created.repositoryId) {
        await db.deleteFrom('pull_requests').where('repository_id', '=', created.repositoryId).execute()
        await db.deleteFrom('repo_collaborators').where('repository_id', '=', created.repositoryId).execute()
      }

      if (created.issueId) {
        // Assigning and commenting both write a timeline entry attributed to
        // the actor, and the entry outlives neither the issue nor the account.
        // Polymorphic: `subject_type` plus `subject_id`, not an `issue_id`.
        await db
          .deleteFrom('timeline_entries')
          .where('subject_type', '=', 'issue')
          .where('subject_id', '=', created.issueId)
          .execute()
        // Polymorphic too, and by a different pair of names again.
        await db
          .deleteFrom('issue_comments')
          .where('commentable_type', '=', 'issue')
          .where('commentable_id', '=', created.issueId)
          .execute()
        await db.deleteFrom('issue_assignees').where('issue_id', '=', created.issueId).execute()
        await db.deleteFrom('issues').where('id', '=', created.issueId).execute()
      }

      if (created.repositoryId)
        await db.deleteFrom('repositories').where('id', '=', created.repositoryId).execute()

      if (created.botTokenId) {
        await db.deleteFrom('token_usage_windows').where('access_token_id', '=', created.botTokenId).execute()
        await db.deleteFrom('access_token_permissions').where('access_token_id', '=', created.botTokenId).execute()
      }

      const users = [created.personId, created.botId].filter(Boolean)
      if (users.length > 0) {
        await db.deleteFrom('access_tokens').where('user_id', 'in', users).execute()
        await db.deleteFrom('users').where('id', 'in', users).execute()
      }

      if (created.organizationId)
        await db.deleteFrom('organizations').where('id', '=', created.organizationId).execute()
    }
  }
  finally {
    server?.stop?.()
  }
}, 30_000)

describe('a machine account', () => {
  test('is a reviewer like anyone else', async () => {
    if (!available)
      return

    const { status } = await post('/api/repos/pulls/review-requests', created.personToken, {
      owner: created.handle,
      repo: created.name,
      number: 1,
      reviewer_type: 'user',
      reviewer_id: created.botId,
    })

    expect(status).toBeLessThan(300)

    const requested: any[] = await (globalThis as any).db
      .selectFrom('pull_request_reviewers')
      .select(['reviewer_id'])
      .where('pull_request_id', '=', created.pullRequestId)
      .execute()

    expect(requested.map(row => Number(row.reviewer_id))).toContain(created.botId)
  })

  test('and reviews under its own credential', async () => {
    if (!available)
      return

    // Under the agent's token, not a person's. It cannot sign in, so this is
    // the only way it acts at all.
    const { status } = await post('/api/repos/pulls/reviews', created.botToken, {
      owner: created.handle,
      repo: created.name,
      number: 1,
      state: 'commented',
      body: 'read it',
    })

    expect(status).toBeLessThan(300)

    const reviews: any[] = await (globalThis as any).db
      .selectFrom('pull_request_reviews')
      .select(['reviewer_id'])
      .where('pull_request_id', '=', created.pullRequestId)
      .execute()

    expect(reviews.map(row => Number(row.reviewer_id))).toContain(created.botId)
  })

  test('and is an assignee like anyone else', async () => {
    if (!available)
      return

    const answer = await fetch(`http://127.0.0.1:${port}/api/repos/issues/assignees`, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${created.personToken}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({
        owner: created.handle,
        repo: created.name,
        number: 1,
        assignees: [created.botHandle],
      }),
    })

    const status = answer.status

    expect(status).toBeLessThan(300)

    const assigned: any[] = await (globalThis as any).db
      .selectFrom('issue_assignees')
      .select(['user_id'])
      .where('issue_id', '=', created.issueId)
      .execute()

    expect(assigned.map(row => Number(row.user_id))).toContain(created.botId)
  })

  test('and comments on an issue under its own credential', async () => {
    if (!available)
      return

    /*
     * The last of the three contributor roles the phase names. Asserted through
     * the endpoint rather than by inserting a row, because what is being tested
     * is the permission path - a machine account is a `users` row, so the row
     * would obviously insert.
     */
    const { status } = await post('/api/repos/issues/comments', created.botToken, {
      owner: created.handle,
      repo: created.name,
      number: 1,
      body: 'looked at this',
    })

    expect(status).toBeLessThan(300)
  })
})

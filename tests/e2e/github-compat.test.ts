// The GitHub-shaped surface, posted to the way an action does.
//
// The ecosystem's actions do not read this instance's reference. They build
// `${GITHUB_API_URL}/repos/{owner}/{repo}/check-runs`, send what Octokit sends,
// and read back an `id`. So the requests below are written as Octokit writes
// them - `head_sha`, `output.summary`, `state: 'error'` - rather than as this
// instance's own endpoints would like them.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

const created = { ownerId: 0, repositoryId: 0, handle: '', name: '', token: '', issueNumber: 0 }

let available = false
let db: any = null
let server: any = null
let port = 0

function unique(prefix: string): string {
  return `${prefix}${Buffer.from(crypto.getRandomValues(new Uint8Array(5))).toString('hex')}`
}

/** A call the way an action makes it: a GitHub path, a bearer, a JSON body. */
async function gh(path: string, body: Record<string, unknown>): Promise<{ status: number, body: any }> {
  const answer = await fetch(`http://127.0.0.1:${port}/api/gh/repos/${created.handle}/${created.name}${path}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${created.token}`,
      'Content-Type': 'application/json',
      'Accept': 'application/vnd.github+json',
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
    db = (globalThis as any).db
    await db.selectFrom('users').select(['id']).limit(1).execute()

    await route.importRoutes()
    server = await route.serve({ port: 0, hostname: '127.0.0.1' })
    port = Number((server as any)?.port ?? 0)

    created.handle = unique('gh')

    const owner: any = await db
      .insertInto('users')
      .values({ name: 'Compat Owner', email: `${created.handle}@example.com`, handle: created.handle, password: 'x' })
      .returning(['id'])
      .executeTakeFirst()

    created.ownerId = Number(owner?.id)
    created.name = unique('repo')

    const repository: any = await db
      .insertInto('repositories')
      .values({
        owner_type: 'user',
        owner_id: created.ownerId,
        name: created.name,
        visibility: 'public',
        default_branch: 'main',
        disk_path: `${created.handle}/${created.name}.git`,
      })
      .returning(['id'])
      .executeTakeFirst()

    created.repositoryId = Number(repository?.id)

    const issue: any = await db
      .insertInto('issues')
      .values({
        repository_id: created.repositoryId,
        number: 1,
        title: 'Something to comment on',
        body: '',
        author_id: created.ownerId,
        state: 'open',
      } as any)
      .returning(['number'])
      .executeTakeFirst()

    created.issueNumber = Number(issue?.number ?? 1)

    const { generateToken } = await import('../../app/Actions/Tokens/secret')
    const secret = generateToken()

    const tokenRow: any = await db.insertInto('access_tokens').values({
      user_id: created.ownerId,
      name: 'compat test',
      prefix: secret.prefix,
      token_hash: secret.hash,
      selection: 'all',
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    }).returning(['id']).executeTakeFirst()

    for (const [scope, level] of [['checks', 'write'], ['issues', 'write'], ['contents', 'read']] as Array<[string, string]>)
      await db.insertInto('access_token_permissions').values({ access_token_id: Number(tokenRow?.id), scope, level }).execute()

    created.token = secret.token
    available = true
  }
  catch (error) {
    console.warn(`[github-compat] skipping: ${error instanceof Error ? error.message : String(error)}`)
    available = false
  }
}, 120_000)

afterAll(async () => {
  try {
    server?.stop?.()
    if (created.repositoryId)
      await db.deleteFrom('repositories').where('id', '=', created.repositoryId).execute()
    if (created.ownerId)
      await db.deleteFrom('users').where('id', '=', created.ownerId).execute()
  }
  catch { /* the next run uses fresh names */ }
})

describe('check runs', () => {
  test('a check run posted the way Octokit posts one is recorded', async () => {
    if (!available)
      return

    const sha = 'a1'.repeat(20)

    const { status, body } = await gh('/check-runs', {
      name: 'ci/build',
      head_sha: sha,
      status: 'completed',
      conclusion: 'success',
      output: { title: 'Built', summary: 'Everything compiled.' },
    })

    expect(status).toBe(201)
    expect(Number(body.id)).toBeGreaterThan(0)

    // And it is a real check on the commit, not an acknowledgement.
    const row: any = await db
      .selectFrom('check_runs')
      .select(['name', 'conclusion', 'head_sha'])
      .where('repository_id', '=', created.repositoryId)
      .where('head_sha', '=', sha)
      .executeTakeFirst()

    expect(String(row.name)).toBe('ci/build')
    expect(String(row.conclusion)).toBe('success')
  }, 120_000)

  test('and a request missing head_sha is refused the way GitHub refuses it', async () => {
    if (!available)
      return

    /*
     * The message shape matters more than it looks: an action that logs the
     * body verbatim - most of them do - should print something its author
     * recognises rather than a sentence about this instance's field names.
     */
    const { status, body } = await gh('/check-runs', { name: 'ci/build' })

    expect(status).toBe(422)
    expect(String(body.message)).toContain('head_sha')
  }, 120_000)
})

describe('commit statuses', () => {
  test('the older API works too, and `error` becomes a failure', async () => {
    if (!available)
      return

    const sha = 'b2'.repeat(20)

    const { status, body } = await gh(`/statuses/${sha}`, {
      state: 'error',
      context: 'legacy/lint',
      description: 'the linter fell over',
      target_url: 'https://example.com/build/1',
    })

    expect(status).toBe(201)
    expect(body.state).toBe('error')

    /*
     * GitHub's vocabulary has four states and this instance has three: `error`
     * and `failure` both mean the commit did not pass, and inventing a third
     * state to preserve a distinction nothing acts on would be compatibility
     * as decoration.
     */
    const row: any = await db
      .selectFrom('commit_statuses')
      .select(['state', 'context'])
      .where('repository_id', '=', created.repositoryId)
      .where('sha', '=', sha)
      .executeTakeFirst()

    expect(String(row.state)).toBe('failure')
    expect(String(row.context)).toBe('legacy/lint')
  }, 120_000)
})

describe('comments', () => {
  test('an issue comment lands, at the path an action builds', async () => {
    if (!available)
      return

    const { status, body } = await gh(`/issues/${created.issueNumber}/comments`, {
      body: 'Posted by an action that thinks this is GitHub.',
    })

    expect(status).toBe(201)
    expect(Number(body.id)).toBeGreaterThan(0)

    /*
     * Comments are polymorphic here - `commentable_type` and `commentable_id`
     * rather than one column per subject - which is what makes `#12` resolve
     * to an issue or a pull request through the same endpoint.
     */
    const comments: any[] = await db
      .selectFrom('issue_comments')
      .innerJoin('issues', 'issues.id', '=', 'issue_comments.commentable_id')
      .select(['issue_comments.body as body'])
      .where('issue_comments.commentable_type', '=', 'issue')
      .where('issues.repository_id', '=', created.repositoryId)
      .execute()

    expect(comments.map(one => String(one.body))).toContain('Posted by an action that thinks this is GitHub.')
  }, 120_000)
})

describe('everything else', () => {
  test('is a 404 that names what exists', async () => {
    if (!available)
      return

    /*
     * The reason this is not a bare 404. An action told "Not Found" by an API
     * it believes in retries, blames the token, and eventually blames the
     * forge; one told which three endpoints exist has been told what to do.
     */
    const { status, body } = await gh('/deployments', { ref: 'main' })

    expect(status).toBe(404)
    expect(String(body.message)).toContain('check-runs')
    expect(String(body.message)).toContain('statuses')
    expect(String(body.message)).toContain('deployments')
  }, 120_000)

  test('and a call with no credential is refused before anything else', async () => {
    if (!available)
      return

    const answer = await fetch(`http://127.0.0.1:${port}/api/gh/repos/${created.handle}/${created.name}/check-runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'x', head_sha: 'c3'.repeat(20) }),
    })

    // No ambient credential is accepted here, which is what makes skipping
    // CSRF on these paths safe.
    expect(answer.status).toBe(401)
  }, 120_000)
})

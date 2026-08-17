// Secrets against the real tables: encrypted at rest, delivered to one job,
// and never readable by a person.
//
// The unit tests hold the selection rule. These hold the three things only the
// database and the endpoint can be wrong about: that nothing is stored in the
// clear, that a listing cannot be talked into returning a value, and that a
// job's delivery honours the fork flag and the environment gate.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { putSecret, secretNames, secretsForJob } from '../../app/Actions/Workflow/secrets'

const created = { ownerId: 0, repositoryId: 0, environmentId: 0, handle: '', name: '', token: '' }

let available = false
let db: any = null
let server: any = null
let port = 0

const VALUE = 'sk-live-not-a-real-credential-9f2a'

function unique(prefix: string): string {
  return `${prefix}${Buffer.from(crypto.getRandomValues(new Uint8Array(5))).toString('hex')}`
}

async function api(body: Record<string, unknown>): Promise<{ status: number, body: any }> {
  const answer = await fetch(`http://127.0.0.1:${port}/api/repos/secrets`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${created.token}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify({ owner: created.handle, repo: created.name, ...body }),
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

    created.handle = unique('sec')

    const owner: any = await db
      .insertInto('users')
      .values({ name: 'Secret Owner', email: `${created.handle}@example.com`, handle: created.handle, password: 'x' })
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

    const environment: any = await db
      .insertInto('environments')
      .values({ repository_id: created.repositoryId, name: 'production', wait_minutes: 0, branches: '' } as any)
      .returning(['id'])
      .executeTakeFirst()

    created.environmentId = Number(environment?.id)

    const { generateToken } = await import('../../app/Actions/Tokens/secret')
    const secret = generateToken()

    const tokenRow: any = await db.insertInto('access_tokens').values({
      user_id: created.ownerId,
      name: 'secrets test',
      prefix: secret.prefix,
      token_hash: secret.hash,
      selection: 'all',
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    }).returning(['id']).executeTakeFirst()

    for (const [scope, level] of [['administration', 'write'], ['contents', 'read']] as Array<[string, string]>)
      await db.insertInto('access_token_permissions').values({ access_token_id: Number(tokenRow?.id), scope, level }).execute()

    created.token = secret.token
    available = true
  }
  catch (error) {
    console.warn(`[secrets] skipping: ${error instanceof Error ? error.message : String(error)}`)
    available = false
  }
}, 120_000)

afterAll(async () => {
  try {
    server?.stop?.()
    await db.deleteFrom('workflow_secrets').where('scope_type', '=', 'repository').where('scope_id', '=', created.repositoryId).execute()
    await db.deleteFrom('workflow_secrets').where('scope_type', '=', 'environment').where('scope_id', '=', created.environmentId).execute()
    if (created.repositoryId)
      await db.deleteFrom('repositories').where('id', '=', created.repositoryId).execute()
    if (created.ownerId)
      await db.deleteFrom('users').where('id', '=', created.ownerId).execute()
  }
  catch { /* the next run uses fresh names */ }
})

describe('at rest', () => {
  test('the value is not in the row, and comes back only through the job path', async () => {
    if (!available)
      return

    await putSecret({ scope: 'repository', scopeId: created.repositoryId, key: 'DEPLOY_TOKEN', value: VALUE })

    const row: any = await db
      .selectFrom('workflow_secrets')
      .select(['sealed'])
      .where('scope_type', '=', 'repository')
      .where('scope_id', '=', created.repositoryId)
      .where('key', '=', 'DEPLOY_TOKEN')
      .executeTakeFirst()

    // The assertion worth having: a database dump, a backup, or a support
    // session with the table open does not hand anybody the credential.
    expect(String(row.sealed)).not.toContain(VALUE)
    expect(String(row.sealed).length).toBeGreaterThan(10)

    const delivered = await secretsForJob({
      repositoryId: created.repositoryId,
      trusted: true,
      environment: null,
      approved: false,
    })

    expect(delivered.DEPLOY_TOKEN).toBe(VALUE)
  }, 120_000)
})

describe('the endpoint', () => {
  test('lists names and never a value', async () => {
    if (!available)
      return

    const { status, body } = await api({ operation: 'list' })

    expect(status).toBe(200)
    expect(body.secrets.map((one: any) => one.key)).toContain('DEPLOY_TOKEN')

    // The whole response, not just the fields anybody thought to check.
    expect(JSON.stringify(body)).not.toContain(VALUE)
    expect(String(body.note)).toContain('never returned')
  }, 120_000)

  test('sets one, and says so without echoing it', async () => {
    if (!available)
      return

    const { status, body } = await api({ operation: 'set', scope: 'repository', key: 'NPM_TOKEN', value: 'npm-abc-123' })

    expect(status).toBe(200)
    expect(JSON.stringify(body)).not.toContain('npm-abc-123')
    expect(String(body.note)).toContain('cannot be read back')
  }, 120_000)

  test('and refuses a secret for an environment that does not exist', async () => {
    if (!available)
      return

    /*
     * Stored against nothing, it would sit in a listing looking configured and
     * never be delivered - which is the worst of both: the appearance of a
     * credential and the behaviour of a missing one.
     */
    const { status } = await api({ operation: 'set', scope: 'environment', environment: 'nowhere', key: 'X', value: 'y' })

    expect(status).toBe(404)
  }, 120_000)
})

describe('delivery to a job', () => {
  test('a fork gets nothing, however much is set', async () => {
    if (!available)
      return

    const delivered = await secretsForJob({
      repositoryId: created.repositoryId,
      trusted: false,
      environment: 'production',
      approved: true,
    })

    expect(delivered).toEqual({})
  }, 120_000)

  test('and an environment secret waits for the gate', async () => {
    if (!available)
      return

    await putSecret({ scope: 'environment', scopeId: created.environmentId, key: 'DEPLOY_TOKEN', value: 'production-only' })

    // Deploying, but not approved yet: the repository's value, not the
    // environment's. This is "released only after protection passes".
    const waiting = await secretsForJob({
      repositoryId: created.repositoryId,
      trusted: true,
      environment: 'production',
      approved: false,
    })

    expect(waiting.DEPLOY_TOKEN).toBe(VALUE)

    const approved = await secretsForJob({
      repositoryId: created.repositoryId,
      trusted: true,
      environment: 'production',
      approved: true,
    })

    expect(approved.DEPLOY_TOKEN).toBe('production-only')
  }, 120_000)

  test('and a build job in the same run never sees the environment\'s', async () => {
    if (!available)
      return

    const build = await secretsForJob({
      repositoryId: created.repositoryId,
      trusted: true,
      environment: null,
      approved: false,
    })

    expect(build.DEPLOY_TOKEN).toBe(VALUE)
    expect(Object.values(build)).not.toContain('production-only')
  }, 120_000)

  test('the names listing shows both scopes, still without values', async () => {
    if (!available)
      return

    const names = await secretNames(created.repositoryId)

    expect(names.filter(one => one.key === 'DEPLOY_TOKEN').map(one => one.scope).sort())
      .toEqual(['environment', 'repository'])
  }, 120_000)
})

/*
 * The automatic token, against the real tables.
 *
 * The unit tests hold what it may do; this holds that the row it creates is
 * actually scoped - a token that says `selection: 'selected'` and has no
 * repository attached would reach everything, which is the failure this whole
 * design is built to avoid.
 */
describe('the automatic job token', () => {
  test('is scoped to one repository, carries the resolved permissions, and expires', async () => {
    if (!available)
      return

    const { mintJobToken, revokeJobTokens } = await import('../../app/Actions/Workflow/jobToken')

    const minted = await mintJobToken({
      runId: 9001,
      jobId: 4242,
      repositoryId: created.repositoryId,
      actorId: created.ownerId,
      trusted: true,
      workflowPermissions: { 'contents': 'write', 'pull-requests': 'write' },
      jobPermissions: null,
    })

    expect(minted?.token).toBeTruthy()

    const row: any = await db
      .selectFrom('access_tokens')
      .select(['id', 'selection', 'expires_at', 'revoked_at'])
      .where('id', '=', Number(minted!.id))
      .executeTakeFirst()

    expect(String(row.selection)).toBe('selected')
    expect(new Date(String(row.expires_at)).getTime()).toBeGreaterThan(Date.now())

    const repositories: any[] = await db
      .selectFrom('access_token_repositories')
      .select(['repository_id'])
      .where('access_token_id', '=', Number(minted!.id))
      .execute()

    // The line that makes "scoped" true rather than claimed.
    expect(repositories.map(one => Number(one.repository_id))).toEqual([created.repositoryId])

    const permissions: any[] = await db
      .selectFrom('access_token_permissions')
      .select(['scope', 'level'])
      .where('access_token_id', '=', Number(minted!.id))
      .execute()

    expect(permissions.map(one => `${one.scope}:${one.level}`).sort())
      .toEqual(['contents:write', 'pull_requests:write'])

    /*
     * And it dies with the job. An hour is a long time for a credential
     * nothing needs any more, so the expiry is the backstop rather than the
     * mechanism.
     */
    await revokeJobTokens(9001, 4242)

    const after: any = await db
      .selectFrom('access_tokens')
      .select(['revoked_at'])
      .where('id', '=', Number(minted!.id))
      .executeTakeFirst()

    expect(after.revoked_at).toBeTruthy()

    await db.deleteFrom('access_tokens').where('id', '=', Number(minted!.id)).execute()
  }, 120_000)

  test('and a fork gets read access however its workflow file asks', async () => {
    if (!available)
      return

    const { mintJobToken } = await import('../../app/Actions/Workflow/jobToken')

    const minted = await mintJobToken({
      runId: 9002,
      jobId: 4243,
      repositoryId: created.repositoryId,
      actorId: created.ownerId,
      trusted: false,
      workflowPermissions: { 'contents': 'write', 'issues': 'write' },
      jobPermissions: null,
    })

    const permissions: any[] = await db
      .selectFrom('access_token_permissions')
      .select(['scope', 'level'])
      .where('access_token_id', '=', Number(minted!.id))
      .execute()

    expect(permissions.map(one => `${one.scope}:${one.level}`)).toEqual(['contents:read'])

    await db.deleteFrom('access_tokens').where('id', '=', Number(minted!.id)).execute()
  }, 120_000)
})

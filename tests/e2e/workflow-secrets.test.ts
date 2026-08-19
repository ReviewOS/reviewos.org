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

  test('a job that named what it needs is handed only that, decrypted', async () => {
    if (!available)
      return

    await putSecret({ scope: 'repository', scopeId: created.repositoryId, key: 'NPM_TOKEN', value: 'npm-value' })

    /*
     * Least privilege reaching the real path, not just the pure rule. A test
     * job holding the deploy key for the length of its run is a credential a
     * compromised dependency can read, and the job never needed it.
     */
    const narrowed = await secretsForJob({
      repositoryId: created.repositoryId,
      trusted: true,
      environment: null,
      approved: false,
      only: ['NPM_TOKEN'],
    })

    expect(narrowed.NPM_TOKEN).toBe('npm-value')
    expect(narrowed.DEPLOY_TOKEN).toBeUndefined()

    // And a job that named none gets none - which is a thing to be able to say
    // about a job that runs somebody else's code.
    const sandboxed = await secretsForJob({
      repositoryId: created.repositoryId,
      trusted: true,
      environment: null,
      approved: false,
      only: [],
    })

    expect(Object.keys(sandboxed)).toEqual([])
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
describe('a secret that reaches the log anyway', () => {
  test('is redacted before it is written down, not after', async () => {
    if (!available)
      return

    /*
     * The runner masks what it was given, and that is the first line. This is
     * the second, and it exists because the first is somebody else's program: a
     * runner that is old, patched or hostile is still one this instance accepts
     * logs from, and "we asked it to mask" is not a property of the stored log.
     *
     * The way a credential reaches a log is never `echo $TOKEN` - it is a curl
     * that failed and printed the request it tried, which is what this sends.
     */
    // A workflow and a version of its own, since this fixture has neither: a
    // run row needs one, and borrowing another test's would tie the two
    // together for no reason.
    const workflow: any = await db.insertInto('workflows').values({
      owner_type: 'user',
      owner_id: created.ownerId,
      repository_id: created.repositoryId,
      path: '.github/workflows/leaky.yml',
      name: 'Leaky',
      state: 'active',
    }).returning(['id']).executeTakeFirst()

    const version: any = await db.insertInto('workflow_versions').values({
      workflow_id: Number(workflow.id),
      source_sha: 'd'.repeat(40),
      source_path: '.github/workflows/leaky.yml',
      content_digest: unique('digest').padEnd(64, '0').slice(0, 64),
      on_push: true,
    }).returning(['id']).executeTakeFirst()

    const run: any = await db.insertInto('workflow_runs').values({
      workflow_version_id: Number(version.id),
      repository_id: created.repositoryId,
      number: 4242,
      state: 'running',
      event: 'push',
      event_ref: 'refs/heads/main',
      head_sha: 'd'.repeat(40),
      definition_sha: 'd'.repeat(40),
      trusted: true,
    }).returning(['id']).executeTakeFirst()

    const job: any = await db.insertInto('workflow_jobs').values({
      workflow_run_id: Number(run.id),
      job_id: 'leaky',
      name: 'Leaky',
      position: 0,
      state: 'running',
      runs_on: 'ubuntu-latest',
    }).returning(['id']).executeTakeFirst()

    const { appendLog } = await import('../../app/Actions/Runner/logs')

    await appendLog({
      jobId: Number(job.id),
      sequence: 1,
      content: `curl -H "authorization: Bearer ${VALUE}" https://api.example.com\n`,
      stream: 'stderr',
    })

    const stored: any[] = await db
      .selectFrom('workflow_job_logs')
      .select(['content'])
      .where('workflow_job_id', '=', Number(job.id))
      .execute()

    const text = stored.map(row => String(row.content ?? '')).join('')

    expect(text).not.toContain(VALUE)
    // A visible marker rather than a silent gap: a line that lost characters
    // with no sign reads as a bug in the log, and somebody goes looking for it.
    expect(text).toContain('[redacted]')

    /*
     * And the read says so, rather than leaving a reader to spot the marker.
     *
     * "Redaction metadata rather than silently omitting data" is the phase 9
     * rule, and this is where a client meets it: the page carries the marker it
     * used and how many values it stands for, so a screen can put "1 value
     * hidden" beside the log instead of hoping somebody notices.
     */
    const { readLog } = await import('../../app/Actions/Runner/logs')
    const page = await readLog(Number(job.id))

    expect(page.redaction.marker).toBe('[redacted]')
    expect(page.redaction.count).toBe(1)

    await db.deleteFrom('workflows').where('id', '=', Number(workflow.id)).execute()
  }, 120_000)
})

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

/*
 * A secret this instance never held.
 *
 * The row holds a path into the store an organisation already runs, and the
 * value is read at the moment a job is handed out. What matters end to end is
 * the pair: the stored bytes are not the credential, and a reference that
 * cannot be read fails by name instead of arriving empty.
 */
describe('a secret stored as a reference', () => {
  test('keeps the value out of this instance, and hands it over at the claim', async () => {
    if (!available)
      return

    const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const process = (await import('node:process')).default

    const root = mkdtempSync(join(tmpdir(), 'reviewos-store-'))

    try {
      mkdirSync(join(root, 'mounted'), { recursive: true })
      writeFileSync(join(root, 'mounted', 'publish-token'), 'the-value-from-the-platform\n')
      writeFileSync(join(root, 'stores.json'), JSON.stringify({ mounted: { kind: 'file', address: join(root, 'mounted') } }))

      process.env.REVIEWOS_SECRET_STORES = join(root, 'stores.json')

      const { putSecret, secretsForJobDetailed } = await import('../../app/Actions/Workflow/secrets')

      await putSecret({
        scope: 'repository',
        scopeId: created.repositoryId,
        key: 'PUBLISH_TOKEN',
        value: 'store://mounted/publish-token',
        reference: true,
      })

      const row: any = await db
        .selectFrom('workflow_secrets')
        .select(['sealed'])
        .where('scope_type', '=', 'repository')
        .where('scope_id', '=', created.repositoryId)
        .where('key', '=', 'PUBLISH_TOKEN')
        .executeTakeFirst()

      // What is stored is a path, and encrypted at that: a copy of this
      // database is a list of names and locations rather than of credentials.
      expect(String(row.sealed)).not.toContain('the-value-from-the-platform')

      const delivered = await secretsForJobDetailed({
        repositoryId: created.repositoryId,
        trusted: true,
        environment: null,
        approved: false,
        only: ['PUBLISH_TOKEN'],
      })

      expect(delivered.problems).toEqual([])
      expect(delivered.values.PUBLISH_TOKEN).toBe('the-value-from-the-platform')

      // And when the store cannot answer, the job is told which secret and
      // why - rather than being handed an empty credential that fails forty
      // minutes later against somebody else's API.
      rmSync(join(root, 'mounted', 'publish-token'))

      const broken = await secretsForJobDetailed({
        repositoryId: created.repositoryId,
        trusted: true,
        environment: null,
        approved: false,
        only: ['PUBLISH_TOKEN'],
      })

      expect(broken.values.PUBLISH_TOKEN).toBeUndefined()
      expect(broken.problems.map(one => one.key)).toEqual(['PUBLISH_TOKEN'])
      expect(broken.problems[0]!.reason).toContain('publish-token')

      await db.deleteFrom('workflow_secrets')
        .where('scope_type', '=', 'repository')
        .where('scope_id', '=', created.repositoryId)
        .where('key', '=', 'PUBLISH_TOKEN')
        .execute()
    }
    finally {
      delete process.env.REVIEWOS_SECRET_STORES
      rmSync(root, { recursive: true, force: true })
    }
  }, 120_000)
})

/*
 * The release path: signing material and store credentials.
 *
 * The rule mobile delivery needs and every CI product gets wrong: the
 * certificate and the store password reach the publish step and nothing else.
 * A build job runs whatever the dependency tree brought with it, and a signing
 * key in that job's environment is a signing key any of it can read.
 */
describe('a publish credential', () => {
  test('is withheld from the build job in the same run, and released to the publish job after its gate', async () => {
    if (!available)
      return

    const { putSecret, secretsForJob } = await import('../../app/Actions/Workflow/secrets')
    const { db } = await import('@stacksjs/database')

    const environment: any = await db.insertInto('environments').values({
      repository_id: created.repositoryId,
      name: 'app-store',
      wait_minutes: 0,
      branches: '',
      description: 'where the signing material lives',
    }).returning(['id']).executeTakeFirst()

    await putSecret({ scope: 'environment', scopeId: Number(environment.id), key: 'SIGNING_KEY', value: 'the-p12-password' })
    await putSecret({ scope: 'environment', scopeId: Number(environment.id), key: 'STORE_TOKEN', value: 'the-app-store-token' })
    await putSecret({ scope: 'repository', scopeId: created.repositoryId, key: 'BUILD_CACHE_TOKEN', value: 'harmless' })

    // The build job: it names no environment, so it is not deploying anywhere.
    const build = await secretsForJob({
      repositoryId: created.repositoryId,
      trusted: true,
      environment: null,
      approved: false,
    })

    expect(build.BUILD_CACHE_TOKEN).toBe('harmless')
    expect(build.SIGNING_KEY).toBeUndefined()
    expect(build.STORE_TOKEN).toBeUndefined()

    // And a build job that *asks* for it by name still does not get it: naming
    // a secret narrows what a job receives, it does not widen it.
    const asking = await secretsForJob({
      repositoryId: created.repositoryId,
      trusted: true,
      environment: null,
      approved: false,
      only: ['SIGNING_KEY', 'STORE_TOKEN'],
    })

    expect(asking).toEqual({})

    // The publish job, waiting on its gate: still nothing, which is what makes
    // "released only after protection passes" true rather than promised.
    const waiting = await secretsForJob({
      repositoryId: created.repositoryId,
      trusted: true,
      environment: 'app-store',
      approved: false,
    })

    expect(waiting.SIGNING_KEY).toBeUndefined()

    const publishing = await secretsForJob({
      repositoryId: created.repositoryId,
      trusted: true,
      environment: 'app-store',
      approved: true,
    })

    expect(publishing.SIGNING_KEY).toBe('the-p12-password')
    expect(publishing.STORE_TOKEN).toBe('the-app-store-token')

    await db.deleteFrom('workflow_secrets').where('scope_type', '=', 'environment').where('scope_id', '=', Number(environment.id)).execute()
    await db.deleteFrom('environments').where('id', '=', Number(environment.id)).execute()
  }, 120_000)
})

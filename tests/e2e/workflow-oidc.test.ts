// The token a job presents instead of a stored cloud key.
//
// The test that matters is not that a string comes back - it is that somebody
// on the other side can **verify** it: fetch the discovery document, take the
// JWKS, check the signature, and read claims they can write a policy against.
// So this does exactly that, with WebCrypto, the way AWS would.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

const created = {
  ownerId: 0,
  repositoryId: 0,
  runnerId: 0,
  handle: '',
  name: '',
  runId: 0,
  jobId: 0,
  jobToken: '',
  forkJobToken: '',
}

let available = false
let db: any = null
let server: any = null
let port = 0

function unique(prefix: string): string {
  return `${prefix}${Buffer.from(crypto.getRandomValues(new Uint8Array(5))).toString('hex')}`
}

async function ask(token: string, body: Record<string, unknown> = {}): Promise<{ status: number, body: any }> {
  const answer = await fetch(`http://127.0.0.1:${port}/api/runner/oidc`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-Runner-Protocol': '1',
    },
    body: JSON.stringify(body),
  })

  return { status: answer.status, body: await answer.json().catch(() => null) }
}

/** Decode a segment the way any verifier does. */
function decode(segment: string): any {
  return JSON.parse(Buffer.from(segment.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'))
}

/** A run and a job, with a credential the runner would have been handed. */
async function seedJob(trusted: boolean): Promise<{ runId: number, jobId: number, token: string }> {
  const version: any = await db
    .selectFrom('workflow_versions')
    .select(['id'])
    .orderBy('id', 'desc')
    .executeTakeFirst()

  const run: any = await db.insertInto('workflow_runs').values({
    workflow_version_id: Number(version.id),
    repository_id: created.repositoryId,
    number: trusted ? 1 : 2,
    state: 'running',
    event: 'push',
    event_ref: 'refs/heads/main',
    /*
     * A commit of its own per run: the redelivery index is on (version, ref,
     * head, event), so two runs of one workflow at one commit are the same run
     * as far as the database is concerned - which is the dedupe working, not a
     * fixture problem to route around.
     */
    head_sha: unique('c').padEnd(40, '0').slice(0, 40),
    definition_sha: 'c'.repeat(40),
    trusted,
    actor_id: created.ownerId,
  }).returning(['id']).executeTakeFirst()

  const { hashToken } = await import('../../app/Actions/Runner/authenticate')
  const token = `job_${unique('t')}`

  const job: any = await db.insertInto('workflow_jobs').values({
    workflow_run_id: Number(run.id),
    job_id: 'deploy',
    name: 'Deploy',
    position: 0,
    state: 'running',
    runs_on: 'ubuntu-latest',
    job_token_hash: hashToken(token),
    /*
     * A job credential names the machine holding the job: the endpoint refuses
     * a token whose runner is gone or switched off, which is what stops a
     * disabled machine still speaking for work it was given.
     */
    runner_id: String(created.runnerId),
    lease_expires_at: new Date(Date.now() + 600_000).toISOString(),
    settings: trusted ? JSON.stringify({ environment: 'production' }) : null,
  }).returning(['id']).executeTakeFirst()

  return { runId: Number(run.id), jobId: Number(job.id), token }
}

beforeAll(async () => {
  try {
    const { injectGlobalAutoImports } = await import('@stacksjs/server')
    const { route } = await import('@stacksjs/router')

    await injectGlobalAutoImports()
    db = (globalThis as any).db
    await db.selectFrom('users').select(['id']).limit(1).execute()

    created.handle = unique('oidc')

    const owner: any = await db
      .insertInto('users')
      .values({ name: 'OIDC', email: `${created.handle}@example.com`, handle: created.handle, password: 'x' })
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
        visibility: 'private',
        default_branch: 'main',
        disk_path: `${created.handle}/${created.name}.git`,
      })
      .returning(['id'])
      .executeTakeFirst()

    created.repositoryId = Number(repository?.id)

    const runner: any = await db.insertInto('runners').values({
      name: unique('runner'),
      scope_type: 'repository',
      scope_id: created.repositoryId,
      token_hash: unique('h').padEnd(64, '0').slice(0, 64),
      state: 'active',
      labels: 'ubuntu-latest',
    } as any).returning(['id']).executeTakeFirst()

    created.runnerId = Number(runner?.id)

    const workflow: any = await db.insertInto('workflows').values({
      owner_type: 'user',
      owner_id: created.ownerId,
      repository_id: created.repositoryId,
      path: '.github/workflows/deploy.yml',
      name: 'Deploy',
      state: 'active',
    }).returning(['id']).executeTakeFirst()

    await db.insertInto('workflow_versions').values({
      workflow_id: Number(workflow.id),
      source_sha: 'a'.repeat(40),
      source_path: '.github/workflows/deploy.yml',
      content_digest: unique('d').padEnd(64, '0').slice(0, 64),
      on_push: true,
    }).execute()

    const trusted = await seedJob(true)
    const fork = await seedJob(false)

    created.runId = trusted.runId
    created.jobId = trusted.jobId
    created.jobToken = trusted.token
    created.forkJobToken = fork.token

    await route.importRoutes()
    server = await route.serve({ port: 0, hostname: '127.0.0.1' })
    port = Number((server as any)?.port ?? 0)

    available = true
  }
  catch (error) {
    console.warn(`[oidc] skipping: ${error instanceof Error ? error.message : String(error)}`)
    available = false
  }
}, 180_000)

afterAll(async () => {
  try {
    server?.stop?.()
    if (created.runnerId)
      await db.deleteFrom('runners').where('id', '=', created.runnerId).execute()
    if (created.repositoryId)
      await db.deleteFrom('repositories').where('id', '=', created.repositoryId).execute()
    if (created.ownerId)
      await db.deleteFrom('users').where('id', '=', created.ownerId).execute()
  }
  catch { /* the next run uses fresh names */ }
})

describe('a token a cloud can verify', () => {
  test('is signed by a key the published JWKS holds, and says what it should', async () => {
    if (!available)
      return

    const { status, body } = await ask(created.jobToken, { audience: 'sts.amazonaws.com' })

    expect(status).toBe(200)
    expect(Number(body.expires_in)).toBeGreaterThan(0)

    const [head, payload, signature] = String(body.value).split('.')
    const header = decode(head!)
    const claims = decode(payload!)

    // The discovery document first, which is what a cloud provider reads before
    // it will trust an issuer at all.
    const discovery = await (await fetch(`http://127.0.0.1:${port}/.well-known/openid-configuration`)).json() as any

    expect(String(discovery.issuer)).toBe(claims.iss)
    expect(String(discovery.jwks_uri)).toContain('/.well-known/jwks.json')

    const jwks = await (await fetch(String(discovery.jwks_uri))).json() as any
    const key = (jwks.keys ?? []).find((one: any) => one.kid === header.kid)

    expect(key).toBeTruthy()

    /*
     * The verification itself, with WebCrypto and nothing else - which is what
     * the other side does. A token that only this codebase can check is a
     * token that is not worth minting.
     */
    const publicKey = await crypto.subtle.importKey(
      'jwk',
      { ...key, alg: 'RS256', ext: true },
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify'],
    )

    const valid = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      publicKey,
      Buffer.from(signature!.replace(/-/g, '+').replace(/_/g, '/'), 'base64'),
      new TextEncoder().encode(`${head}.${payload}`),
    )

    expect(valid).toBe(true)

    // And the claims a trust policy is written against, in GitHub's names so an
    // existing policy keeps working.
    expect(claims.aud).toBe('sts.amazonaws.com')
    expect(claims.repository).toBe(`${created.handle}/${created.name}`)
    expect(claims.repository_owner).toBe(created.handle)
    expect(claims.ref).toBe('refs/heads/main')
    expect(claims.event_name).toBe('push')
    expect(claims.workflow_ref).toContain('.github/workflows/deploy.yml@refs/heads/main')

    // The environment makes the subject more specific, which is what somebody
    // means by "only the production deploy may assume this role".
    expect(claims.sub).toBe(`repo:${created.handle}/${created.name}:environment:production`)
  }, 180_000)

  test('nothing in it comes from the request but the audience', async () => {
    if (!available)
      return

    /*
     * A token whose repository came from the body would be a token any job
     * could mint for any repository, which is the thing this replaces.
     */
    const { body } = await ask(created.jobToken, {
      audience: 'x',
      repository: 'somebody/else',
      sub: 'repo:somebody/else:ref:refs/heads/main',
    })

    const claims = decode(String(body.value).split('.')[1]!)

    expect(claims.repository).toBe(`${created.handle}/${created.name}`)
    expect(claims.sub).toContain(`${created.handle}/${created.name}`)
  }, 180_000)

  test('and it expires in minutes rather than lasting forever', async () => {
    if (!available)
      return

    // The whole argument against a stored cloud key: this one is useless
    // fifteen minutes after the job asked for it.
    const { body } = await ask(created.jobToken)
    const claims = decode(String(body.value).split('.')[1]!)

    expect(claims.exp - claims.iat).toBeLessThanOrEqual(15 * 60)
    expect(claims.exp - claims.iat).toBeGreaterThan(60)
  }, 180_000)
})

describe('a fork', () => {
  test('gets no token at all, with the reason', async () => {
    if (!available)
      return

    // By the threat model an untrusted run receives no credentials, and "I am
    // acme/api on main" is the strongest credential this instance can issue.
    const { status, body } = await ask(created.forkJobToken)

    expect(status).toBe(403)
    expect(String(body.error)).toContain('untrusted')
  }, 180_000)
})

describe('rotation', () => {
  test('a new key signs, and the old one still verifies', async () => {
    if (!available)
      return

    /*
     * Both halves. Without the first a rotation is a promise; without the
     * second it is an outage, because every token signed a minute ago becomes
     * unverifiable - which is a rotation nobody performs.
     */
    const before = await ask(created.jobToken)
    const beforeKid = decode(String(before.body.value).split('.')[0]!).kid

    const { rotateKey } = await import('../../app/Actions/Workflow/oidc')

    await rotateKey()

    const after = await ask(created.jobToken)
    const afterKid = decode(String(after.body.value).split('.')[0]!).kid

    expect(afterKid).not.toBe(beforeKid)

    const jwks = await (await fetch(`http://127.0.0.1:${port}/.well-known/jwks.json`)).json() as any
    const kids = (jwks.keys ?? []).map((one: any) => String(one.kid))

    expect(kids).toContain(afterKid)
    expect(kids).toContain(beforeKid)
  }, 180_000)
})

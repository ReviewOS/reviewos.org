// What a run produced, from the machine that made it to the person who wants it.
//
// The interesting half is not the upload. It is everything around it: that the
// same file uploaded twice is one artifact, that a name already taken by
// different bytes is refused rather than silently replacing something somebody
// may already hold, that a private repository's build output is as private as
// the repository, and that an id is checked against the repository the caller
// named - it is a number anybody can increment.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { hashToken } from '../../app/Actions/Runner/authenticate'
import { artifactPath, digestOf } from '../../app/Actions/Artifact/storage'
import { dispatchPush } from '../../app/Actions/Workflow/dispatch'
import { syncWorkflowFile } from '../../app/Actions/Workflow/sync'

const created = {
  ownerId: 0,
  repositoryId: 0,
  handle: '',
  name: '',
  privateId: 0,
  privateName: '',
  runnerIds: [] as number[],
  digests: [] as string[],
}

let available = false
let db: any = null
let server: any = null
let port = 0

const TOKEN = `tok-${Buffer.from(crypto.getRandomValues(new Uint8Array(8))).toString('hex')}`

function unique(prefix: string): string {
  return `${prefix}${Buffer.from(crypto.getRandomValues(new Uint8Array(5))).toString('hex')}`
}

const CI = `name: CI
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: build
`

/** Claim a job and keep the credential it was handed. */
async function claimOne(): Promise<{ id: number, token: string, runNumber: number }> {
  const dispatched = await dispatchPush({
    repositoryId: created.repositoryId,
    event: { ref: 'refs/heads/main' },
    headSha: `${Math.random().toString(16).slice(2)}`.padEnd(40, '0'),
  })

  const answer = await fetch(`http://127.0.0.1:${port}/api/runner/claim`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'authorization': `Bearer ${TOKEN}` },
    body: '{}',
  })

  const body: any = await answer.json()

  const run: any = await db
    .selectFrom('workflow_runs')
    .select(['number'])
    .where('id', '=', Number(dispatched.created[0]))
    .executeTakeFirst()

  return { id: Number(body.job.id), token: String(body.job.token), runNumber: Number(run?.number ?? 0) }
}

/** Upload some bytes the way a runner does: the body is the file. */
async function upload(token: string, name: string, content: string, extra: Record<string, string> = {}) {
  const answer = await fetch(`http://127.0.0.1:${port}/api/runner/artifacts`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'text/plain',
      'X-Artifact-Name': name,
      ...extra,
    },
    body: content,
  })

  const body: any = await answer.json().catch(() => ({}))

  if (body?.digest)
    created.digests.push(String(body.digest))

  return { status: answer.status, body }
}

async function list(repo = created.name) {
  const answer = await fetch(
    `http://127.0.0.1:${port}/api/repos/workflow-runs/artifacts?owner=${created.handle}&repo=${repo}&number=1`,
    { headers: { Accept: 'application/json' } },
  )

  return { status: answer.status, body: await answer.json().catch(() => ({})) as any }
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

    created.handle = unique('art')
    const owner: any = await db.insertInto('users')
      .values({ name: 'Artifacts', email: `${created.handle}@example.com`, handle: created.handle, password: 'x' })
      .returning(['id']).executeTakeFirst()

    created.ownerId = Number(owner?.id)
    created.name = unique('repo')

    const repository: any = await db.insertInto('repositories').values({
      owner_type: 'user',
      owner_id: created.ownerId,
      name: created.name,
      visibility: 'public',
      default_branch: 'main',
      disk_path: `${created.handle}/${created.name}.git`,
    }).returning(['id']).executeTakeFirst()

    created.repositoryId = Number(repository?.id)

    // A second repository nobody may read, for the access rule.
    created.privateName = unique('secret')
    const hidden: any = await db.insertInto('repositories').values({
      owner_type: 'user',
      owner_id: created.ownerId,
      name: created.privateName,
      visibility: 'private',
      default_branch: 'main',
      disk_path: `${created.handle}/${created.privateName}.git`,
    }).returning(['id']).executeTakeFirst()

    created.privateId = Number(hidden?.id)

    const runner: any = await db.insertInto('runners').values({
      name: unique('runner'),
      scope_type: 'repository',
      scope_id: created.repositoryId,
      token_hash: hashToken(TOKEN),
      labels: 'ubuntu-latest',
      state: 'active',
    }).returning(['id']).executeTakeFirst()

    created.runnerIds.push(Number(runner.id))

    await syncWorkflowFile({
      repositoryId: created.repositoryId,
      ownerType: 'user',
      ownerId: created.ownerId,
      path: '.github/workflows/ci.yml',
      source: CI,
      sha: 'a'.repeat(40),
    })

    available = true
  }
  catch (error) {
    console.warn(`[runner-artifacts] skipping: ${error instanceof Error ? error.message : String(error)}`)
    available = false
  }
}, 120_000)

afterAll(async () => {
  try { server?.stop?.(true) }
  catch { /* already down */ }

  try {
    for (const id of created.runnerIds)
      await db.deleteFrom('runners').where('id', '=', id).execute()
    for (const id of [created.repositoryId, created.privateId].filter(Boolean))
      await db.deleteFrom('repositories').where('id', '=', id).execute()
    if (created.ownerId)
      await db.deleteFrom('users').where('id', '=', created.ownerId).execute()
  }
  catch { /* the next run uses fresh names */ }

  // The blobs this test wrote. Content-addressed, so a digest another test
  // happens to share is left alone by the row cleanup above and removed here
  // only because nothing else on a test database will want it.
  for (const digest of created.digests) {
    try { rmSync(artifactPath(digest), { force: true }) }
    catch { /* a file under storage */ }
  }
})

describe('publishing', () => {
  test('a runner uploads a file and gets back the digest it can be checked against', async () => {
    if (!available)
      return

    const job = await claimOne()
    const answer = await upload(job.token, 'coverage.lcov', 'TN:\nSF:app.ts\nend_of_record\n')

    expect(answer.status).toBe(201)
    expect(answer.body.digest).toBe(digestOf(new TextEncoder().encode('TN:\nSF:app.ts\nend_of_record\n')))
    expect(answer.body.size_bytes).toBeGreaterThan(0)
    // The promise, in the response: a client that has to guess when an artifact
    // disappears either re-downloads everything or finds out by 404.
    expect(answer.body.expires_at).toBeTruthy()
  })

  /*
   * At-least-once delivery is the protocol's promise, so a runner that did not
   * hear the answer uploads again. Without a rule the run grows two rows for
   * one file and whoever collects it has to guess which.
   */
  test('the same file twice is one artifact, and says so', async () => {
    if (!available)
      return

    const job = await claimOne()

    const first = await upload(job.token, 'build.tar', 'the same bytes')
    const second = await upload(job.token, 'build.tar', 'the same bytes')

    expect(first.status).toBe(201)
    expect(second.status).toBe(200)
    expect(second.body.duplicate).toBe(true)
    expect(second.body.id).toBe(first.body.id)
  })

  /*
   * The other half of that rule, and the one worth arguing about. Silently
   * replacing an artifact somebody may already have downloaded leaves two
   * people holding different files with one name and no way to tell.
   */
  test('but a different file under a name already taken is refused', async () => {
    if (!available)
      return

    const job = await claimOne()

    await upload(job.token, 'report.txt', 'first')
    const second = await upload(job.token, 'report.txt', 'second')

    expect(second.status).toBe(409)
    expect(String(second.body.error)).toContain('another name')
  })

  test('an empty body is refused rather than stored as an empty artifact', async () => {
    if (!available)
      return

    const job = await claimOne()
    const answer = await upload(job.token, 'nothing.txt', '')

    expect(answer.status).toBe(422)
  })

  /*
   * The credential separation the protocol is built on. A registration token
   * reaches every job that machine may run, so accepting it here would let one
   * repository's build output be attached to another's run.
   */
  test('the registration token cannot publish an artifact', async () => {
    if (!available)
      return

    await claimOne()
    const answer = await upload(TOKEN, 'sneaky.txt', 'x')

    expect(answer.status).toBe(401)
  })
})

describe('collecting', () => {
  test('a run lists what it produced, with sizes a person reads', async () => {
    if (!available)
      return

    const job = await claimOne()
    await upload(job.token, 'listed.txt', 'hello')

    const answer = await fetch(
      `http://127.0.0.1:${port}/api/repos/workflow-runs/artifacts`
      + `?owner=${created.handle}&repo=${created.name}&number=${job.runNumber}`,
      { headers: { Accept: 'application/json' } },
    )

    const body: any = await answer.json()

    expect(answer.status).toBe(200)
    expect(body.artifacts.map((one: any) => one.name)).toContain('listed.txt')
    expect(body.artifacts[0].size).toBeTruthy()
    expect(body.total_bytes).toBeGreaterThan(0)
  })

  test('and hands the bytes back as a download, never as a page', async () => {
    if (!available)
      return

    const job = await claimOne()
    const uploaded = await upload(job.token, 'download.txt', 'the contents')

    const answer = await fetch(
      `http://127.0.0.1:${port}/api/repos/workflow-runs/artifact`
      + `?owner=${created.handle}&repo=${created.name}&id=${uploaded.body.id}`,
    )

    expect(answer.status).toBe(200)
    expect(await answer.text()).toBe('the contents')

    /*
     * The bytes came off a machine running somebody's build. A browser willing
     * to render them in place turns an artifact into stored cross-site
     * scripting - an HTML report, or an SVG, which is a document with scripting
     * in it that happens to look like a picture.
     */
    expect(String(answer.headers.get('content-disposition'))).toContain('attachment')
    expect(answer.headers.get('x-content-type-options')).toBe('nosniff')
    // What it is, so a client can check what it got against what it asked for.
    expect(answer.headers.get('x-artifact-digest')).toBe(uploaded.body.digest)
  })

  /*
   * The id is a number anybody can increment. Without the repository check this
   * endpoint reads out every repository's build output one integer at a time.
   */
  test('an artifact belonging to another repository is not found here', async () => {
    if (!available)
      return

    const job = await claimOne()
    const uploaded = await upload(job.token, 'private.txt', 'not yours')

    const answer = await fetch(
      `http://127.0.0.1:${port}/api/repos/workflow-runs/artifact`
      + `?owner=${created.handle}&repo=${created.privateName}&id=${uploaded.body.id}`,
    )

    // 404 either way: the private repository answers a stranger as missing, and
    // so does an artifact that is not its own.
    expect(answer.status).toBe(404)
  })

  test('a run number that does not exist is a 404 rather than an empty list', async () => {
    if (!available)
      return

    const answer = await fetch(
      `http://127.0.0.1:${port}/api/repos/workflow-runs/artifacts`
      + `?owner=${created.handle}&repo=${created.name}&number=999999`,
      { headers: { Accept: 'application/json' } },
    )

    expect(answer.status).toBe(404)
  })
})

describe('expiry', () => {
  test('an artifact past its date is refused before anything sweeps', async () => {
    if (!available)
      return

    const job = await claimOne()
    const uploaded = await upload(job.token, 'expired.txt', 'gone tomorrow')

    await db
      .updateTable('workflow_artifacts')
      .set({ expires_at: new Date(Date.now() - 60_000).toISOString() })
      .where('id', '=', Number(uploaded.body.id))
      .execute()

    const answer = await fetch(
      `http://127.0.0.1:${port}/api/repos/workflow-runs/artifact`
      + `?owner=${created.handle}&repo=${created.name}&id=${uploaded.body.id}`,
    )

    // 410, not 404: it existed, its date passed, and the difference is one an
    // operator reading a log should be able to see.
    expect(answer.status).toBe(410)
  })

  test('and the sweep removes the row, and the blob nothing else references', async () => {
    if (!available)
      return

    const job = await claimOne()
    const uploaded = await upload(job.token, 'swept.txt', `unique ${Math.random()}`)

    await db
      .updateTable('workflow_artifacts')
      .set({ expires_at: new Date(Date.now() - 60_000).toISOString() })
      .where('id', '=', Number(uploaded.body.id))
      .execute()

    const { sweepExpiredArtifacts } = await import('../../app/Actions/Artifact/store')
    const swept = await sweepExpiredArtifacts()

    expect(swept.removed).toBeGreaterThan(0)

    const row: any = await db
      .selectFrom('workflow_artifacts')
      .select(['id'])
      .where('id', '=', Number(uploaded.body.id))
      .executeTakeFirst()

    expect(row).toBeFalsy()
    expect(await Bun.file(artifactPath(String(uploaded.body.digest))).exists()).toBe(false)
  })

  test('a blob another artifact still points at survives its own row expiring', async () => {
    if (!available)
      return

    // The same bytes from two runs, which on a matrix is the ordinary case.
    const first = await claimOne()
    const second = await claimOne()
    const shared = `shared ${Math.random()}`

    const one = await upload(first.token, 'shared.txt', shared)
    const two = await upload(second.token, 'shared.txt', shared)

    expect(one.body.digest).toBe(two.body.digest)

    await db
      .updateTable('workflow_artifacts')
      .set({ expires_at: new Date(Date.now() - 60_000).toISOString() })
      .where('id', '=', Number(one.body.id))
      .execute()

    const { sweepExpiredArtifacts } = await import('../../app/Actions/Artifact/store')
    await sweepExpiredArtifacts()

    // The row went; the file stayed, because the other run's artifact is the
    // same bytes and deleting it would take that one out from under its owner.
    expect(await Bun.file(artifactPath(String(one.body.digest))).exists()).toBe(true)

    const survivor: any = await db
      .selectFrom('workflow_artifacts')
      .select(['id'])
      .where('id', '=', Number(two.body.id))
      .executeTakeFirst()

    expect(survivor).toBeTruthy()
  })
})

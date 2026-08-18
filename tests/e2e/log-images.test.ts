// A picture in a log, and the policy that decides which bytes may be one.
//
// The download endpoint hands every artifact over as an attachment, on purpose:
// the bytes came off a machine executing somebody's build, and a browser that
// renders them in place is a stored cross-site scripting hole with extra steps.
// This is the one path that does render them in place, so the whole test is
// about what it refuses.

import { rmSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { artifactPath } from '../../app/Actions/Artifact/storage'
import { hashToken } from '../../app/Actions/Runner/authenticate'
import { dispatchPush } from '../../app/Actions/Workflow/dispatch'
import { syncWorkflowFile } from '../../app/Actions/Workflow/sync'

const created = { ownerId: 0, repositoryId: 0, handle: '', name: '', runNumber: 0, jobToken: '', runnerIds: [] as number[], digests: [] as string[] }

let available = false
let db: any = null
let server: any = null
let port = 0

const RUNNER = `tok-${Buffer.from(crypto.getRandomValues(new Uint8Array(8))).toString('hex')}`

function unique(prefix: string): string {
  return `${prefix}${Buffer.from(crypto.getRandomValues(new Uint8Array(5))).toString('hex')}`
}

const CI = `name: CI
on: push
jobs:
  visual:
    runs-on: ubuntu-latest
    steps:
      - run: bun test
`

/** The smallest real PNG: a signature and a header a browser accepts. */
const PNG = new Uint8Array([
  0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
  0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1F, 0x15, 0xC4,
  0x89,
])

async function uploadBytes(name: string, body: BodyInit, type = 'application/octet-stream') {
  const answer = await fetch(`http://127.0.0.1:${port}/api/runner/artifacts`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${created.jobToken}`,
      'Content-Type': type,
      'X-Artifact-Name': name,
      'X-Runner-Protocol': '1',
    },
    body,
  })

  const parsed: any = await answer.json().catch(() => ({}))

  if (parsed?.digest)
    created.digests.push(String(parsed.digest))

  return { status: answer.status, body: parsed }
}

async function image(name: string) {
  const answer = await fetch(
    `http://127.0.0.1:${port}/api/repos/workflow-runs/log-image?owner=${created.handle}&repo=${created.name}&number=${created.runNumber}&artifact=${encodeURIComponent(name)}`,
  )

  return {
    status: answer.status,
    type: String(answer.headers.get('content-type') ?? ''),
    nosniff: String(answer.headers.get('x-content-type-options') ?? ''),
    policy: String(answer.headers.get('content-security-policy') ?? ''),
    bytes: new Uint8Array(await answer.arrayBuffer()),
  }
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

    created.handle = unique('logimg')

    const owner: any = await db.insertInto('users')
      .values({ name: 'Log Images', email: `${created.handle}@example.com`, handle: created.handle, password: 'x' })
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

    await syncWorkflowFile({
      repositoryId: created.repositoryId,
      ownerType: 'user',
      ownerId: created.ownerId,
      path: '.github/workflows/ci.yml',
      source: CI,
      sha: 'a'.repeat(40),
    })

    const runner: any = await db.insertInto('runners').values({
      name: unique('runner'),
      scope_type: 'repository',
      scope_id: created.repositoryId,
      token_hash: hashToken(RUNNER),
      labels: 'ubuntu-latest',
      state: 'active',
    }).returning(['id']).executeTakeFirst()

    created.runnerIds.push(Number(runner?.id))

    const dispatched = await dispatchPush({
      repositoryId: created.repositoryId,
      event: { ref: 'refs/heads/main' },
      headSha: 'b'.repeat(40),
    })

    const claim = await fetch(`http://127.0.0.1:${port}/api/runner/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${RUNNER}`, 'X-Runner-Protocol': '1' },
      body: '{}',
    })

    const claimed: any = await claim.json().catch(() => ({}))
    created.jobToken = String(claimed?.job?.token ?? '')

    const run: any = await db
      .selectFrom('workflow_runs')
      .select(['number'])
      .where('id', '=', Number(dispatched.created[0]))
      .executeTakeFirst()

    created.runNumber = Number(run?.number ?? 0)

    available = Boolean(created.jobToken && created.runNumber)
  }
  catch (error) {
    console.warn(`[log-images] skipping: ${error instanceof Error ? error.message : String(error)}`)
    available = false
  }
}, 180_000)

afterAll(async () => {
  try { server?.stop?.(true) }
  catch { /* already down */ }

  try {
    for (const id of created.runnerIds)
      await db.deleteFrom('runners').where('id', '=', id).execute().catch(() => {})

    if (created.repositoryId)
      await db.deleteFrom('repositories').where('id', '=', created.repositoryId).execute().catch(() => {})

    if (created.ownerId)
      await db.deleteFrom('users').where('id', '=', created.ownerId).execute().catch(() => {})

    for (const digest of created.digests) {
      try { rmSync(artifactPath(digest), { force: true }) }
      catch { /* another test may share the blob */ }
    }
  }
  catch { /* the next run uses fresh names */ }
})

describe('an image a job produced', () => {
  test('is served inline, with the type its bytes say it is', async () => {
    if (!available)
      return

    // Uploaded claiming to be something else, which is the point: the
    // `Content-Type` on an upload is whatever the machine typed.
    const uploaded = await uploadBytes('screenshot.png', PNG, 'application/octet-stream')

    expect(uploaded.status).toBe(201)

    const answer = await image('screenshot.png')

    expect(answer.status).toBe(200)
    expect(answer.type).toBe('image/png')
    expect(answer.nosniff).toBe('nosniff')
    // Nothing but these bytes: a picture cannot fetch, script, frame or
    // navigate, so a wrong sniff has nowhere to go.
    expect(answer.policy).toContain("default-src 'none'")
    expect(answer.policy).toContain('sandbox')
    expect(answer.bytes.length).toBe(PNG.length)
  }, 180_000)

  test('and an SVG is refused, whatever it contains', async () => {
    if (!available)
      return

    await uploadBytes('drawing.svg', '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', 'image/svg+xml')

    const answer = await image('drawing.svg')

    // The one image format that is a document. Rendering it in place means
    // running it, and no amount of sanitising makes that a picture.
    expect(answer.status).toBe(415)
  }, 180_000)

  test('and a script that calls itself a picture is refused too', async () => {
    if (!available)
      return

    await uploadBytes('payload.png', '#!/bin/sh\nrm -rf /\n', 'image/png')

    const answer = await image('payload.png')

    expect(answer.status).toBe(415)
  }, 180_000)

  test('and an artifact of another run is not reachable through this run', async () => {
    if (!available)
      return

    // The event names an artifact; the endpoint scopes it to the run whose log
    // is being read. A job reaching into another run's output is not a thing it
    // may do, however it spells the name.
    const answer = await fetch(
      `http://127.0.0.1:${port}/api/repos/workflow-runs/log-image?owner=${created.handle}&repo=${created.name}&number=${created.runNumber + 500}&artifact=screenshot.png`,
    )

    expect(answer.status).toBe(404)
  }, 180_000)
})

describe('the log it appears in', () => {
  test('carries the figure, the alt text and no URL the job chose', async () => {
    if (!available)
      return

    const append = await fetch(`http://127.0.0.1:${port}/api/runner/logs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${created.jobToken}`, 'X-Runner-Protocol': '1' },
      body: JSON.stringify({
        sequence: 1,
        events: [
          { type: 'line', text: 'comparing rendered output' },
          { type: 'image', text: 'the failing screen', artifact: 'screenshot.png', src: 'https://elsewhere.example/pixel.gif' },
        ],
      }),
    })

    expect(append.status).toBe(200)

    const page = await (await fetch(`http://127.0.0.1:${port}/${created.handle}/${created.name}/run/${created.runNumber}`)).text()

    expect(page).toContain('the failing screen')
    expect(page).toContain('/api/repos/workflow-runs/log-image?')
    // The address a build asked for never reaches the page: the only thing it
    // can show is something it uploaded here, under this run.
    expect(page).not.toContain('elsewhere.example')
  }, 180_000)

  test('and the plain-text form says what was there rather than leaving a gap', async () => {
    if (!available)
      return

    const job: any = await db
      .selectFrom('workflow_jobs')
      .innerJoin('workflow_runs', 'workflow_runs.id', '=', 'workflow_jobs.workflow_run_id')
      .select(['workflow_jobs.id as id'])
      .where('workflow_runs.repository_id', '=', created.repositoryId)
      .where('workflow_jobs.job_id', '=', 'visual')
      .executeTakeFirst()

    const answer = await fetch(
      `http://127.0.0.1:${port}/api/repos/workflow-runs/log?owner=${created.handle}&repo=${created.name}&job=${Number(job?.id)}`,
      { headers: { Accept: 'application/json' } },
    )

    const body: any = await answer.json().catch(() => ({}))
    const text = JSON.stringify(body)

    expect(text).toContain('[image: the failing screen')
    expect(text).toContain('screenshot.png')
  }, 180_000)
})

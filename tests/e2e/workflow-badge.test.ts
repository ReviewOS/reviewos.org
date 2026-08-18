// The badge a README carries.
//
// Two things are being checked and only one of them is the picture. The other
// is that a badge cannot be used to find out whether a private repository
// exists: a README is fetched by strangers, so "no such repository" and "not
// yours to see" have to be the same grey pill with the same 200.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { renderBadge, stateFor, widthOf } from '../../app/Actions/Workflow/badge'
import { syncWorkflowFile } from '../../app/Actions/Workflow/sync'

const created = { ownerId: 0, publicId: 0, privateId: 0, handle: '', publicName: '', privateName: '', versionId: 0 }

let available = false
let db: any = null
let server: any = null
let port = 0

function unique(prefix: string): string {
  return `${prefix}${Buffer.from(crypto.getRandomValues(new Uint8Array(5))).toString('hex')}`
}

const CI = `name: Build
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: make
`

async function badge(query: string, headers: Record<string, string> = {}): Promise<{ status: number, body: string, etag: string, cache: string }> {
  const answer = await fetch(`http://127.0.0.1:${port}/api/repos/badge?${query}`, { headers })

  return {
    status: answer.status,
    body: await answer.text(),
    etag: String(answer.headers.get('etag') ?? ''),
    cache: String(answer.headers.get('cache-control') ?? ''),
  }
}

/** A finished run of the seeded workflow on a branch. */
async function run(state: string, branch = 'main'): Promise<void> {
  const previous: any = await db
    .selectFrom('workflow_runs')
    .select(['number'])
    .where('repository_id', '=', created.publicId)
    .orderBy('number', 'desc')
    .limit(1)
    .executeTakeFirst()

  await db.insertInto('workflow_runs').values({
    workflow_version_id: created.versionId,
    repository_id: created.publicId,
    number: Number(previous?.number ?? 0) + 1,
    state,
    event: 'push',
    event_ref: `refs/heads/${branch}`,
    head_sha: unique('s').padEnd(40, '0').slice(0, 40),
    definition_sha: 'a'.repeat(40),
    trusted: true,
  }).execute()
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

    created.handle = unique('bdg')

    const owner: any = await db.insertInto('users')
      .values({ name: 'Badge', email: `${created.handle}@example.com`, handle: created.handle, password: 'x' })
      .returning(['id']).executeTakeFirst()

    created.ownerId = Number(owner?.id)

    const make = async (visibility: string): Promise<number> => {
      const name = unique('repo')
      const row: any = await db.insertInto('repositories').values({
        owner_type: 'user',
        owner_id: created.ownerId,
        name,
        visibility,
        default_branch: 'main',
        disk_path: `${created.handle}/${name}.git`,
      }).returning(['id']).executeTakeFirst()

      if (visibility === 'public')
        created.publicName = name
      else
        created.privateName = name

      return Number(row?.id)
    }

    created.publicId = await make('public')
    created.privateId = await make('private')

    await syncWorkflowFile({
      repositoryId: created.publicId,
      ownerType: 'user',
      ownerId: created.ownerId,
      path: '.github/workflows/ci.yml',
      source: CI,
      sha: 'a'.repeat(40),
    })

    const version: any = await db
      .selectFrom('workflow_versions')
      .innerJoin('workflows', 'workflows.id', '=', 'workflow_versions.workflow_id')
      .select(['workflow_versions.id as id'])
      .where('workflows.repository_id', '=', created.publicId)
      .orderBy('workflow_versions.id', 'desc')
      .executeTakeFirst()

    created.versionId = Number(version?.id)

    available = true
  }
  catch (error) {
    console.warn(`[badge] skipping: ${error instanceof Error ? error.message : String(error)}`)
    available = false
  }
}, 120_000)

afterAll(async () => {
  try { server?.stop?.(true) }
  catch { /* already down */ }

  try {
    for (const id of [created.publicId, created.privateId].filter(Boolean))
      await db.deleteFrom('repositories').where('id', '=', id).execute().catch(() => {})

    if (created.ownerId)
      await db.deleteFrom('users').where('id', '=', created.ownerId).execute().catch(() => {})
  }
  catch { /* the next run uses fresh names */ }
})

describe('the picture', () => {
  test('sizes each half to its own text rather than to a character count', () => {
    // `illiiil` and `passing` are both seven characters and not the same width.
    expect(widthOf('illiiil')).toBeLessThan(widthOf('passing'))
    expect(widthOf('WWW')).toBeGreaterThan(widthOf('iii'))

    const svg = renderBadge({ label: 'Build', state: stateFor('succeeded') })
    const width = Number(String(svg.match(/width="(\d+)"/)?.[1] ?? 0))

    // Both halves plus their padding, and nothing wider than the box it draws.
    expect(width).toBeGreaterThan(widthOf('Build') + widthOf('passing'))
    expect(svg).toContain('aria-label="Build: passing"')
  })

  test('says what a badge says rather than what the API says', () => {
    expect(stateFor('succeeded').message).toBe('passing')
    expect(stateFor('failed').message).toBe('failing')
    expect(stateFor('queued').message).toBe('pending')
    // Everything unknown is one word and one colour, including the states that
    // do not exist - a badge is not the place to discover a vocabulary.
    expect(stateFor('nonsense').message).toBe('unknown')
    expect(stateFor(null).message).toBe('unknown')
  })

  test('cannot be broken out of by a workflow name', () => {
    const svg = renderBadge({ label: '"><script>alert(1)</script>', state: stateFor('failed') })

    expect(svg).not.toContain('<script>')
    expect(svg).toContain('&lt;script&gt;')
    // The label is inside the title and the aria-label too, so escaping has to
    // hold in all three places.
    expect(svg.match(/<script>/g)).toBeNull()
  })
})

describe('the endpoint', () => {
  test('reports the newest finished run on the branch', async () => {
    if (!available)
      return

    await run('failed')
    await run('succeeded')

    const { status, body } = await badge(`owner=${created.handle}&repo=${created.publicName}`)

    expect(status).toBe(200)
    expect(body).toContain('passing')
    expect(body).toContain('Build')
  }, 120_000)

  test('and ignores the run in flight, which is not an answer to "is this branch good"', async () => {
    if (!available)
      return

    await run('running')

    const { body } = await badge(`owner=${created.handle}&repo=${created.publicName}`)

    expect(body).toContain('passing')
    expect(body).not.toContain('running')
  }, 120_000)

  test('is per branch, and a branch with no runs is unknown rather than green', async () => {
    if (!available)
      return

    await run('failed', 'release')

    const release = await badge(`owner=${created.handle}&repo=${created.publicName}&branch=release`)
    const nothing = await badge(`owner=${created.handle}&repo=${created.publicName}&branch=never-pushed`)

    expect(release.body).toContain('failing')
    expect(nothing.body).toContain('unknown')
  }, 120_000)

  test('answers a repeat ask with 304 and no body', async () => {
    if (!available)
      return

    const first = await badge(`owner=${created.handle}&repo=${created.publicName}`)

    expect(first.etag).toBeTruthy()
    expect(first.cache).toContain('max-age=60')

    const again = await badge(`owner=${created.handle}&repo=${created.publicName}`, { 'If-None-Match': first.etag })

    expect(again.status).toBe(304)
    expect(again.body).toBe('')

    // And a new run changes the tag, so the badge is never a minute stale about
    // something that already finished.
    await run('failed')

    const changed = await badge(`owner=${created.handle}&repo=${created.publicName}`, { 'If-None-Match': first.etag })

    expect(changed.status).toBe(200)
    expect(changed.body).toContain('failing')
  }, 120_000)

  test('says the same thing about a private repository as about one that does not exist', async () => {
    if (!available)
      return

    const secret = await badge(`owner=${created.handle}&repo=${created.privateName}`)
    const absent = await badge(`owner=${created.handle}&repo=${unique('nope')}`)

    // Same status, same word, same colour. Anything that differed would be a
    // way to ask this instance whether a repository is there.
    expect(secret.status).toBe(200)
    expect(absent.status).toBe(200)
    expect(secret.body).toContain('unknown')
    // Byte for byte, which is the only version of this assertion worth making:
    // a difference in width, colour or label is a difference somebody can
    // measure, and measuring it is how a private repository gets confirmed.
    expect(secret.body).toBe(absent.body)
  }, 120_000)

  test('is an SVG a browser will not sniff into something else', async () => {
    if (!available)
      return

    const answer = await fetch(`http://127.0.0.1:${port}/api/repos/badge?owner=${created.handle}&repo=${created.publicName}`)

    expect(String(answer.headers.get('content-type'))).toContain('image/svg+xml')
    expect(String(answer.headers.get('x-content-type-options'))).toBe('nosniff')
  }, 120_000)
})

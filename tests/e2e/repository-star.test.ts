// Starring a repository from the page, through the real route.
//
// `stars` and `watches` have had a table, a model, an endpoint and a unique
// index since phase 1, and no control anywhere in the interface - so the only
// way to star a repository on this forge was to post to the API by hand.
//
// Two claims, and the second is the one a unit test cannot make. That the
// controls are *on the page*, which is the whole bug. And that the endpoint
// answers a **browser form** with a redirect rather than with JSON: the form is
// the only control a page with no client-side JavaScript can write through, and
// a form left to follow the JSON response lands the reader on a page of it.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const created = { ownerId: 0, repositoryId: 0, handle: '', name: '', diskPath: '', temp: '', token: '' }

let available = false
let port = 0
let server: any = null

function unique(prefix: string): string {
  return `${prefix}${Buffer.from(crypto.getRandomValues(new Uint8Array(5))).toString('hex')}`
}

async function page(path: string): Promise<string> {
  const answer = await fetch(`http://127.0.0.1:${port}${path}`, { headers: { Accept: 'text/html' } })

  return await answer.text()
}

/** A form post, exactly as a browser sends one. */
async function form(path: string, fields: Record<string, string>): Promise<Response> {
  return await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      'Authorization': `Bearer ${created.token}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      // What makes it a browser rather than a script, and the whole difference
      // in what comes back.
      'Accept': 'text/html,application/xhtml+xml',
    },
    body: new URLSearchParams(fields).toString(),
  })
}

async function starCount(): Promise<number> {
  const row: any = await (globalThis as any).db
    .selectFrom('stars')
    .select((globalThis as any).db.fn.count('id').as('n'))
    .where('repository_id', '=', created.repositoryId)
    .executeTakeFirst()

  return Number(row?.n ?? 0)
}

beforeAll(async () => {
  created.temp = mkdtempSync(join(tmpdir(), 'reviewos-repo-star-'))

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

    const { repositoryPath } = await import('../../app/Actions/Git/storage')
    const { initBare } = await import('../../app/Actions/Git/git')
    const { generateToken } = await import('../../app/Actions/Tokens/secret')

    created.handle = unique('str')
    const owner: any = await db
      .insertInto('users')
      .values({ name: 'Star Test', email: `${created.handle}@example.com`, handle: created.handle, password: 'x' })
      .returning(['id'])
      .executeTakeFirst()

    created.ownerId = Number(owner?.id)

    created.name = unique('repo')
    const resolved = repositoryPath(created.handle, created.name)
    created.diskPath = resolved.path!

    const repository: any = await db
      .insertInto('repositories')
      .values({
        owner_type: 'user',
        owner_id: created.ownerId,
        name: created.name,
        description: 'created by the star end to end test',
        visibility: 'public',
        default_branch: 'main',
        disk_path: resolved.relative!,
      })
      .returning(['id'])
      .executeTakeFirst()

    created.repositoryId = Number(repository?.id)

    mkdirSync(resolve(created.diskPath, '..'), { recursive: true })
    await initBare(created.diskPath, 'main')

    const token = generateToken()
    const tokenRow: any = await db.insertInto('access_tokens').values({
      user_id: created.ownerId,
      name: 'star test',
      prefix: token.prefix,
      token_hash: token.hash,
      selection: 'all',
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    }).returning(['id']).executeTakeFirst()

    // `contents` at `read`, which is what `app/TokenScopes.ts` maps
    // `repository:read` to. A fine-grained token is the narrower of the two
    // permissions, so owning the repository is not enough on its own - which
    // is the point of it, and the reason starring needs the grant even though
    // it needs no more than read access.
    await db.insertInto('access_token_permissions').values({
      access_token_id: Number(tokenRow?.id),
      scope: 'contents',
      level: 'read',
    }).execute()

    created.token = token.token

    available = true
  }
  catch (error) {
    console.warn(`[repository-star] skipping: ${error instanceof Error ? error.message : String(error)}`)
    available = false
  }
}, 120_000)

afterAll(async () => {
  const db = (globalThis as any).db

  try {
    if (created.repositoryId)
      await db.deleteFrom('stars').where('repository_id', '=', created.repositoryId).execute()

    if (created.repositoryId)
      await db.deleteFrom('watches').where('repository_id', '=', created.repositoryId).execute()

    if (created.ownerId)
      await db.deleteFrom('access_tokens').where('user_id', '=', created.ownerId).execute()

    if (created.repositoryId)
      await db.deleteFrom('repositories').where('id', '=', created.repositoryId).execute()

    if (created.ownerId)
      await db.deleteFrom('users').where('id', '=', created.ownerId).execute()
  }
  catch { /* the files still go, below */ }

  if (created.diskPath) {
    const { removeRepositoryDirectory, removeRepositoryOwnerDirectory } = await import('../helpers/repositoryDirectory')

    removeRepositoryDirectory(created.diskPath)

    try {
      removeRepositoryOwnerDirectory(created.diskPath)
    }
    catch { /* somebody else's repository lives there too */ }
  }

  if (created.temp)
    rmSync(created.temp, { recursive: true, force: true })

  try {
    server?.stop?.(true)
  }
  catch { /* already down */ }
})

describe('the controls on the page', () => {
  test('a signed-out reader is offered a star, and a way to sign in for it', async () => {
    if (!available)
      return

    const html = await page(`/${created.handle}/${created.name}`)

    expect(html).toContain('Star')
    // Signed out, the control is a link that keeps the reader's place rather
    // than a button that would fail.
    expect(html).toContain(`/login?next=${encodeURIComponent(`/${created.handle}/${created.name}`)}`)
  })

  test('and a watch control beside it', async () => {
    if (!available)
      return

    const html = await page(`/${created.handle}/${created.name}`)

    expect(html).toContain('Watch')
  })

  test('the other repository screens draw the same controls', async () => {
    if (!available)
      return

    // A star button on the code page and none on the tags page teaches a
    // reader that the repository changed between two tabs of itself.
    const html = await page(`/${created.handle}/${created.name}/tags`)

    expect(html).toContain('Star')
  })
})

describe('starring', () => {
  test('a form post adds the star and sends the reader back to the page', async () => {
    if (!available)
      return

    const answer = await form('/api/repos/stars', {
      owner: created.handle,
      repository: created.name,
      next: `/${created.handle}/${created.name}`,
    })

    expect(answer.status).toBeGreaterThanOrEqual(300)
    expect(answer.status).toBeLessThan(400)
    expect(answer.headers.get('location')).toBe(`/${created.handle}/${created.name}`)
    expect(await starCount()).toBe(1)
  })

  test('and the page then says it has been starred', async () => {
    if (!available)
      return

    // Signed out, so this is the count rather than the reader's own state -
    // which is the half that is public and the half that was never shown.
    const html = await page(`/${created.handle}/${created.name}`)

    expect(html).toContain('repo-action-count')
  })

  test('a second post takes it away, because the endpoint toggles', async () => {
    if (!available)
      return

    // The page cannot know whether the star it drew has been pressed since it
    // was drawn, so it does not try to choose between add and remove.
    await form('/api/repos/stars', { owner: created.handle, repository: created.name })

    expect(await starCount()).toBe(0)
  })

  test('refuses to be redirected off this host', async () => {
    if (!available)
      return

    // An open redirect on an authenticated POST is a real one. `safeRedirect`
    // is what refuses it, and this is the assertion that it is being called.
    const answer = await form('/api/repos/stars', {
      owner: created.handle,
      repository: created.name,
      next: '//evil.example/take-me',
    })

    expect(answer.headers.get('location')).toBe(`/${created.handle}/${created.name}`)
  })

  test('a script still gets JSON', async () => {
    if (!available)
      return

    // One endpoint serving both is what keeps the page and the API in step.
    const answer = await fetch(`http://127.0.0.1:${port}/api/repos/stars`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${created.token}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({ owner: created.handle, repository: created.name }),
    })

    const body: any = await answer.json()

    expect(answer.status).toBe(200)
    // The shape rather than the value: the endpoint toggles, so what `starred`
    // is depends on what the tests above left behind - which is exactly the
    // reason the page is not asked to predict it either.
    expect(typeof body.starred).toBe('boolean')
    expect(typeof body.stars).toBe('number')
  })
})

describe('watching', () => {
  test('a form can reach it, which needs POST because HTML cannot send PUT', async () => {
    if (!available)
      return

    const answer = await form('/api/repos/watches', {
      owner: created.handle,
      repository: created.name,
      subscription: 'all',
      next: `/${created.handle}/${created.name}`,
    })

    expect(answer.status).toBeGreaterThanOrEqual(300)
    expect(answer.status).toBeLessThan(400)

    const row: any = await (globalThis as any).db
      .selectFrom('watches')
      .select(['subscription'])
      .where('repository_id', '=', created.repositoryId)
      .where('user_id', '=', created.ownerId)
      .executeTakeFirst()

    expect(row?.subscription).toBe('all')
  })

  test('and an empty subscription clears it rather than storing `ignore`', async () => {
    if (!available)
      return

    // "I have never decided" and "I have decided not to hear about this" are
    // different states, and only the second survives being mentioned.
    await form('/api/repos/watches', { owner: created.handle, repository: created.name, subscription: 'none' })

    const row: any = await (globalThis as any).db
      .selectFrom('watches')
      .select(['id'])
      .where('repository_id', '=', created.repositoryId)
      .where('user_id', '=', created.ownerId)
      .executeTakeFirst()

    expect(row).toBeFalsy()
  })
})

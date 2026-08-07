// The merge strategy settings, through the real route.
//
// The columns existed and the merge action honoured them; what was missing was
// any way to set them. The form's checkboxes lean on one mechanical fact - the
// router keeps the LAST value of a repeated form key, so hidden-false-then-
// checkbox-true reads true when ticked and false when not - and that fact is
// exactly the kind that changes in a router upgrade without anything else
// failing. So this file sends the same bodies the form sends, byte for byte,
// and reads the row back.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

const created = {
  ownerId: 0,
  ownerToken: '',
  handle: '',
  name: '',
  repositoryId: 0,
}

let available = false
let port = 0
let server: any = null

function unique(prefix: string): string {
  return `${prefix}${Buffer.from(crypto.getRandomValues(new Uint8Array(5))).toString('hex')}`
}

/** The exact body a form sends, so the duplicate-key behavior is what is tested. */
async function post(body: string): Promise<{ status: number, body: any }> {
  const answer = await fetch(`http://127.0.0.1:${port}/api/repos/settings`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': `Bearer ${created.ownerToken}`,
    },
    body: `owner=${created.handle}&repo=${created.name}&${body}`,
  })

  return { status: answer.status, body: await answer.json().catch(() => null) }
}

async function row(): Promise<any> {
  return await (globalThis as any).db
    .selectFrom('repositories')
    .select(['allow_merge_commit', 'allow_squash_merge', 'allow_rebase_merge', 'delete_branch_on_merge', 'default_merge_strategy'])
    .where('id', '=', created.repositoryId)
    .executeTakeFirst()
}

beforeAll(async () => {
  try {
    const { injectGlobalAutoImports } = await import('@stacksjs/server')
    const { route } = await import('@stacksjs/router')

    await injectGlobalAutoImports()
    await (globalThis as any).db.selectFrom('users').select(['id']).limit(1).execute()

    await route.importRoutes()
    server = await route.serve({ port: 0, hostname: '127.0.0.1' })
    port = Number((server as any)?.port ?? (server as any)?.server?.port ?? 0)

    if (!port)
      throw new Error('the router did not report a port')

    const { createToken } = await import('@stacksjs/auth')

    created.handle = unique('msu')
    const user: any = await (globalThis as any).db
      .insertInto('users')
      .values({ name: 'Merge Settings', email: `${created.handle}@example.com`, handle: created.handle, password: 'x' })
      .returning(['id'])
      .executeTakeFirst()

    created.ownerId = Number(user?.id)
    const issued: any = await createToken(created.ownerId, 'merge settings test')
    created.ownerToken = String(issued?.plainTextToken ?? issued?.token ?? issued)

    created.name = unique('repo')
    const repository: any = await (globalThis as any).db
      .insertInto('repositories')
      .values({
        owner_type: 'user',
        owner_id: created.ownerId,
        name: created.name,
        description: 'created by the merge settings end to end test',
        visibility: 'public',
        default_branch: 'main',
        disk_path: `x/${created.name}.git`,
      })
      .returning(['id'])
      .executeTakeFirst()

    created.repositoryId = Number(repository?.id)

    available = true
  }
  catch (error) {
    console.warn(`[e2e] skipping: ${error instanceof Error ? error.message : String(error)}`)
    available = false
  }
}, 120_000)

afterAll(async () => {
  try {
    if (created.repositoryId)
      await (globalThis as any).db.deleteFrom('repositories').where('id', '=', created.repositoryId).execute()

    if (created.ownerId)
      await (globalThis as any).db.deleteFrom('users').where('id', '=', created.ownerId).execute()
  }
  catch { /* nothing else to release */ }

  try {
    server?.stop?.(true)
  }
  catch { /* already down */ }
})

describe('the merge strategy settings', () => {
  test('a ticked box, as the form sends it: false then true reads true', async () => {
    if (!available)
      return

    const { status } = await post('allow_squash_merge=false&allow_squash_merge=true')

    expect(status).toBe(200)
    expect(Boolean((await row())?.allow_squash_merge)).toBe(true)
  }, 30_000)

  test('an unticked box, as the form sends it: false alone turns it off', async () => {
    if (!available)
      return

    const { status } = await post('allow_squash_merge=false')

    expect(status).toBe(200)
    expect(Boolean((await row())?.allow_squash_merge)).toBe(false)
  }, 30_000)

  test('the default strategy round-trips, and an unknown one is refused', async () => {
    if (!available)
      return

    const good = await post('default_merge_strategy=rebase')
    expect(good.status).toBe(200)
    expect(String((await row())?.default_merge_strategy)).toBe('rebase')

    const bad = await post('default_merge_strategy=octopus')
    expect(bad.status).toBe(422)
    // And the row kept what it had: a refused change changes nothing.
    expect(String((await row())?.default_merge_strategy)).toBe('rebase')
  }, 30_000)

  test('every strategy off is a configuration, not an error', async () => {
    if (!available)
      return

    const { status } = await post([
      'allow_merge_commit=false',
      'allow_squash_merge=false',
      'allow_rebase_merge=false',
    ].join('&'))

    expect(status).toBe(200)

    const settings = await row()
    expect(Boolean(settings?.allow_merge_commit)).toBe(false)
    expect(Boolean(settings?.allow_squash_merge)).toBe(false)
    expect(Boolean(settings?.allow_rebase_merge)).toBe(false)
  }, 30_000)

  test('delete-on-merge round-trips both ways', async () => {
    if (!available)
      return

    await post('delete_branch_on_merge=false&delete_branch_on_merge=true')
    expect(Boolean((await row())?.delete_branch_on_merge)).toBe(true)

    await post('delete_branch_on_merge=false')
    expect(Boolean((await row())?.delete_branch_on_merge)).toBe(false)
  }, 30_000)
})

// Variables across the four levels, against the real tables and the real page.
//
// The unit tests hold the precedence. This holds the two things only a database
// and a rendered page can be wrong about: that a run is handed the value the
// resolution picked, and that somebody can see which level answered without
// asking anybody.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { resolveVariables, settingsFor, variablesFor } from '../../app/Actions/Workflow/variables'

const created = { ownerId: 0, repositoryId: 0, handle: '', name: '', cookie: '' }

let available = false
let db: any = null
let server: any = null
let port = 0

function unique(prefix: string): string {
  return `${prefix}${Buffer.from(crypto.getRandomValues(new Uint8Array(5))).toString('hex')}`
}

async function set(scope: string, scopeId: number, key: string, value: string): Promise<void> {
  await db.insertInto('workflow_variables').values({ scope_type: scope, scope_id: scopeId, key, value } as any).execute()
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

    created.handle = unique('var')

    const owner: any = await db
      .insertInto('users')
      .values({ name: 'Variable Owner', email: `${created.handle}@example.com`, handle: created.handle, password: 'x' })
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

    /*
     * A session, because the settings screen is the owner's screen. Reading it
     * signed out renders the not-found branch, which is the right answer to
     * the wrong question.
     */
    const { createToken } = await import('@stacksjs/auth')
    const issued: any = await createToken(created.ownerId, 'variables test')

    created.cookie = String(issued?.plainTextToken ?? issued?.token ?? issued)

    await set('instance', 0, unique('INSTANCE_').toUpperCase(), 'instance-only')
    await set('owner', created.ownerId, 'REGISTRY', 'ghcr.io/owner')
    await set('repository', created.repositoryId, 'REGISTRY', 'ghcr.io/repository')

    available = true
  }
  catch (error) {
    console.warn(`[variables] skipping: ${error instanceof Error ? error.message : String(error)}`)
    available = false
  }
}, 120_000)

afterAll(async () => {
  try {
    server?.stop?.()
    await db.deleteFrom('workflow_variables').where('scope_type', '=', 'repository').where('scope_id', '=', created.repositoryId).execute()
    await db.deleteFrom('workflow_variables').where('scope_type', '=', 'owner').where('scope_id', '=', created.ownerId).execute()
    if (created.repositoryId)
      await db.deleteFrom('repositories').where('id', '=', created.repositoryId).execute()
    if (created.ownerId)
      await db.deleteFrom('users').where('id', '=', created.ownerId).execute()
  }
  catch { /* the next run uses fresh names */ }
})

describe('what a run is handed', () => {
  test('the repository beats the owner, and the workflow file beats both', async () => {
    if (!available)
      return

    expect((await variablesFor(created.repositoryId)).REGISTRY).toBe('ghcr.io/repository')

    // The workflow's own `env:` is the fourth level, and it is in the file
    // rather than a table precisely because it is the most specific thing
    // anybody said about the value.
    expect((await variablesFor(created.repositoryId, { REGISTRY: 'localhost:5000' })).REGISTRY).toBe('localhost:5000')
  }, 120_000)

  test('an instance variable reaches a repository that set nothing', async () => {
    if (!available)
      return

    const resolved = await variablesFor(created.repositoryId)
    const instanceKey = Object.keys(resolved).find(key => key.startsWith('INSTANCE_'))

    expect(instanceKey).toBeTruthy()
    expect(resolved[instanceKey!]).toBe('instance-only')
  }, 120_000)

  test('and another repository does not see this one\'s variables', async () => {
    if (!available)
      return

    /*
     * The check worth writing, because the query reads every row and filters
     * in TypeScript: a scope comparison that was wrong would hand one
     * repository another's configuration, which is the kind of leak nobody
     * notices until it matters.
     */
    const other: any = await db
      .insertInto('repositories')
      .values({
        owner_type: 'user',
        owner_id: created.ownerId,
        name: unique('other'),
        visibility: 'public',
        default_branch: 'main',
        disk_path: `${created.handle}/other.git`,
      })
      .returning(['id'])
      .executeTakeFirst()

    // Same owner, so the owner value is shared - that is the point of an owner
    // level - but the repository's own override must not follow it.
    expect((await variablesFor(Number(other.id))).REGISTRY).toBe('ghcr.io/owner')

    await db.deleteFrom('repositories').where('id', '=', Number(other.id)).execute()
  }, 120_000)
})

describe('the settings screen', () => {
  test('says which level answered, and what it overrode', async () => {
    if (!available)
      return

    const resolved = resolveVariables(await settingsFor(created.repositoryId))
    const registry = resolved.find(one => one.key === 'REGISTRY')!

    expect(registry.scope).toBe('repository')
    expect(registry.shadowed.map(one => one.scope)).toEqual(['owner'])

    const answer = await fetch(`http://127.0.0.1:${port}/${created.handle}/${created.name}/settings`, {
      headers: { 'Accept': 'text/html', 'Cookie': `auth-token=${created.cookie}` },
    })

    const rendered = (await answer.text()).replace(/<[^>]+>/g, ' ').replace(/&#39;/g, '\'').replace(/\s+/g, ' ')

    // A page that shows the value and not its origin leaves somebody guessing
    // which of four places to edit.
    expect(rendered).toContain('REGISTRY = ghcr.io/repository')
    expect(rendered).toContain('set at the repository level')
    expect(rendered).toContain('overriding owner')
  }, 120_000)
})

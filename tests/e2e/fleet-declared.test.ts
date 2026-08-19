// The fleet, declared in a file.
//
// A fleet that cannot be declared is a fleet that drifts: a pool created during
// an incident, a queue paused on a Friday and never resumed, and six months
// later nobody can say what the intended shape was. The two properties that
// make a convergence tool safe to run are the ones tested here - applying twice
// does nothing the second time, and nothing is ever removed.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { applyFleet, planFleet, readDeclaration } from '../../app/Actions/Runner/declare'

const created = { ownerId: 0, repositoryId: 0, handle: '', name: '', poolIds: [] as number[] }

let available = false
let db: any = null

function unique(prefix: string): string {
  return `${prefix}${Buffer.from(crypto.getRandomValues(new Uint8Array(5))).toString('hex')}`
}

function declaration(name: string, repository: string): string {
  return [
    'pools:',
    `  - name: ${name}`,
    '    description: machines with the release credentials',
    '    require_signed_steps: true',
    '    queues:',
    '      - name: linux-x64',
    '      - name: macos-arm64',
    '        state: paused',
    '        reason: waiting for the new mac mini',
    '    repositories:',
    `      - ${repository}`,
  ].join('\n')
}

beforeAll(async () => {
  try {
    const { injectGlobalAutoImports } = await import('@stacksjs/server')

    await injectGlobalAutoImports()
    db = (globalThis as any).db
    await db.selectFrom('users').select(['id']).limit(1).execute()

    created.handle = unique('fleetdec')

    const owner: any = await db.insertInto('users')
      .values({ name: 'Fleet Declared', email: `${created.handle}@example.com`, handle: created.handle, password: 'x' })
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
    available = true
  }
  catch (error) {
    console.warn(`[fleet-declared] skipping: ${error instanceof Error ? error.message : String(error)}`)
    available = false
  }
}, 120_000)

afterAll(async () => {
  try {
    for (const id of created.poolIds) {
      await db.deleteFrom('runner_pool_repositories').where('runner_pool_id', '=', id).execute().catch(() => {})
      await db.deleteFrom('runner_queues').where('runner_pool_id', '=', id).execute().catch(() => {})
      await db.deleteFrom('runner_pools').where('id', '=', id).execute().catch(() => {})
    }

    if (created.repositoryId)
      await db.deleteFrom('repositories').where('id', '=', created.repositoryId).execute().catch(() => {})

    if (created.ownerId)
      await db.deleteFrom('users').where('id', '=', created.ownerId).execute().catch(() => {})
  }
  catch { /* the next run uses fresh names */ }
})

describe('a declared fleet', () => {
  test('plans before it touches anything', async () => {
    if (!available)
      return

    const name = unique('Pool ')
    const { fleet, error } = readDeclaration(declaration(name, `${created.handle}/${created.name}`))

    expect(error).toBeNull()

    const plan = await planFleet(fleet)

    expect(plan.changes.map(one => one.what)).toContain('pool')
    expect(plan.changes.filter(one => one.what === 'queue')).toHaveLength(2)

    // And nothing happened: a preview that could alter something is a tool
    // nobody runs on the day it matters.
    const pools = await db.selectFrom('runner_pools').select(['id']).where('name', '=', name).execute()

    expect(pools).toEqual([])
  }, 120_000)

  test('converges the instance to the file, and says what it did', async () => {
    if (!available)
      return

    const name = unique('Pool ')
    const { fleet } = readDeclaration(declaration(name, `${created.handle}/${created.name}`))

    const applied = await applyFleet(fleet)

    expect(applied.changes.length).toBeGreaterThan(0)

    const pool: any = await db.selectFrom('runner_pools').select(['id', 'require_signed_steps']).where('name', '=', name).executeTakeFirst()

    expect(pool).toBeTruthy()
    created.poolIds.push(Number(pool.id))

    expect(Boolean(pool.require_signed_steps)).toBe(true)

    const queues = await db.selectFrom('runner_queues').select(['name', 'state', 'paused_reason']).where('runner_pool_id', '=', Number(pool.id)).orderBy('name').execute()

    expect(queues.map((one: any) => String(one.name))).toEqual(['linux-x64', 'macos-arm64'])

    // A queue declared paused is one nobody has to remember to drain, and the
    // reason travels with it.
    const paused = queues.find((one: any) => String(one.name) === 'macos-arm64')

    expect(String(paused.state)).toBe('paused')
    expect(String(paused.paused_reason)).toContain('mac mini')

    const assigned = await db.selectFrom('runner_pool_repositories').select(['repository_id']).where('runner_pool_id', '=', Number(pool.id)).execute()

    expect(assigned.map((one: any) => Number(one.repository_id))).toEqual([created.repositoryId])
  }, 120_000)

  test('and applying it again does nothing at all', async () => {
    if (!available)
      return

    const pool: any = await db.selectFrom('runner_pools').select(['id', 'name']).where('id', '=', created.poolIds[0]).executeTakeFirst()
    const { fleet } = readDeclaration(declaration(String(pool.name), `${created.handle}/${created.name}`))

    const again = await applyFleet(fleet)

    // Idempotent by construction: everything is "make sure this looks like
    // this", which is what makes the file safe to run from a pipeline.
    expect(again.changes).toEqual([])

    const queues = await db.selectFrom('runner_queues').select(['id']).where('runner_pool_id', '=', Number(pool.id)).execute()

    expect(queues).toHaveLength(2)
  }, 120_000)

  test('and never removes what the file does not mention', async () => {
    if (!available)
      return

    const pool: any = await db.selectFrom('runner_pools').select(['id', 'name']).where('id', '=', created.poolIds[0]).executeTakeFirst()

    // A file naming one queue where the instance has two.
    const partial = readDeclaration([
      'pools:',
      `  - name: ${String(pool.name)}`,
      '    queues:',
      '      - name: linux-x64',
    ].join('\n'))

    const plan = await applyFleet(partial.fleet)

    /*
     * The failure mode of a convergence tool has to be "nothing happened"
     * rather than "everything went away": a partial file applied on the wrong
     * afternoon would otherwise drain the fleet.
     */
    expect(plan.drift.some(one => one.subject.includes('macos-arm64'))).toBe(true)

    const queues = await db.selectFrom('runner_queues').select(['id']).where('runner_pool_id', '=', Number(pool.id)).execute()

    expect(queues).toHaveLength(2)
  }, 120_000)
})

// Calling a workflow that lives in another repository.
//
// The unit tests hold the policy. This holds what only the database can be
// wrong about: that the call resolves to the *other* repository's version, that
// the same owner works with no configuration, and that the two refusals - a
// different owner under the narrow scope, and a private repository under the
// wide one - are refusals rather than accidents.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { resolveCall } from '../../app/Actions/Workflow/reusable'
import { syncWorkflowFile } from '../../app/Actions/Workflow/sync'

const created = {
  organizationId: 0,
  strangerId: 0,
  callerId: 0,
  sharedId: 0,
  strangerPublicId: 0,
  strangerPrivateId: 0,
  organization: '',
  stranger: '',
}

let available = false
let db: any = null

const SHARED = `name: Shared build
on:
  workflow_call:
    inputs:
      target:
        required: true
        type: string
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: ./build \${{ inputs.target }}
`

function unique(prefix: string): string {
  return `${prefix}${Buffer.from(crypto.getRandomValues(new Uint8Array(5))).toString('hex')}`
}

/** A repository owned by one of the two owners, with a workflow in it. */
async function repository(ownerType: string, ownerId: number, visibility: string, source?: string): Promise<number> {
  const name = unique('repo')

  const row: any = await db
    .insertInto('repositories')
    .values({
      owner_type: ownerType,
      owner_id: ownerId,
      name,
      visibility,
      default_branch: 'main',
      disk_path: `${unique('own')}/${name}.git`,
    })
    .returning(['id'])
    .executeTakeFirst()

  const id = Number(row?.id)

  if (source) {
    await syncWorkflowFile({
      repositoryId: id,
      ownerType: ownerType === 'organization' ? 'organization' : 'user',
      ownerId,
      path: '.github/workflows/shared.yml',
      source,
      sha: 'a'.repeat(40),
    })
  }

  return id
}

beforeAll(async () => {
  try {
    const { injectGlobalAutoImports } = await import('@stacksjs/server')

    await injectGlobalAutoImports()
    db = (globalThis as any).db
    await db.selectFrom('users').select(['id']).limit(1).execute()

    created.organization = unique('org')
    created.stranger = unique('str')

    const organization: any = await db
      .insertInto('organizations')
      .values({ name: 'Acme', handle: created.organization })
      .returning(['id'])
      .executeTakeFirst()

    created.organizationId = Number(organization?.id)

    const stranger: any = await db
      .insertInto('organizations')
      .values({ name: 'Stranger', handle: created.stranger })
      .returning(['id'])
      .executeTakeFirst()

    created.strangerId = Number(stranger?.id)

    created.callerId = await repository('organization', created.organizationId, 'public')
    created.sharedId = await repository('organization', created.organizationId, 'private', SHARED)
    created.strangerPublicId = await repository('organization', created.strangerId, 'public', SHARED)
    created.strangerPrivateId = await repository('organization', created.strangerId, 'private', SHARED)

    available = true
  }
  catch (error) {
    console.warn(`[cross-repository-calls] skipping: ${error instanceof Error ? error.message : String(error)}`)
    available = false
  }
}, 120_000)

afterAll(async () => {
  try {
    for (const id of [created.callerId, created.sharedId, created.strangerPublicId, created.strangerPrivateId]) {
      if (id)
        await db.deleteFrom('repositories').where('id', '=', id).execute()
    }

    for (const id of [created.organizationId, created.strangerId]) {
      if (id)
        await db.deleteFrom('organizations').where('id', '=', id).execute()
    }
  }
  catch { /* the next run uses fresh names */ }
})

/** The name of a repository, since the fixture generates them. */
async function nameOf(id: number): Promise<string> {
  const row: any = await db.selectFrom('repositories').select(['name']).where('id', '=', id).executeTakeFirst()

  return String(row?.name ?? '')
}

describe('the same owner', () => {
  test('is callable with no configuration, private or not', async () => {
    if (!available)
      return

    /*
     * The case people actually have: an organization calling its own shared
     * workflow. A repository under one owner can already be read by anybody
     * who can read that owner, so nothing needs widening for this to be safe.
     */
    const resolved = await resolveCall(
      created.callerId,
      `${created.organization}/${await nameOf(created.sharedId)}/.github/workflows/shared.yml@main`,
      { target: 'production' },
    )

    expect(resolved.ok).toBe(true)
    expect(resolved.target?.path).toBe('.github/workflows/shared.yml')

    // And the inputs it declared are checked, the same as a local call.
    expect(resolved.inputs.target).toBe('production')
  }, 120_000)

  test('and a missing required input is refused, not defaulted', async () => {
    if (!available)
      return

    const resolved = await resolveCall(
      created.callerId,
      `${created.organization}/${await nameOf(created.sharedId)}/.github/workflows/shared.yml@main`,
      {},
    )

    expect(resolved.ok).toBe(false)
    expect(String(resolved.error)).toContain('do not match what it declares')
  }, 120_000)
})

describe('another owner', () => {
  test('is refused under the default scope, naming the setting', async () => {
    if (!available)
      return

    const resolved = await resolveCall(
      created.callerId,
      `${created.stranger}/${await nameOf(created.strangerPublicId)}/.github/workflows/shared.yml@main`,
      { target: 'production' },
    )

    expect(resolved.ok).toBe(false)
    // An administrator reading a failed run should learn which setting decides,
    // rather than concluding the feature is broken.
    expect(String(resolved.error)).toContain('workflow_call_scope')
  }, 120_000)

  test('is callable when an administrator widened it', async () => {
    if (!available)
      return

    const resolved = await resolveCall(
      created.callerId,
      `${created.stranger}/${await nameOf(created.strangerPublicId)}/.github/workflows/shared.yml@main`,
      { target: 'production' },
      { scope: 'instance' },
    )

    expect(resolved.ok).toBe(true)
  }, 120_000)

  test('but its private repository never is', async () => {
    if (!available)
      return

    /*
     * Even with the wide scope. Its jobs would run against a definition nobody
     * outside can read, and "I cannot see the file that ran" is the shape of a
     * supply-chain problem rather than a convenience.
     */
    const resolved = await resolveCall(
      created.callerId,
      `${created.stranger}/${await nameOf(created.strangerPrivateId)}/.github/workflows/shared.yml@main`,
      { target: 'production' },
      { scope: 'instance' },
    )

    expect(resolved.ok).toBe(false)
    expect(String(resolved.error)).toContain('never callable')
  }, 120_000)
})

describe('a reference that resolves to nothing', () => {
  test('says which half was wrong', async () => {
    if (!available)
      return

    const noOwner = await resolveCall(created.callerId, 'nobody/nothing/.github/workflows/x.yml@main', {})

    expect(String(noOwner.error)).toContain('no owner called')

    const noRepository = await resolveCall(
      created.callerId,
      `${created.organization}/nothing/.github/workflows/x.yml@main`,
      {},
    )

    expect(String(noRepository.error)).toContain('no repository called')
  }, 120_000)
})

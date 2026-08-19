// Owner-managed workflow templates, applied as real commits.
//
// The governance side of reuse: a reusable workflow is called by a repository
// that decided to call it, and a template is what an organization puts in front
// of every repository that has not decided anything yet.
//
// Two behaviours carry the feature, and both are refusals. A template that does
// not parse is refused when it is published - copied into repositories by
// people who did not write it, one that fails on their first push is a support
// ticket from somebody with no way to know where the file came from. And
// applying never overwrites, because a template that silently replaced a
// repository's own workflow is governance deleting the exception somebody made
// on purpose.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { applyTemplate, publishTemplate, templatesFor } from '../../app/Actions/Workflow/ownerTemplates'
import { removeRepositoryDirectory } from '../helpers/repositoryDirectory'

const created = { ownerId: 0, repositoryId: 0, handle: '', name: '', diskPath: '', templateId: 0 }

let available = false
let db: any = null

const TEMPLATE = `name: CI

on:
  push:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: make test
`

function unique(prefix: string): string {
  return `${prefix}${Buffer.from(crypto.getRandomValues(new Uint8Array(5))).toString('hex')}`
}

const author = { name: 'Template Owner', email: 'owner@example.com' }

beforeAll(async () => {
  try {
    const { injectGlobalAutoImports } = await import('@stacksjs/server')

    await injectGlobalAutoImports()
    db = (globalThis as any).db
    await db.selectFrom('users').select(['id']).limit(1).execute()

    const { repositoryPath } = await import('../../app/Actions/Git/storage')
    const { initBare } = await import('../../app/Actions/Git/git')

    created.handle = unique('tpl')

    const owner: any = await db
      .insertInto('users')
      .values({ name: 'Template Owner', email: `${created.handle}@example.com`, handle: created.handle, password: 'x' })
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
        visibility: 'public',
        default_branch: 'main',
        disk_path: resolved.relative!,
      })
      .returning(['id'])
      .executeTakeFirst()

    created.repositoryId = Number(repository?.id)

    mkdirSync(resolve(created.diskPath, '..'), { recursive: true })
    await initBare(created.diskPath, 'main')

    available = true
  }
  catch (error) {
    console.warn(`[templates] skipping: ${error instanceof Error ? error.message : String(error)}`)
    available = false
  }
}, 120_000)

afterAll(async () => {
  try {
    await db.deleteFrom('workflow_templates').where('owner_id', '=', created.ownerId).execute()
    if (created.repositoryId)
      await db.deleteFrom('repositories').where('id', '=', created.repositoryId).execute()
    if (created.ownerId)
      await db.deleteFrom('users').where('id', '=', created.ownerId).execute()
  }
  catch { /* the next run uses fresh names */ }

  removeRepositoryDirectory(created.diskPath)
})

describe('publishing', () => {
  test('a workflow this instance can run is accepted', async () => {
    if (!available)
      return

    const outcome = await publishTemplate({
      ownerType: 'user',
      ownerId: created.ownerId,
      slug: 'ci',
      name: 'Continuous integration',
      description: 'Run make test on every push to main.',
      path: '.github/workflows/ci.yml',
      source: TEMPLATE,
      userId: created.ownerId,
    })

    expect(outcome.ok).toBe(true)
    created.templateId = (outcome as any).id

    expect((await templatesFor('user', created.ownerId)).map((one: any) => one.slug)).toEqual(['ci'])
  }, 120_000)

  test('and one that does not parse is refused, with the lines that are wrong', async () => {
    if (!available)
      return

    /*
     * The whole point of validating here rather than at apply time: the author
     * is looking at it now, and the person who applies it next month has no
     * way to know the file came from a template at all.
     */
    const outcome = await publishTemplate({
      ownerType: 'user',
      ownerId: created.ownerId,
      slug: 'broken',
      name: 'Broken',
      description: '',
      path: '.github/workflows/broken.yml',
      source: 'name: Broken\njobs:\n  build:\n    steps: []\n',
      userId: created.ownerId,
    })

    expect(outcome.ok).toBe(false)
    expect((outcome as any).problems.length).toBeGreaterThan(0)
    expect((await templatesFor('user', created.ownerId)).map((one: any) => one.slug)).not.toContain('broken')
  }, 120_000)

  test('and a second publish of the same slug replaces it rather than duplicating', async () => {
    if (!available)
      return

    const again = await publishTemplate({
      ownerType: 'user',
      ownerId: created.ownerId,
      slug: 'ci',
      name: 'Continuous integration',
      description: 'Updated.',
      path: '.github/workflows/ci.yml',
      source: TEMPLATE,
      userId: created.ownerId,
    })

    expect(again.ok).toBe(true)
    expect((await templatesFor('user', created.ownerId))).toHaveLength(1)
  }, 120_000)
})

describe('applying', () => {
  test('writes a commit on the branch, and registers the workflow', async () => {
    if (!available)
      return

    const outcome = await applyTemplate({
      repositoryId: created.repositoryId,
      ownerHandle: created.handle,
      repositoryName: created.name,
      templateId: created.templateId,
      author,
    })

    expect(outcome.ok).toBe(true)
    expect((outcome as any).branch).toBe('main')
    expect(String((outcome as any).sha)).toMatch(/^[0-9a-f]{40}$/)

    const { runGit } = await import('../../app/Actions/Git/git')
    const shown = await runGit(created.diskPath, ['show', `main:${(outcome as any).path}`])

    // The file is really there, on the branch, with the template's contents.
    expect(shown.stdout).toContain('make test')

    /*
     * And it is a workflow rather than a file. This commit was written by the
     * instance, so no push hook fires - a template that landed as text nothing
     * had read would not exist until somebody happened to push again.
     */
    expect((outcome as any).workflowId).toBeGreaterThan(0)

    const workflows: any[] = await db
      .selectFrom('workflows')
      .select(['path'])
      .where('repository_id', '=', created.repositoryId)
      .execute()

    expect(workflows.map(one => String(one.path))).toContain('.github/workflows/ci.yml')
  }, 120_000)

  test('and refuses to overwrite what is already there', async () => {
    if (!available)
      return

    /*
     * Governance deleting the exception somebody made on purpose is the
     * failure worth refusing. `overwrite` exists for when replacing is meant.
     */
    const second = await applyTemplate({
      repositoryId: created.repositoryId,
      ownerHandle: created.handle,
      repositoryName: created.name,
      templateId: created.templateId,
      author,
    })

    expect(second.ok).toBe(false)
    expect((second as any).status).toBe(409)
    expect(String((second as any).reason)).toContain('already exists')

    const forced = await applyTemplate({
      repositoryId: created.repositoryId,
      ownerHandle: created.handle,
      repositoryName: created.name,
      templateId: created.templateId,
      overwrite: true,
      author,
    })

    expect(forced.ok).toBe(true)
  }, 120_000)

  test('and a template belonging to somebody else is refused', async () => {
    if (!available)
      return

    const stranger: any = await db
      .insertInto('users')
      .values({ name: 'Stranger', email: `${unique('str')}@example.com`, handle: unique('str'), password: 'x' })
      .returning(['id'])
      .executeTakeFirst()

    const theirs = await publishTemplate({
      ownerType: 'user',
      ownerId: Number(stranger.id),
      slug: 'ci',
      name: 'Theirs',
      description: '',
      path: '.github/workflows/theirs.yml',
      source: TEMPLATE,
      userId: Number(stranger.id),
    })

    // A template is a statement about how *this* owner builds things. Applying
    // across owners would make it a shared library with none of the versioning
    // a library needs.
    const outcome = await applyTemplate({
      repositoryId: created.repositoryId,
      ownerHandle: created.handle,
      repositoryName: created.name,
      templateId: (theirs as any).id,
      author,
    })

    expect(outcome.ok).toBe(false)
    expect((outcome as any).status).toBe(403)

    await db.deleteFrom('workflow_templates').where('owner_id', '=', Number(stranger.id)).execute()
    await db.deleteFrom('users').where('id', '=', Number(stranger.id)).execute()
  }, 120_000)
})

/**
 * What a `#number` can point at.
 *
 * `referencedNumbers` is already covered in `tests/unit/cross-references.test.ts`,
 * and it only reads text. What was never covered is the half that touches the
 * database: turning those numbers into the rows they name. That half resolved
 * against `issues` alone and branched on `issues.is_pull_request`, which is the
 * GitHub shape - a pull request there *is* an issue row - and is not this
 * schema. Nothing writes an `issues` row for a pull request here, so
 * `is_pull_request` is false on every row, every reference naming a change
 * found no target, and the function returned an empty array without recording
 * anything or reporting a reason.
 *
 * So these tests are about the resolution, not the scanning. The first one
 * fails against that version; the rest pin the things that had to change with
 * it.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

const created = { ownerId: 0, repositoryId: 0, handle: '', name: '', issueId: 0, issueNumber: 0, pullId: 0, pullNumber: 0 }

let available = false
let db: any = null
let recordCrossReferences: any = null

function unique(prefix: string): string {
  return `${prefix}${Buffer.from(crypto.getRandomValues(new Uint8Array(5))).toString('hex')}`
}

/** The `referenced` entries sitting on one subject, which is the incoming half. */
async function referencesOn(type: 'issue' | 'pull_request', id: number): Promise<any[]> {
  return await db
    .selectFrom('timeline_entries')
    .select(['subject_type', 'subject_id', 'reference_number'])
    .where('kind', '=', 'referenced')
    .where('subject_type', '=', type)
    .where('subject_id', '=', id)
    .execute()
}

beforeAll(async () => {
  try {
    const { injectGlobalAutoImports } = await import('@stacksjs/server')
    await injectGlobalAutoImports()
    db = (globalThis as any).db
    await db.selectFrom('users').select(['id']).limit(1).execute()

    recordCrossReferences = (await import('../../app/Actions/Issue/crossReferences')).recordCrossReferences

    created.handle = unique('xref')
    const owner: any = await db
      .insertInto('users')
      .values({ name: 'Xref', email: `${created.handle}@example.com`, handle: created.handle, password: 'x' })
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
        description: 'created by the cross-reference targets end to end test',
        visibility: 'public',
        default_branch: 'main',
        disk_path: `${created.handle}/${created.name}.git`,
      })
      .returning(['id'])
      .executeTakeFirst()
    created.repositoryId = Number(repository?.id)

    /*
     * One sequence over both, as `allocateNumber` would hand them out, because
     * `(repository_id, number)` is unique per table and the two tables share
     * one sequence per repository. Numbering them 1 and 2 also means neither
     * test can pass by finding the other kind under the same number.
     */
    created.issueNumber = 1
    const issue: any = await db
      .insertInto('issues')
      .values({
        repository_id: created.repositoryId,
        number: created.issueNumber,
        title: 'an issue something else will refer to',
        author_id: created.ownerId,
        state: 'open',
      })
      .returning(['id'])
      .executeTakeFirst()
    created.issueId = Number(issue?.id)

    created.pullNumber = 2
    const pull: any = await db
      .insertInto('pull_requests')
      .values({
        repository_id: created.repositoryId,
        number: created.pullNumber,
        title: 'a change something else will refer to',
        author_id: created.ownerId,
        state: 'open',
        head_branch: 'work',
        base_branch: 'main',
        head_sha: 'a'.repeat(40),
        base_sha: 'b'.repeat(40),
      })
      .returning(['id'])
      .executeTakeFirst()
    created.pullId = Number(pull?.id)

    available = Boolean(created.issueId && created.pullId)
  }
  catch {
    available = false
  }
})

afterAll(async () => {
  if (!db || !created.repositoryId)
    return

  await db.deleteFrom('timeline_entries').where('subject_id', 'in', [created.issueId, created.pullId]).execute()
  await db.deleteFrom('pull_requests').where('repository_id', '=', created.repositoryId).execute()
  await db.deleteFrom('issues').where('repository_id', '=', created.repositoryId).execute()
  await db.deleteFrom('repositories').where('id', '=', created.repositoryId).execute()
  await db.deleteFrom('users').where('id', '=', created.ownerId).execute()

  // No directory to remove: this test never puts the repository on disk,
  // because resolving a reference reads rows and never touches a tree.
})

describe('a reference that names a pull request', () => {
  test('records on the pull request, not nowhere', async () => {
    if (!available)
      return

    const recorded = await recordCrossReferences(
      { subject: { type: 'issue', id: created.issueId }, number: created.issueNumber, repositoryId: created.repositoryId },
      created.ownerId,
      `this is handled by #${created.pullNumber}`,
    )

    // The number it resolved, which is what a caller reports back.
    expect(recorded).toEqual([created.pullNumber])

    // And the entry on the other end, which is the point of the feature.
    const entries = await referencesOn('pull_request', created.pullId)
    expect(entries).toHaveLength(1)
    expect(Number(entries[0].reference_number)).toBe(created.issueNumber)
  })

  test('and a second pass over the same text records it once', async () => {
    if (!available)
      return

    await recordCrossReferences(
      { subject: { type: 'issue', id: created.issueId }, number: created.issueNumber, repositoryId: created.repositoryId },
      created.ownerId,
      `this is handled by #${created.pullNumber}`,
    )

    expect(await referencesOn('pull_request', created.pullId)).toHaveLength(1)
  })
})

describe('a reference that names an issue', () => {
  test('records on the issue when a pull request is what refers to it', async () => {
    if (!available)
      return

    const recorded = await recordCrossReferences(
      { subject: { type: 'pull_request', id: created.pullId }, number: created.pullNumber, repositoryId: created.repositoryId },
      created.ownerId,
      `closes nothing, but see #${created.issueNumber}`,
    )

    expect(recorded).toEqual([created.issueNumber])

    const entries = await referencesOn('issue', created.issueId)
    expect(entries).toHaveLength(1)
    expect(Number(entries[0].reference_number)).toBe(created.pullNumber)
  })
})

describe('a reference that names nothing here', () => {
  test('records nothing for a number nobody has opened', async () => {
    if (!available)
      return

    const recorded = await recordCrossReferences(
      { subject: { type: 'issue', id: created.issueId }, number: created.issueNumber, repositoryId: created.repositoryId },
      created.ownerId,
      'see #9999',
    )

    expect(recorded).toEqual([])
  })
})

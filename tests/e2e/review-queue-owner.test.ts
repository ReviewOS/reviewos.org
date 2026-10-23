// Whose repository it is, when the owner is not a person.
//
// `repositories.owner_id` is polymorphic on `owner_type`, and the review queue
// resolved it through `users` alone. An organization-owned repository matched
// nothing, the LEFT JOIN handed back a null handle, and the handle became the
// empty string one map later - so `/${owner}/${repository}/pull/N/files` came
// out as `//repository/pull/N/files`.
//
// That is not a broken link, it is a link to somewhere else. A leading `//` is
// protocol-relative: the browser reads the next segment as a **hostname**, so
// pressing it leaves this site for a host named after one of our repositories.
// On a seeded instance seven of fifty-four repositories are organization-owned
// and every one of them with a review outstanding was such a link, on the page
// the product opens to.
//
// So this asks for both halves, because they fail independently:
//
//  1. The queue resolves an organization's handle, which is the actual bug.
//  2. The page never emits a path that could leave the site, which is the
//     property that matters even if a handle goes missing again for some
//     reason this test did not anticipate.
//
// Like the rest of tests/e2e it needs a database and skips itself loudly when
// there is none. It needs no git: the queue reads rows.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

const created = {
  organizationId: 0,
  organizationHandle: '',
  reviewerId: 0,
  authorId: 0,
  repositoryId: 0,
  repositoryName: '',
  reviewerToken: '',
}

let available = false
let port = 0
let server: any = null
let reviewQueue: (userId: number, now: number) => Promise<any>

function unique(prefix: string): string {
  return `${prefix}${Buffer.from(crypto.getRandomValues(new Uint8Array(5))).toString('hex')}`
}

beforeAll(async () => {
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

    ;({ reviewQueue } = await import('../../app/Actions/Pull/queue'))

    const { createToken } = await import('@stacksjs/auth')

    const makeUser = async (prefix: string): Promise<number> => {
      const handle = unique(prefix)
      const row: any = await db
        .insertInto('users')
        .values({ name: 'Queue Owner Tester', email: `${handle}@example.com`, handle, password: 'x' })
        .returning(['id'])
        .executeTakeFirst()

      return Number(row?.id)
    }

    created.reviewerId = await makeUser('qor')
    created.authorId = await makeUser('qoa')

    const issued: any = await createToken(created.reviewerId, 'review queue owner test')
    created.reviewerToken = String(issued?.plainTextToken ?? issued?.token ?? issued)

    // The organization, which is the whole point: a repository owned by one of
    // these is what the query could not resolve.
    created.organizationHandle = unique('qorg')
    const organization: any = await db
      .insertInto('organizations')
      .values({
        handle: created.organizationHandle,
        name: 'Queue Owner Org',
        description: 'created by the review queue owner end to end test',
      })
      .returning(['id'])
      .executeTakeFirst()

    created.organizationId = Number(organization?.id)

    created.repositoryName = unique('repo')
    const repository: any = await db
      .insertInto('repositories')
      .values({
        owner_type: 'organization',
        owner_id: created.organizationId,
        name: created.repositoryName,
        description: 'created by the review queue owner end to end test',
        visibility: 'public',
        default_branch: 'main',
        disk_path: `${created.organizationHandle}/${created.repositoryName}.git`,
      })
      .returning(['id'])
      .executeTakeFirst()

    created.repositoryId = Number(repository?.id)

    const pull: any = await db
      .insertInto('pull_requests')
      .values({
        repository_id: created.repositoryId,
        number: 1,
        title: 'a change in a repository an organization owns',
        author_id: created.authorId,
        state: 'open',
        draft: false,
        head_branch: 'work',
        base_branch: 'main',
        head_sha: 'a'.repeat(40),
        base_sha: 'b'.repeat(40),
      })
      .returning(['id'])
      .executeTakeFirst()

    await db.insertInto('pull_request_reviewers').values({
      pull_request_id: Number(pull?.id),
      reviewer_id: created.reviewerId,
      from_code_owners: false,
      responded_at: null,
    }).execute()

    available = Boolean(created.repositoryId && created.organizationId && created.reviewerToken)
  }
  catch (error) {
    console.warn(`[e2e] skipping: ${error instanceof Error ? error.message : String(error)}`)
    available = false
  }
}, 120_000)

afterAll(async () => {
  const db = (globalThis as any).db

  try {
    if (created.repositoryId) {
      await db.deleteFrom('pull_requests').where('repository_id', '=', created.repositoryId).execute()
      await db.deleteFrom('repositories').where('id', '=', created.repositoryId).execute()
    }

    if (created.organizationId)
      await db.deleteFrom('organizations').where('id', '=', created.organizationId).execute()

    for (const id of [created.reviewerId, created.authorId]) {
      if (id)
        await db.deleteFrom('users').where('id', '=', id).execute()
    }
  }
  catch { /* nothing else to release */ }

  try {
    server?.stop?.(true)
  }
  catch { /* already down */ }
})

describe('a repository an organization owns', () => {
  test('is listed under the organization handle, not under nothing', async () => {
    if (!available)
      return

    const queue = await reviewQueue(created.reviewerId, Date.now())
    const entry = queue.waitingOnYou.find((one: any) => one.repository === created.repositoryName)

    expect(entry).toBeDefined()
    expect(entry.owner).toBe(created.organizationHandle)
  })

  test('and the page links to it on this site rather than off it', async () => {
    if (!available)
      return

    const answer = await fetch(`http://127.0.0.1:${port}/reviews`, {
      headers: { Accept: 'text/html', Cookie: `auth-token=${created.reviewerToken}` },
    })
    const html = await answer.text()

    expect(html).toContain(created.repositoryName)

    /*
     * No href may begin with `//`, whatever it names.
     *
     * Asserted over the whole page rather than over the one row, because the
     * failure is a shape rather than a value: any blank segment in any of
     * these paths produces it, and a test that checked only the row it created
     * would pass while the rest of the page still pointed off-site.
     */
    const offSite = (html.match(/href\s*=\s*"\/\/[^"]*"/g) ?? [])
    expect(offSite).toEqual([])

    // And the row points where it should.
    expect(html).toContain(`/${created.organizationHandle}/${created.repositoryName}/pull/1/files`)
  })
})

// A machine account's approval, through the real merge endpoint.
//
// The unit tests pin the counting. This pins the wiring, which is the half
// that actually breaks: the setting is read off the repository row, the
// reviewers are looked up in the database, and the refusal comes back with the
// sentence explaining why an approval that is visibly there did not count.
//
// No git. Every rule is checked before git is touched, which is the whole
// design of the merge action, so a pull request marked clean gets all the way
// to the refusal without a repository on disk.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

const created = {
  ownerId: 0,
  ownerToken: '',
  botId: 0,
  organizationId: 0,
  handle: '',
  name: '',
  repositoryId: 0,
  pullRequestId: 0,
}

let available = false
let port = 0
let server: any = null

function unique(prefix: string): string {
  return `${prefix}${Buffer.from(crypto.getRandomValues(new Uint8Array(5))).toString('hex')}`
}

/** Ask to merge, and return the blockers the server reported. */
async function tryMerge(): Promise<{ status: number, blockers: string[] }> {
  const answer = await fetch(`http://127.0.0.1:${port}/api/repos/pulls/merge`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${created.ownerToken}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify({ owner: created.handle, repo: created.name, number: 1 }),
  })

  const body: any = await answer.json().catch(() => ({}))

  return { status: answer.status, blockers: Array.isArray(body?.blockers) ? body.blockers : [] }
}

/** Turn the repository's opt-in on or off between assertions. */
async function setCounting(on: boolean): Promise<void> {
  await (globalThis as any).db
    .updateTable('repositories')
    .set({ count_machine_approvals: on })
    .where('id', '=', created.repositoryId)
    .execute()
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

    const { createToken } = await import('@stacksjs/auth')

    created.handle = unique('mach')
    const owner: any = await db
      .insertInto('users')
      .values({ name: 'Repository Owner', email: `${created.handle}@example.com`, handle: created.handle, password: 'x' })
      .returning(['id'])
      .executeTakeFirst()

    created.ownerId = Number(owner?.id)
    const issued: any = await createToken(created.ownerId, 'machine approval test')
    created.ownerToken = String(issued?.plainTextToken ?? issued?.token ?? issued)

    // An organization for the machine account to belong to. A machine account
    // is defined by having one - that column is what makes it a machine.
    const organizationHandle = unique('machorg')
    const organization: any = await db
      .insertInto('organizations')
      .values({ name: 'Machines Inc', handle: organizationHandle })
      .returning(['id'])
      .executeTakeFirst()

    created.organizationId = Number(organization?.id)

    const botHandle = unique('machbot')
    const bot: any = await db
      .insertInto('users')
      .values({
        name: 'Reviewing Agent',
        email: `${botHandle}@example.com`,
        handle: botHandle,
        password: 'x',
        machine_for_organization_id: created.organizationId,
      })
      .returning(['id'])
      .executeTakeFirst()

    created.botId = Number(bot?.id)

    created.name = unique('machrepo')
    const repository: any = await db
      .insertInto('repositories')
      .values({
        owner_type: 'user',
        owner_id: created.ownerId,
        name: created.name,
        visibility: 'public',
        default_branch: 'main',
        disk_path: `${created.handle}/${created.name}.git`,
        count_machine_approvals: false,
      })
      .returning(['id'])
      .executeTakeFirst()

    created.repositoryId = Number(repository?.id)

    const head = 'b'.repeat(40)
    const pullRequest: any = await db
      .insertInto('pull_requests')
      .values({
        repository_id: created.repositoryId,
        number: 1,
        title: 'A change an agent approved',
        author_id: created.ownerId,
        state: 'open',
        head_branch: 'change',
        head_sha: head,
        base_branch: 'main',
        base_sha: 'a'.repeat(40),
        draft: false,
        // Marked clean so the merge action gets past mergeability and reaches
        // the approval rule, which is what this is about.
        mergeable_state: 'clean',
      })
      .returning(['id'])
      .executeTakeFirst()

    created.pullRequestId = Number(pullRequest?.id)

    await db.insertInto('protected_branches').values({
      repository_id: created.repositoryId,
      pattern: 'main',
      required_approvals: 1,
      required_checks: '[]',
    }).execute()

    // The agent approves, against the current head, so nothing about staleness
    // muddies the result.
    await db.insertInto('pull_request_reviews').values({
      pull_request_id: created.pullRequestId,
      reviewer_id: created.botId,
      state: 'approved',
      commit_sha: head,
      submitted_at: new Date().toISOString(),
    }).execute()

    available = true
  }
  catch (error) {
    console.warn(`[machine-approval] skipping: ${error instanceof Error ? error.message : String(error)}`)
    available = false
  }
}, 120_000)

afterAll(async () => {
  const db = (globalThis as any).db

  try {
    if (db) {
      if (created.pullRequestId) {
        await db.deleteFrom('pull_request_reviews').where('pull_request_id', '=', created.pullRequestId).execute()
        await db.deleteFrom('pull_requests').where('id', '=', created.pullRequestId).execute()
      }

      if (created.repositoryId) {
        await db.deleteFrom('protected_branches').where('repository_id', '=', created.repositoryId).execute()
        await db.deleteFrom('repositories').where('id', '=', created.repositoryId).execute()
      }

      const users = [created.ownerId, created.botId].filter(Boolean)
      if (users.length > 0) {
        await db.deleteFrom('access_tokens').where('user_id', 'in', users).execute()
        await db.deleteFrom('users').where('id', 'in', users).execute()
      }

      if (created.organizationId)
        await db.deleteFrom('organizations').where('id', '=', created.organizationId).execute()
    }
  }
  finally {
    server?.stop?.()
  }
}, 30_000)

describe('with the repository opted out, which is the default', () => {
  test('the agent\'s approval does not satisfy the rule', async () => {
    if (!available)
      return

    await setCounting(false)
    const { status, blockers } = await tryMerge()

    expect(status).toBe(409)
    expect(blockers.join(' ')).toContain('approval')
  })

  test('and the refusal says why the approval on screen did not count', async () => {
    if (!available)
      return

    /*
     * The sentence matters as much as the refusal. "1 more approval is
     * required" on a pull request that visibly has one reads as a bug in the
     * counting, and the reader's next move is to ask a colleague rather than to
     * find the setting.
     */
    await setCounting(false)
    const { blockers } = await tryMerge()

    expect(blockers.join(' ')).toContain('machine account')
  })
})

describe('with the repository opted in', () => {
  test('the same approval satisfies it', async () => {
    if (!available)
      return

    /*
     * Nothing about the review changed between this and the test above - only
     * the repository's setting. That is the claim: the opt-in is what decides,
     * not anything about the review itself.
     */
    await setCounting(true)
    const { blockers } = await tryMerge()

    expect(blockers.join(' ')).not.toContain('approval')
  })
})

describe('an objection from the same account', () => {
  test('blocks even while its approvals are not counted', async () => {
    if (!available)
      return

    /*
     * The asymmetry, end to end. Declining to count a robot's approval is
     * cautious; ignoring a robot's objection is the opposite, and a repository
     * that opted out of the first has not asked for the second.
     */
    const db = (globalThis as any).db

    await setCounting(false)
    await db
      .updateTable('pull_request_reviews')
      .set({ state: 'changes_requested' })
      .where('pull_request_id', '=', created.pullRequestId)
      .where('reviewer_id', '=', created.botId)
      .execute()

    const { blockers } = await tryMerge()

    expect(blockers.join(' ')).toContain('Changes requested')

    // Put it back, so the order these run in cannot matter.
    await db
      .updateTable('pull_request_reviews')
      .set({ state: 'approved' })
      .where('pull_request_id', '=', created.pullRequestId)
      .where('reviewer_id', '=', created.botId)
      .execute()
  })
})

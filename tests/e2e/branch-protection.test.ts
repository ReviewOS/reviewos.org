// Branch protection, end to end: the endpoint that writes a rule and the page
// that shows it.
//
// Worth a live server rather than a call to `decideRule`, for two reasons that
// are both about silent failure. The endpoint's `validations` block is
// *enforced* before the handler runs, so a rule declared as `schema.string()`
// on a field a JSON client sends as a boolean is a 422 nobody sees until
// somebody writes a client - which is exactly how twenty-two tests in six
// features went red once already. And stx swallows a throw in `<script server>`
// and renders the template with every binding undefined, so a broken import in
// the settings page shows up as "No such repository" with a 200.
//
// So the assertions here are on the JSON a GitHub-shaped call comes back with,
// and on strings only the branch protection section can produce.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

const created = { userId: 0, repositoryId: 0, token: '', handle: '', repositoryName: '' }

let available = false
let server: any
let port = 0
let db: any

function unique(prefix: string): string {
  return `${prefix}${Buffer.from(crypto.getRandomValues(new Uint8Array(5))).toString('hex')}`
}

/** The endpoint, spoken to the way an API client speaks to it: JSON. */
async function save(body: Record<string, unknown>): Promise<{ status: number, json: any }> {
  const answer = await fetch(`http://127.0.0.1:${port}/api/repos/protected-branches`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'Authorization': `Bearer ${created.token}`,
    },
    body: JSON.stringify({ owner: created.handle, repo: created.repositoryName, ...body }),
  })

  return { status: answer.status, json: await answer.json().catch(() => null) }
}

async function ruleFor(pattern: string): Promise<any> {
  return await db
    .selectFrom('protected_branches')
    .selectAll()
    .where('repository_id', '=', created.repositoryId)
    .where('pattern', '=', pattern)
    .executeTakeFirst()
}

async function fetchPage(path: string): Promise<string> {
  const answer = await fetch(`http://127.0.0.1:${port}${path}`, {
    headers: { Accept: 'text/html', Cookie: `auth-token=${created.token}` },
  })

  return await answer.text()
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
    port = Number((server as any)?.port ?? (server as any)?.server?.port ?? 0)

    if (!port)
      throw new Error('the router did not report a port')

    const { createToken } = await import('@stacksjs/auth')
    created.handle = unique('bpg')

    const row: any = await db
      .insertInto('users')
      .values({ name: 'Branch Rule Owner', email: `${created.handle}@example.com`, handle: created.handle, password: 'x' })
      .returning(['id'])
      .executeTakeFirst()

    created.userId = Number(row?.id)

    const issued: any = await createToken(created.userId, 'branch protection test')
    created.token = String(issued?.plainTextToken ?? issued?.token ?? issued)

    created.repositoryName = unique('repo')
    const repository: any = await db
      .insertInto('repositories')
      .values({
        owner_type: 'user',
        owner_id: created.userId,
        name: created.repositoryName,
        description: 'created by the branch protection test',
        visibility: 'private',
        default_branch: 'main',
        disk_path: `${created.handle}/${created.repositoryName}.git`,
      })
      .returning(['id'])
      .executeTakeFirst()

    created.repositoryId = Number(repository?.id)
    available = true
  }
  catch (error) {
    console.warn(`[branch-protection] skipping: ${error instanceof Error ? error.message : String(error)}`)
    available = false
  }
}, 120_000)

afterAll(async () => {
  try {
    if (db && created.repositoryId) {
      await db.deleteFrom('protected_branches').where('repository_id', '=', created.repositoryId).execute()
      await db.deleteFrom('repositories').where('id', '=', created.repositoryId).execute()
    }

    if (db && created.userId)
      await db.deleteFrom('users').where('id', '=', created.userId).execute()
  }
  finally {
    server?.stop?.()
  }
})

describe('writing a rule the way a branch protection call describes one', () => {
  /**
   * The whole payload in one request, with the types a JSON client actually
   * sends: booleans as booleans, the approval count as a number, the checks as
   * an array, and the restriction as an object.
   */
  test('takes every field of a GitHub-shaped protection call', async () => {
    if (!available)
      return

    const answer = await save({
      pattern: 'main',
      required_approvals: 1,
      dismiss_stale_reviews: true,
      required_checks: ['ci'],
      require_up_to_date: true,
      enforce_admins: true,
      allow_force_push: false,
      allow_deletion: false,
    })

    expect(answer.status).toBe(201)

    const rule = await ruleFor('main')

    expect(Number(rule.required_approvals)).toBe(1)
    expect(Boolean(rule.dismiss_stale_reviews)).toBe(true)
    expect(String(rule.required_checks)).toBe('["ci"]')
    expect(Boolean(rule.require_up_to_date)).toBe(true)
    expect(Boolean(rule.enforce_admins)).toBe(true)
    expect(Boolean(rule.allow_force_push)).toBe(false)
    expect(Boolean(rule.allow_deletion)).toBe(false)
  })

  test('upserts on the pattern rather than writing a second rule for it', async () => {
    if (!available)
      return

    const answer = await save({ pattern: 'main', required_approvals: 2 })

    expect(answer.status).toBe(200)

    const rows = await db
      .selectFrom('protected_branches')
      .select(['id'])
      .where('repository_id', '=', created.repositoryId)
      .where('pattern', '=', 'main')
      .execute()

    expect(rows).toHaveLength(1)
    expect(Number((await ruleFor('main')).required_approvals)).toBe(2)
  })

  /**
   * The field whose absent value is not false.
   *
   * A client that has never heard of `enforce_admins` must not switch it off by
   * staying silent - that would unbind the rule from the people most able to
   * break it, on the save of an unrelated field.
   */
  test('a save that never mentions enforce_admins leaves it on', async () => {
    if (!available)
      return

    await save({ pattern: 'main', required_approvals: 1 })

    expect(Boolean((await ruleFor('main')).enforce_admins)).toBe(true)
  })

  test('and sending it off turns it off, which is the only way it goes off', async () => {
    if (!available)
      return

    await save({ pattern: 'main', enforce_admins: false })
    expect(Boolean((await ruleFor('main')).enforce_admins)).toBe(false)

    await save({ pattern: 'main', enforce_admins: '0' })
    expect(Boolean((await ruleFor('main')).enforce_admins)).toBe(false)
  })

  /**
   * The hidden `0` in front of the checkbox only works if the last value wins.
   *
   * A ticked box posts `enforce_admins=0&enforce_admins=1`, and if the parser
   * kept the *first* of those, ticking the box would turn enforcement off - the
   * exact opposite of what the person clicking it asked for, on the one field
   * where being wrong hands out an exemption. Asserted rather than assumed,
   * because nothing about the form says which end wins.
   */
  test('a form posting the box twice takes the ticked value', async () => {
    if (!available)
      return

    const body = new URLSearchParams({ owner: created.handle, repo: created.repositoryName, pattern: 'main' })
    body.append('enforce_admins', '0')
    body.append('enforce_admins', '1')

    const answer = await fetch(`http://127.0.0.1:${port}/api/repos/protected-branches`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json',
        'Authorization': `Bearer ${created.token}`,
      },
      body: body.toString(),
    })

    expect(answer.status).toBe(200)
    expect(Boolean((await ruleFor('main')).enforce_admins)).toBe(true)
  })

  test('and the same form with the box unticked turns it off', async () => {
    if (!available)
      return

    const body = new URLSearchParams({
      owner: created.handle,
      repo: created.repositoryName,
      pattern: 'main',
      enforce_admins: '0',
    })

    const answer = await fetch(`http://127.0.0.1:${port}/api/repos/protected-branches`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json',
        'Authorization': `Bearer ${created.token}`,
      },
      body: body.toString(),
    })

    expect(answer.status).toBe(200)
    expect(Boolean((await ruleFor('main')).enforce_admins)).toBe(false)
  })

  test('stores who may push, as users and teams', async () => {
    if (!available)
      return

    await save({ pattern: 'release/*', push_restrictions: { users: ['Ada'], teams: ['Platform'] } })

    expect(String((await ruleFor('release/*')).push_restrictions))
      .toBe('{"users":["ada"],"teams":["platform"]}')
  })

  /** `restrictions: null` is how such a call says "anybody with push access". */
  test('and null means unrestricted rather than a branch nobody can write', async () => {
    if (!available)
      return

    await save({ pattern: 'release/*', push_restrictions: null })

    expect(String((await ruleFor('release/*')).push_restrictions ?? '')).toBe('')
  })

  test('refuses a pattern no branch could be named', async () => {
    if (!available)
      return

    const answer = await save({ pattern: 'not a branch' })

    expect(answer.status).toBe(422)
  })

  test('removes a rule, and says so when there is none to remove', async () => {
    if (!available)
      return

    await save({ pattern: 'temporary' })
    expect(await ruleFor('temporary')).toBeTruthy()

    expect((await save({ pattern: 'temporary', operation: 'delete' })).status).toBe(200)
    expect(await ruleFor('temporary')).toBeFalsy()
    expect((await save({ pattern: 'temporary', operation: 'delete' })).status).toBe(404)
  })
})

describe('the branch protection section of the settings page', () => {
  /**
   * The tell that the server script threw is not an exception: stx renders the
   * template with every binding undefined, which takes the not-found branch.
   */
  test('renders, rather than falling through to the not-found branch', async () => {
    if (!available)
      return

    await save({ pattern: 'main', required_approvals: 2, required_checks: ['ci'] })

    const html = await fetchPage(`/${created.handle}/${created.repositoryName}/settings`)

    expect(html).toContain('Branch protection')
    expect(html).not.toContain('No such repository')

    /*
     * The blank form, which fails in its own quiet way.
     *
     * stx injects only the props a caller passes, and an undeclared identifier
     * takes the component's whole server script down - so a prop left off the
     * new-rule invocation renders nothing at all, with a line in a log nobody
     * is reading. The button is the proof it rendered.
     */
    expect(html).toContain('New rule')
    expect(html).toContain('Add rule')
  })

  test('shows an existing rule filled in, so saving it does not clear it', async () => {
    if (!available)
      return

    await save({
      pattern: 'main',
      required_approvals: 2,
      required_checks: ['ci', 'build'],
      require_up_to_date: true,
      push_restrictions: { users: ['ada'], teams: ['platform'] },
    })

    const html = await fetchPage(`/${created.handle}/${created.repositoryName}/settings`)

    expect(html).toContain('ci, build')
    expect(html).toContain('ada')
    expect(html).toContain('platform')

    // A flag arrives as a string, and 'false' is a truthy one - so a box fed
    // the wrong shape reads as ticked. On this page that is a rule the screen
    // says is enforced and is not.
    expect(html).toContain('name="require_up_to_date" value="1" checked')
    expect(html).toContain('name="allow_force_push" value="1"')
    expect(html).not.toContain('name="allow_force_push" value="1" checked')
  })

  /**
   * The hidden `0` in front of the checkbox, and the reason it has to be there:
   * an unticked checkbox sends nothing, and for this field "nothing" means on.
   * Without the hidden input the page could never turn it off.
   */
  test('carries an off value for enforce_admins, which a checkbox cannot send', async () => {
    if (!available)
      return

    const html = await fetchPage(`/${created.handle}/${created.repositoryName}/settings`)

    expect(html).toContain('name="enforce_admins" value="0"')
  })
})

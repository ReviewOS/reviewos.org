// The profile page, through the real routes.
//
// Fourteen links in this product pointed at `/{handle}` and there was no page
// there - every commit author, every issue author, every reviewer. So the first
// thing this file asserts is that the page exists and renders somebody's name.
//
// The rest is the part that fails silently. stx renders a page with every
// variable undefined when a server script throws, so a profile with no
// repositories and a profile that crashed look identical - and "nothing here
// yet" is exactly what somebody expects to be wrong about on a new account.
//
// The visibility rules are the other half, and they fail in the direction that
// matters: a private repository or a private activity row appearing on a
// stranger's view of a profile is a disclosure, and it looks like the feature
// working.
//
// Like the rest of tests/e2e it needs a database, and skips itself loudly when
// there is not one.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

const created = {
  userId: 0,
  strangerId: 0,
  orgId: 0,
  publicRepoId: 0,
  privateRepoId: 0,
  handle: '',
  strangerToken: '',
  ownToken: '',
  orgName: '',
  publicName: '',
  privateName: '',
}

let available = false
let port = 0
let server: any = null

function unique(prefix: string): string {
  return `${prefix}${Buffer.from(crypto.getRandomValues(new Uint8Array(5))).toString('hex')}`
}

async function fetchPage(path: string, token?: string): Promise<{ status: number, html: string }> {
  const answer = await fetch(`http://127.0.0.1:${port}${path}`, {
    headers: { Accept: 'text/html', ...(token ? { Cookie: `auth-token=${token}` } : {}) },
  })

  return { status: answer.status, html: await answer.text() }
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

    const make = async (prefix: string, extra: Record<string, unknown> = {}) => {
      const handle = unique(prefix)
      const row: any = await db
        .insertInto('users')
        .values({ name: 'Profile Person', email: `${handle}@example.com`, handle, password: 'x', ...extra })
        .returning(['id'])
        .executeTakeFirst()

      const id = Number(row?.id)
      const issued: any = await createToken(id, 'profile page test')

      return { id, handle, token: String(issued?.plainTextToken ?? issued?.token ?? issued) }
    }

    const person = await make('pfp', { bio: 'A distinctive biography line' })
    const stranger = await make('pfs')

    created.userId = person.id
    created.handle = person.handle
    created.ownToken = person.token
    created.strangerId = stranger.id
    created.strangerToken = stranger.token
    created.publicName = unique('pub')
    created.privateName = unique('sec')
    created.orgName = unique('org')

    const org: any = await db
      .insertInto('organizations')
      .values({ handle: created.orgName, name: 'Profile Org', description: 'An organization for the profile test' })
      .returning(['id'])
      .executeTakeFirst()

    created.orgId = Number(org?.id)

    const repo = async (name: string, visibility: string) => {
      const row: any = await db
        .insertInto('repositories')
        .values({
          owner_type: 'user',
          owner_id: created.userId,
          name,
          description: `${name} description`,
          visibility,
          default_branch: 'main',
          disk_path: `x/${name}.git`,
        })
        .returning(['id'])
        .executeTakeFirst()

      return Number(row?.id)
    }

    created.publicRepoId = await repo(created.publicName, 'public')
    created.privateRepoId = await repo(created.privateName, 'private')

    // One public event and one private one, so the feed's own rule is exercised
    // rather than assumed.
    const event = async (isPublic: boolean, title: string, repositoryId: number) => {
      await db.insertInto('activity_events').values({
        actor_id: created.userId,
        verb: 'opened_pull_request',
        subject_type: 'pull_request',
        subject_id: 1,
        repository_id: repositoryId,
        is_public: isPublic,
        detail: JSON.stringify({
          repository: `${created.handle}/${isPublic ? created.publicName : created.privateName}`,
          number: 12,
          title,
          tag: '',
        }),
      }).execute()
    }

    await event(true, 'a-public-activity-title', created.publicRepoId)
    await event(false, 'a-private-activity-title', created.privateRepoId)

    available = true
  }
  catch (error) {
    console.warn(`[profile-page] skipping: ${error instanceof Error ? error.message : String(error)}`)
    available = false
  }
}, 120_000)

afterAll(async () => {
  const db = (globalThis as any).db

  try {
    const ids = [created.userId, created.strangerId].filter(Boolean)

    if (db && ids.length > 0) {
      await db.deleteFrom('activity_events').where('actor_id', 'in', ids).execute()
      await db.deleteFrom('repositories').where('owner_id', 'in', ids).execute()
      await db.deleteFrom('organizations').where('id', '=', created.orgId).execute()
      await db.deleteFrom('users').where('id', 'in', ids).execute()
    }
  }
  finally {
    server?.stop?.()
  }
}, 30_000)

describe('a user profile', () => {
  test('exists, which fourteen links in this product were assuming', async () => {
    if (!available)
      return

    const { status, html } = await fetchPage(`/${created.handle}`)

    expect(status).toBe(200)
    expect(html).toContain(created.handle)
    expect(html).toContain('A distinctive biography line')
  })

  test('lists their public repositories', async () => {
    if (!available)
      return

    const { html } = await fetchPage(`/${created.handle}`)

    expect(html).toContain(created.publicName)
  })

  test('and their public activity, as a sentence', async () => {
    if (!available)
      return

    // "opened acme/api#12" rather than a row of fields. The feed's whole job is
    // to be readable at a glance.
    const { html } = await fetchPage(`/${created.handle}`)

    expect(html).toContain('a-public-activity-title')
    expect(html).toContain('opened')
  })
})

describe('what a stranger may not see', () => {
  test('a private repository is not on the page', async () => {
    if (!available)
      return

    const { html } = await fetchPage(`/${created.handle}`, created.strangerToken)

    expect(html).not.toContain(created.privateName)
  })

  test('nor private activity', async () => {
    if (!available)
      return

    // `is_public` was decided when the row was written. This is the assertion
    // that it is actually being read.
    const { html } = await fetchPage(`/${created.handle}`, created.strangerToken)

    expect(html).not.toContain('a-private-activity-title')
    expect(html).toContain('a-public-activity-title')
  })

  test('and a signed-out reader sees the same', async () => {
    if (!available)
      return

    const { html } = await fetchPage(`/${created.handle}`)

    expect(html).not.toContain(created.privateName)
    expect(html).not.toContain('a-private-activity-title')
  })
})

describe('what the owner sees', () => {
  test('their own private repositories and activity', async () => {
    if (!available)
      return

    // Their own, and only their own. There is deliberately no case where a
    // collaborator sees a colleague's private activity here: a profile whose
    // contents depend on a permission graph has a disclosure for its first bug.
    const { html } = await fetchPage(`/${created.handle}`, created.ownToken)

    expect(html).toContain(created.privateName)
    expect(html).toContain('a-private-activity-title')
  })

  test('and a link to edit it', async () => {
    if (!available)
      return

    const { html } = await fetchPage(`/${created.handle}`, created.ownToken)

    expect(html).toContain('/settings/profile')
  })
})

describe('an organization', () => {
  test('renders at the same URL shape, because a repository URL does not distinguish', async () => {
    if (!available)
      return

    const { status, html } = await fetchPage(`/${created.orgName}`)

    expect(status).toBe(200)
    expect(html).toContain('An organization for the profile test')
  })

  test('has no activity feed, because an organization does not act', async () => {
    if (!available)
      return

    // Its members do. A feed here would be a list of other people's names under
    // a heading implying the organization did it.
    const { html } = await fetchPage(`/${created.orgName}`)

    expect(html).not.toContain('Activity')
  })
})

describe('a handle nobody has', () => {
  test('says so, rather than rendering an empty profile', async () => {
    if (!available)
      return

    const { html } = await fetchPage('/definitely-nobody-at-all-here')

    expect(html).toContain('Not found')
    expect(html).toContain('definitely-nobody-at-all-here')
  })

  test('and the page it renders is a real render, not a collapsed one', async () => {
    if (!available)
      return

    /*
     * The assertion that matters, and the reason it is spelled this way.
     *
     * `setResponseStatus` is not provided by the router's view path, so calling
     * it threw inside the server script's IIFE and took every binding in the
     * file with it - and the page then rendered its not-found branch *because
     * everything was undefined*. It looked exactly like this page working.
     *
     * Nineteen views were in that state. The binding is provided by both
     * hosts now and asked for inside the script that has it, which is what
     * makes the branch deliberate; this checks the difference, because a
     * collapsed render loses the layout's navigation and a real one keeps it.
     */
    const { html } = await fetchPage('/definitely-nobody-at-all-here')

    // Items every reader gets, signed in or not: the bar's contents depend on
    // who is reading now, and a marker that only a session sees would make this
    // pass or fail for the wrong reason.
    expect(html).toContain('Explore')
    expect(html).toContain('Discover')
    expect(html).toContain('ReviewOS')
  })

  test('and answers 404, which it did not for a long time', async () => {
    if (!available)
      return

    /*
     * An empty profile under a 200 tells a crawler, a cache and an uptime check
     * that the page is fine, and this product would rather it did not.
     *
     * This assertion used to read `toBe(200)` with a note saying the day the
     * router carried the status through, it would fail and somebody would
     * tighten it. Two things had to be true for that day to arrive.
     *
     * `@stacksjs/bun-router` 0.0.23 hands the server script
     * `setResponseStatus`, `notFound` and `setResponseHeader`, and answers with
     * what the page asked for rather than a fixed 200.
     *
     * And the ask moved to where the binding is. `setResponseStatus` is a
     * *context binding* - the host builds the script's scope from the keys it
     * supplies - so `resources/functions/http.ts`, a module the script
     * imported, could never see it however carefully it guarded. Every page
     * that meant to answer 404 answered 200, on every host, including the dev
     * frontend the old note gave the benefit of the doubt to.
     */
    const { status } = await fetchPage('/definitely-nobody-at-all-here')

    expect(status).toBe(404)
  })
})

describe('finding one repository among many', () => {
  /*
   * The repository cards, by name, rather than "does this string appear".
   *
   * A profile carries the searched-for text in three other places - the search
   * box echoes it back, the activity feed names repositories in its sentences,
   * and the sidebar counts them - so a `toContain` over the whole document
   * passes whatever the list does. Every assertion here is about what the list
   * actually holds.
   */
  const listed = (html: string, handle: string): string[] => {
    const names: string[] = []
    const pattern = new RegExp(`class="repo-card-name" href="/${handle}/([^"]+)"`, 'g')

    for (const match of html.matchAll(pattern))
      names.push(match[1])

    return names
  }

  test('the search box narrows the list to what was asked for', async () => {
    if (!available)
      return

    // A GET form, so the result is a URL somebody can send. The owner here has
    // two repositories and the search has to leave exactly one of them.
    const { html } = await fetchPage(`/${created.handle}?q=${created.publicName}`, created.ownToken)

    expect(listed(html, created.handle)).toEqual([created.publicName])
  })

  test('and a search that matches nothing says so, rather than rendering an empty page', async () => {
    if (!available)
      return

    const { html } = await fetchPage(`/${created.handle}?q=nothing-called-this-anywhere`)

    expect(html).toContain('Nothing here matches')
    expect(listed(html, created.handle)).toEqual([])
  })

  test('a stranger cannot search a private repository into view', async () => {
    if (!available)
      return

    // The visibility rule is applied before the search rather than after it. A
    // filter that runs over rows the reader may not see is a disclosure with a
    // text box in front of it - type the name, learn whether it exists.
    const { html } = await fetchPage(`/${created.handle}?q=${created.privateName}`, created.strangerToken)

    expect(listed(html, created.handle)).toEqual([])
    expect(html).toContain('Nothing here matches')
  })

  test('a page number past the end lands on the last page rather than on nothing', async () => {
    if (!available)
      return

    const { status, html } = await fetchPage(`/${created.handle}?page=900`)

    expect(status).toBe(200)
    expect(listed(html, created.handle)).toContain(created.publicName)
  })
})

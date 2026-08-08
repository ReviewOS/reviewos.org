// The tokens settings page, rendered through the real router.
//
// Worth a live server rather than a call to the loader, because the way this
// page fails is not an exception. stx swallows a throw in `<script server>` and
// renders the template with every variable undefined, so a broken import or a
// mistyped function shows up as the signed-out branch - a page that says "Sign
// in to manage your tokens" to somebody who is signed in. Nothing is logged and
// the status is 200.
//
// So the assertions are on strings that only the signed-in branch can produce,
// and on the sentence describing a grant rather than on the scope string: the
// sentence is the entire reason the page exists. `contents: write` in the HTML
// would mean the page rendered and the describing step did not.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

const created = { userId: 0, repositoryId: 0, tokenId: 0, token: '', handle: '', repositoryName: '' }

let available = false
let server: any
let port = 0
let db: any

function unique(prefix: string): string {
  return `${prefix}${Buffer.from(crypto.getRandomValues(new Uint8Array(5))).toString('hex')}`
}

async function fetchPage(path: string, cookieToken?: string): Promise<string> {
  const answer = await fetch(`http://127.0.0.1:${port}${path}`, {
    headers: {
      Accept: 'text/html',
      ...(cookieToken ? { Cookie: `auth-token=${cookieToken}` } : {}),
    },
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
    created.handle = unique('tpg')

    const row: any = await db
      .insertInto('users')
      .values({ name: 'Token Page Reader', email: `${created.handle}@example.com`, handle: created.handle, password: 'x' })
      .returning(['id'])
      .executeTakeFirst()

    created.userId = Number(row?.id)

    const issued: any = await createToken(created.userId, 'tokens page test')
    created.token = String(issued?.plainTextToken ?? issued?.token ?? issued)

    created.repositoryName = unique('repo')
    const repository: any = await db
      .insertInto('repositories')
      .values({
        owner_type: 'user',
        owner_id: created.userId,
        name: created.repositoryName,
        description: 'created by the tokens page test',
        visibility: 'private',
        default_branch: 'main',
        disk_path: `${created.handle}/${created.repositoryName}.git`,
      })
      .returning(['id'])
      .executeTakeFirst()

    created.repositoryId = Number(repository?.id)

    const { generateToken } = await import('../../app/Actions/Tokens/secret')
    const secret = generateToken()

    const access: any = await db
      .insertInto('access_tokens')
      .values({
        user_id: created.userId,
        name: 'a-very-distinctive-token-name',
        prefix: secret.prefix,
        token_hash: secret.hash,
        selection: 'selected',
        expires_at: new Date(Date.now() + 86_400_000).toISOString(),
        last_used_at: new Date(Date.now() - 3_600_000).toISOString(),
        last_used_ip: '198.51.100.24',
      })
      .returning(['id'])
      .executeTakeFirst()

    created.tokenId = Number(access?.id)

    await db
      .insertInto('access_token_permissions')
      .values({ access_token_id: created.tokenId, scope: 'contents', level: 'write' })
      .execute()

    await db
      .insertInto('access_token_repositories')
      .values({ access_token_id: created.tokenId, repository_id: created.repositoryId })
      .execute()

    available = true
  }
  catch (error) {
    console.warn(`[tokens-page] skipping: ${error instanceof Error ? error.message : String(error)}`)
    available = false
  }
}, 120_000)

afterAll(async () => {
  try {
    if (db && created.tokenId) {
      await db.deleteFrom('access_token_repositories').where('access_token_id', '=', created.tokenId).execute()
      await db.deleteFrom('access_token_permissions').where('access_token_id', '=', created.tokenId).execute()
      await db.deleteFrom('access_tokens').where('id', '=', created.tokenId).execute()
    }

    if (db && created.repositoryId)
      await db.deleteFrom('repositories').where('id', '=', created.repositoryId).execute()

    if (db && created.userId)
      await db.deleteFrom('users').where('id', '=', created.userId).execute()
  }
  finally {
    server?.stop?.()
  }
})

describe('the access tokens page', () => {
  test('renders the signed-in branch, not the sign-in prompt', async () => {
    if (!available)
      return

    const html = await fetchPage('/settings/tokens', created.token)

    expect(html).toContain('a-very-distinctive-token-name')
    // The tell that the server script threw: stx renders the template with
    // every variable undefined, which takes the `@if (!viewer)` branch.
    expect(html).not.toContain('Sign in to manage your tokens')
  })

  test('says what the token can do, not which scope it holds', async () => {
    if (!available)
      return

    const html = await fetchPage('/settings/tokens', created.token)

    expect(html).toContain('Push code, and merge pull requests')
    // The raw grant would mean the page rendered and the describing step did
    // not, which is exactly the failure this page exists to prevent.
    expect(html).not.toContain('contents: write')
  })

  test('names the repository it reaches, and where it was last used from', async () => {
    if (!available)
      return

    const html = await fetchPage('/settings/tokens', created.token)

    expect(html).toContain(created.repositoryName)
    expect(html).toContain('198.51.100.24')
  })

  test('never puts the secret on the page', async () => {
    if (!available)
      return

    const html = await fetchPage('/settings/tokens', created.token)

    const stored: any = await db
      .selectFrom('access_tokens')
      .select(['prefix', 'token_hash'])
      .where('id', '=', created.tokenId)
      .executeTakeFirst()

    // The hash is not a secret in the way the token is, but it has no business
    // on a page either: publishing it turns a database read into an offline
    // guessing target that needs no further access.
    expect(html).not.toContain(String(stored.token_hash))
  })

  test('offers the repository to scope a new token to', async () => {
    if (!available)
      return

    const html = await fetchPage('/settings/tokens', created.token)

    // The form is server-rendered, so an empty repository list is the tell that
    // `scopableRepositories` threw rather than that the account has none.
    expect(html).toContain('Issue a token')
    expect(html).toContain(`value="${created.repositoryId}"`)
  })

  test('offers to rotate a live token, and explains the overlap', async () => {
    if (!available)
      return

    const html = await fetchPage('/settings/tokens', created.token)

    expect(html).toContain('/api/user/tokens/rotate')
    expect(html).toContain('Rotate')
    // The overlap is the entire feature, and a button labelled "Rotate" with no
    // explanation reads as "revoke and reissue" - which is the thing people
    // avoid doing, for the reason this exists.
    expect(html).toContain('24 hours')
  })

  test('asks somebody who is not signed in to sign in', async () => {
    if (!available)
      return

    const html = await fetchPage('/settings/tokens')

    // The other half of the first assertion. Without this, a page that showed
    // the signed-out branch to everybody would still pass on a mistake that
    // made every viewer look signed in.
    expect(html).toContain('Sign in to manage your tokens')
    expect(html).not.toContain('a-very-distinctive-token-name')
  })
})

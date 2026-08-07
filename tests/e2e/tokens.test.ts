// What a token can actually do, asked of the database rather than of the rules.
//
// `tests/unit/token-scopes.test.ts` pins the arithmetic and `token-secret.ts`
// pins the hashing, and both are pure functions that will keep passing after
// the thing they describe has stopped being what the server does. These go the
// other way: a real row, a real token string, and the two functions a request
// actually reaches - `authenticateToken` and `mayUseService`.
//
// Two properties are worth the setup cost, and they are the two the roadmap
// names:
//
// **Revocation takes effect on the very next request.** Not on the next deploy,
// not when a cache expires. Somebody revoking a token has usually just realised
// it leaked, and the gap between the click and the effect is the whole value of
// the button. So it is asserted as a sequence against one live token: it works,
// it is revoked, it does not work - with nothing in between.
//
// **A token is an upper bound and never a widening.** Its owner losing access
// to a repository has to take the token's reach with it, without anybody
// remembering to revoke anything, because the person removing a collaborator is
// not thinking about tokens and should not have to. That is the intersection in
// `mayUseService`, and it is only true if both halves are really consulted -
// which a pure test of either half cannot show.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

const created = {
  ownerId: 0,
  collaboratorId: 0,
  repositoryId: 0,
  otherRepositoryId: 0,
  repositoryName: '',
  otherRepositoryName: '',
  tokenId: 0,
  otherTokenId: 0,
  readTokenId: 0,
  handle: '',
}

let available = false
let db: any

/** The live token's secret, and the one scoped to the other repository. */
let secret = ''
let otherSecret = ''

/** A token whose owner may push and which itself may only read. */
let readSecret = ''

let authenticateToken: typeof import('../../app/Actions/Tokens/authenticate').authenticateToken
let mayUseService: typeof import('../../app/Actions/Git/access').mayUseService

function unique(prefix: string): string {
  return `${prefix}${Buffer.from(crypto.getRandomValues(new Uint8Array(5))).toString('hex')}`
}

/**
 * The repository, looked up the way a request looks it up.
 *
 * Through `findRepositoryByPath` rather than a select of my own, and that is
 * not tidiness. Postgres hands a `bigint` back as a string, and the production
 * lookup is where it becomes a number; a hand-rolled select skips that step, so
 * `tokenReaches` compares `[7]` against `"7"`, finds nothing, and every
 * assertion in this file reads false for a reason that exists only in the test.
 * That happened. Using the real lookup means the row cannot drift from the one
 * the server sees.
 */
async function repositoryRow(name: string): Promise<any> {
  const { findRepositoryByPath } = await import('../../app/Actions/Git/access')

  return await findRepositoryByPath(`${created.handle}o`, name)
}

/**
 * Insert a token owned by the collaborator.
 *
 * Written straight rather than through `CreateTokenAction`, because the action
 * is an HTTP endpoint with its own validation and this is testing what the rows
 * mean, not how they get there. The token string is generated properly, so the
 * prefix lookup and the hash comparison are the real ones.
 */
async function issueToken(options: {
  name: string
  level: 'read' | 'write'
  repositoryIds: number[]
  expiresAtMs?: number
}): Promise<{ id: number, token: string }> {
  const { generateToken } = await import('../../app/Actions/Tokens/secret')
  const issued = generateToken()

  const row: any = await db
    .insertInto('access_tokens')
    .values({
      user_id: created.collaboratorId,
      name: options.name,
      prefix: issued.prefix,
      token_hash: issued.hash,
      selection: 'selected',
      expires_at: new Date(options.expiresAtMs ?? Date.now() + 86_400_000).toISOString(),
    })
    .returning(['id'])
    .executeTakeFirst()

  const id = Number(row?.id)

  await db
    .insertInto('access_token_permissions')
    // `contents` is the scope both git services map to - `repository:read`
    // wants it at read and `repository:push` at write. `repository` is the
    // ability prefix and not a scope, and the enum in the database refuses it,
    // which is the only reason that is discoverable.
    .values({ access_token_id: id, scope: 'contents', level: options.level })
    .execute()

  for (const repositoryId of options.repositoryIds) {
    await db
      .insertInto('access_token_repositories')
      .values({ access_token_id: id, repository_id: repositoryId })
      .execute()
  }

  return { id, token: issued.token }
}

beforeAll(async () => {
  // Only reaching the database is allowed to skip this file, and the try is
  // wrapped around exactly that. Everything after it throws.
  //
  // The wider version - one try around the whole of setup - is what the other
  // e2e files do and it cost the first run of this one: an enum value that does
  // not exist was caught, logged as "skipping", and reported as twelve passing
  // tests that had asserted nothing. A suite that goes green when its fixtures
  // are broken is worse than one that has no fixtures.
  try {
    const { injectGlobalAutoImports } = await import('@stacksjs/server')

    await injectGlobalAutoImports()
    db = (globalThis as any).db
    await db.selectFrom('users').select(['id']).limit(1).execute()
    available = true
  }
  catch (error) {
    console.warn(`[e2e] skipping, no database: ${error instanceof Error ? error.message : String(error)}`)
    available = false
    return
  }

  {
    ;({ authenticateToken } = await import('../../app/Actions/Tokens/authenticate'))
    ;({ mayUseService } = await import('../../app/Actions/Git/access'))

    created.handle = unique('tok')

    // Two accounts, because the interesting case is a token belonging to
    // somebody who is not the owner: an owner keeps their access whatever
    // happens to a collaborator row, so the removal would prove nothing.
    const owner: any = await db
      .insertInto('users')
      .values({ name: 'Token test owner', email: `${created.handle}o@example.com`, handle: `${created.handle}o`, password: 'x' })
      .returning(['id'])
      .executeTakeFirst()
    created.ownerId = Number(owner?.id)

    const collaborator: any = await db
      .insertInto('users')
      .values({ name: 'Token test collaborator', email: `${created.handle}c@example.com`, handle: `${created.handle}c`, password: 'x' })
      .returning(['id'])
      .executeTakeFirst()
    created.collaboratorId = Number(collaborator?.id)

    // Private on purpose. A public repository is readable by anybody, so a
    // token losing its reach into one would be invisible.
    for (const key of ['repositoryId', 'otherRepositoryId'] as const) {
      const name = unique('repo')
      created[key === 'repositoryId' ? 'repositoryName' : 'otherRepositoryName'] = name
      const repository: any = await db
        .insertInto('repositories')
        .values({
          owner_type: 'user',
          owner_id: created.ownerId,
          name,
          description: 'created by the token test',
          visibility: 'private',
          default_branch: 'main',
          disk_path: `${created.handle}o/${name}.git`,
        })
        .returning(['id'])
        .executeTakeFirst()

      created[key] = Number(repository?.id)
    }

    // Write on *both*, and the second one matters. The obvious setup - access
    // to one repository and none to the other - makes the scoping test pass
    // whether or not the scope is ever consulted, because the account half
    // refuses it first. Deliberately breaking `tokenReaches` and watching every
    // test stay green is how that was found. With access on both, a token
    // scoped to one and refused on the other can only have been refused by its
    // reach.
    await db
      .insertInto('repo_collaborators')
      .values({ repository_id: created.otherRepositoryId, user_id: created.collaboratorId, permission: 'write' })
      .execute()

    await db
      .insertInto('repo_collaborators')
      .values({ repository_id: created.repositoryId, user_id: created.collaboratorId, permission: 'write' })
      .execute()

    const live = await issueToken({ name: 'live', level: 'write', repositoryIds: [created.repositoryId] })
    created.tokenId = live.id
    secret = live.token

    // Scoped to the repository its owner cannot reach. Both halves have to say
    // yes, so this one should fail on the user's side while the token's side is
    // perfectly happy.
    const other = await issueToken({ name: 'other', level: 'write', repositoryIds: [created.otherRepositoryId] })
    created.otherTokenId = other.id
    otherSecret = other.token

    // Read on a repository its owner may push to. Nothing else here can refuse
    // a push with it, so it is the only fixture that puts `tokenAllows` on the
    // hook: with every token granting write, deleting that check changes no
    // answer in this file.
    const readOnly = await issueToken({ name: 'read only', level: 'read', repositoryIds: [created.repositoryId] })
    created.readTokenId = readOnly.id
    readSecret = readOnly.token
  }
// Connecting to Postgres on a cold cache does not fit bun's five second budget.
}, 120_000)

afterAll(async () => {
  try {
    for (const id of [created.tokenId, created.otherTokenId, created.readTokenId].filter(Boolean)) {
      await db.deleteFrom('access_token_repositories').where('access_token_id', '=', id).execute()
      await db.deleteFrom('access_token_permissions').where('access_token_id', '=', id).execute()
      await db.deleteFrom('access_tokens').where('id', '=', id).execute()
    }

    for (const id of [created.repositoryId, created.otherRepositoryId].filter(Boolean)) {
      await db.deleteFrom('repo_collaborators').where('repository_id', '=', id).execute()
      await db.deleteFrom('repositories').where('id', '=', id).execute()
    }

    for (const id of [created.collaboratorId, created.ownerId].filter(Boolean))
      await db.deleteFrom('users').where('id', '=', id).execute()
  }
  catch { /* a failed setup leaves less behind than it made */ }
})

describe('a token, read back from the database', () => {
  test('authenticates and carries its grants and its reach', async () => {
    if (!available)
      return

    const result = await authenticateToken(secret)

    expect(result.ok).toBe(true)
    if (!result.ok)
      return

    expect(result.token.userId).toBe(created.collaboratorId)
    expect(result.token.grants).toContainEqual({ scope: 'contents', level: 'write' })
    expect(result.token.reach.selection).toBe('selected')
    expect(result.token.reach.repositoryIds).toEqual([created.repositoryId])
  })

  test('a wrong secret under a real prefix is unknown, not a near miss', async () => {
    if (!available)
      return

    // Same prefix, different secret. The row is found and the hash does not
    // match, and the answer has to be the same `unknown` an unrecognised prefix
    // gets - otherwise the pair of answers tells somebody which half they got
    // right, and a token becomes guessable one half at a time.
    const parts = secret.split('_')
    const forged = `${parts[0]}_${parts[1]}_${'0'.repeat(parts[2]!.length)}`

    const result = await authenticateToken(forged)

    expect(result).toEqual({ ok: false, reason: 'unknown' })
  })

  test('something that is not one of ours costs no query', async () => {
    if (!available)
      return

    expect(await authenticateToken('github_pat_11ABCDE')).toEqual({ ok: false, reason: 'malformed' })
  })
})

describe('revocation', () => {
  test('stops the token on the very next request', async () => {
    if (!available)
      return

    // Before. Asserted in the same test as the after, deliberately: the claim
    // is about the transition, and two tests could both pass with a token that
    // was never usable.
    expect((await authenticateToken(secret)).ok).toBe(true)

    await db
      .updateTable('access_tokens')
      .set({ revoked_at: new Date().toISOString(), revoked_by_id: created.collaboratorId })
      .where('id', '=', created.tokenId)
      .execute()

    const after = await authenticateToken(secret)

    expect(after).toEqual({ ok: false, reason: 'revoked' })
  })

  test('still reports revoked once the expiry has also passed', async () => {
    if (!available)
      return

    // Both facts are true at this point and only one of them is the useful
    // answer. Somebody reading an audit log needs to know the token was taken
    // away, not that it would have lapsed anyway.
    await db
      .updateTable('access_tokens')
      .set({ expires_at: new Date(Date.now() - 60_000).toISOString() })
      .where('id', '=', created.tokenId)
      .execute()

    expect(await authenticateToken(secret)).toEqual({ ok: false, reason: 'revoked' })

    // Put it back, so the reach tests below have a live token to work with.
    await db
      .updateTable('access_tokens')
      .set({ revoked_at: null, revoked_by_id: null, expires_at: new Date(Date.now() + 86_400_000).toISOString() })
      .where('id', '=', created.tokenId)
      .execute()

    expect((await authenticateToken(secret)).ok).toBe(true)
  })

  test('an expired token reports expired rather than unknown', async () => {
    if (!available)
      return

    await db
      .updateTable('access_tokens')
      .set({ expires_at: new Date(Date.now() - 60_000).toISOString() })
      .where('id', '=', created.tokenId)
      .execute()

    expect(await authenticateToken(secret)).toEqual({ ok: false, reason: 'expired' })

    await db
      .updateTable('access_tokens')
      .set({ expires_at: new Date(Date.now() + 86_400_000).toISOString() })
      .where('id', '=', created.tokenId)
      .execute()
  })
})

describe('a token never widens what its owner can do', () => {
  test('the write token pushes while its owner is a collaborator', async () => {
    if (!available)
      return

    const result = await authenticateToken(secret)
    expect(result.ok).toBe(true)
    if (!result.ok)
      return

    const repository = await repositoryRow(created.repositoryName)

    expect(await mayUseService(repository, created.collaboratorId, 'receive-pack', result.token)).toBe(true)
    expect(await mayUseService(repository, created.collaboratorId, 'upload-pack', result.token)).toBe(true)
  })

  test('losing repository access takes the token with it', async () => {
    if (!available)
      return

    // Nothing is done to the token here. Its row still says write, still lists
    // this repository, and still authenticates - which is the point: revocation
    // has to follow from the access being gone, not from anybody remembering.
    await db
      .deleteFrom('repo_collaborators')
      .where('repository_id', '=', created.repositoryId)
      .where('user_id', '=', created.collaboratorId)
      .execute()

    const result = await authenticateToken(secret)
    expect(result.ok).toBe(true)
    if (!result.ok)
      return

    const repository = await repositoryRow(created.repositoryName)

    expect(await mayUseService(repository, created.collaboratorId, 'upload-pack', result.token)).toBe(false)
    expect(await mayUseService(repository, created.collaboratorId, 'receive-pack', result.token)).toBe(false)
  })

  test('a demotion to read stops the write token pushing', async () => {
    if (!available)
      return

    await db
      .insertInto('repo_collaborators')
      .values({ repository_id: created.repositoryId, user_id: created.collaboratorId, permission: 'read' })
      .execute()

    const result = await authenticateToken(secret)
    expect(result.ok).toBe(true)
    if (!result.ok)
      return

    const repository = await repositoryRow(created.repositoryName)

    // The token still grants write. The account no longer does, and the
    // intersection is what decides.
    expect(await mayUseService(repository, created.collaboratorId, 'upload-pack', result.token)).toBe(true)
    expect(await mayUseService(repository, created.collaboratorId, 'receive-pack', result.token)).toBe(false)
  })

  test('a read-only token cannot push for a maintainer who can', async () => {
    if (!available)
      return

    // The demotion test above left this account on read, which would refuse the
    // push on its own and let a deleted `tokenAllows` go unnoticed. The whole
    // point here is that the account half says yes.
    await db
      .updateTable('repo_collaborators')
      .set({ permission: 'write' })
      .where('repository_id', '=', created.repositoryId)
      .where('user_id', '=', created.collaboratorId)
      .execute()

    const result = await authenticateToken(readSecret)
    expect(result.ok).toBe(true)
    if (!result.ok)
      return

    const repository = await repositoryRow(created.repositoryName)

    // The account half says yes to both - this is a write collaborator - and
    // the token reaches the repository. The grant is the only thing that can
    // separate the two answers, which is what a scoped token is for.
    expect(await mayUseService(repository, created.collaboratorId, 'upload-pack', result.token)).toBe(true)
    expect(await mayUseService(repository, created.collaboratorId, 'receive-pack', result.token)).toBe(false)
  })

  test('a token scoped elsewhere cannot reach this repository', async () => {
    if (!available)
      return

    const result = await authenticateToken(secret)
    expect(result.ok).toBe(true)
    if (!result.ok)
      return

    // Same owner, same grants, and its owner is a write collaborator here too -
    // so the account half says yes and the only thing left to refuse it is the
    // scope. Without that second collaborator row this test passes even with
    // `tokenReaches` deleted.
    const elsewhere = await repositoryRow(created.otherRepositoryName)

    expect(await mayUseService(elsewhere, created.collaboratorId, 'upload-pack', result.token)).toBe(false)

    // And the token issued for that repository is fine there, which is what
    // makes the line above a scope refusal rather than a broken fixture.
    const permitted = await authenticateToken(otherSecret)
    expect(permitted.ok).toBe(true)
    if (!permitted.ok)
      return

    expect(await mayUseService(elsewhere, created.collaboratorId, 'upload-pack', permitted.token)).toBe(true)
  })

  test('a token cannot be presented as another account', async () => {
    if (!available)
      return

    // The demotion test above left this account on read, and the assertion
    // below needs a request that would otherwise succeed.
    await db
      .updateTable('repo_collaborators')
      .set({ permission: 'write' })
      .where('repository_id', '=', created.repositoryId)
      .where('user_id', '=', created.collaboratorId)
      .execute()

    const result = await authenticateToken(secret)
    expect(result.ok).toBe(true)
    if (!result.ok)
      return

    const repository = await repositoryRow(created.repositoryName)

    // Everything else about this request is in order: the repository's owner
    // may push to their own repository, and the token reaches it and grants
    // write. The one thing wrong is that the token belongs to somebody else, so
    // the identity check is the only guard that can refuse it - which is the
    // point of asserting it against a request that would otherwise succeed.
    expect(await mayUseService(repository, created.ownerId, 'receive-pack', result.token)).toBe(false)

    // The same token, presented as its own owner, is allowed. Otherwise the
    // line above would pass on a token that never worked at all.
    expect(await mayUseService(repository, created.collaboratorId, 'receive-pack', result.token)).toBe(true)
  })
})

describe('an archived repository', () => {
  test('is readable and refuses the push before any grant is consulted', async () => {
    if (!available)
      return

    await db
      .updateTable('repositories')
      .set({ is_archived: true })
      .where('id', '=', created.repositoryId)
      .execute()

    // Promote back to write, so the only thing standing in the way is the
    // archive flag.
    await db
      .updateTable('repo_collaborators')
      .set({ permission: 'write' })
      .where('repository_id', '=', created.repositoryId)
      .where('user_id', '=', created.collaboratorId)
      .execute()

    const result = await authenticateToken(secret)
    expect(result.ok).toBe(true)
    if (!result.ok)
      return

    const repository = await repositoryRow(created.repositoryName)

    expect(await mayUseService(repository, created.collaboratorId, 'upload-pack', result.token)).toBe(true)
    expect(await mayUseService(repository, created.collaboratorId, 'receive-pack', result.token)).toBe(false)
  })
})

describe('the tokens settings page reads', () => {
  test('describes what a token can do in the words of the checks', async () => {
    if (!available)
      return

    const { tokensFor } = await import('../../app/Actions/Tokens/load')
    const listings = await tokensFor(created.collaboratorId)

    // Three were issued in setup, and all three are listed - including any that
    // have been revoked. Hiding a revoked token would mean somebody who just
    // revoked one could not see that it happened.
    expect(listings.length).toBe(3)

    const readOnly = listings.find(listing => listing.name === 'read only')
    expect(readOnly).toBeDefined()

    // The point of the page: a sentence, not `contents: read`.
    expect(readOnly!.abilities).toEqual(['Clone and read code'])
    expect(readOnly!.masked).not.toContain(readSecret.split('_')[2])

    const live = listings.find(listing => listing.name === 'live')
    expect(live!.abilities).toEqual(['Push code, and merge pull requests'])
  })

  test('names the repositories a token reaches rather than counting them', async () => {
    if (!available)
      return

    const { tokensFor } = await import('../../app/Actions/Tokens/load')
    const listings = await tokensFor(created.collaboratorId)
    const live = listings.find(listing => listing.name === 'live')!

    expect(live.repositories).toEqual([created.repositoryName])
    expect(live.reach).toBe('1 repository')
  })

  test('a token whose repositories are all gone says so', async () => {
    if (!available)
      return

    const { tokensFor } = await import('../../app/Actions/Tokens/load')

    // The scoping rows cascade with the repository, so a token can end up
    // reaching nothing at all. Rendered as a count that would read "0
    // repositories", which looks like a display bug rather than the fact it is.
    await db
      .deleteFrom('access_token_repositories')
      .where('access_token_id', '=', created.otherTokenId)
      .execute()

    const listing = (await tokensFor(created.collaboratorId)).find(entry => entry.name === 'other')!

    expect(listing.repositories).toEqual([])
    expect(listing.reach).toContain('has been deleted')
  })

  test('an unused token is visible as unused', async () => {
    if (!available)
      return

    const { tokensFor } = await import('../../app/Actions/Tokens/load')
    const { recordTokenUse } = await import('../../app/Actions/Tokens/authenticate')

    const before = (await tokensFor(created.collaboratorId)).find(entry => entry.name === 'live')!
    expect(before.neverUsed).toBe(true)
    expect(before.lastUsedAt).toBeNull()

    await recordTokenUse(created.tokenId, '203.0.113.7')

    const after = (await tokensFor(created.collaboratorId)).find(entry => entry.name === 'live')!

    expect(after.neverUsed).toBe(false)
    expect(after.lastUsedAt).not.toBeNull()
    // Where it was used from, which is how somebody spots a token still live on
    // a machine they decommissioned.
    expect(after.lastUsedIp).toBe('203.0.113.7')
  })

  test('offers only repositories this account can actually scope to', async () => {
    if (!available)
      return

    const { scopableRepositories } = await import('../../app/Actions/Tokens/load')
    const offered = await scopableRepositories(created.collaboratorId)
    const names = offered.map(entry => entry.name)

    // A collaborator on both, and the owner of neither. Offering a repository
    // the endpoint would silently drop is how somebody ends up holding a token
    // that reaches nothing.
    expect(names).toContain(created.repositoryName)
    expect(names).toContain(created.otherRepositoryName)

    const strangers = await scopableRepositories(created.ownerId)
    expect(strangers.map(entry => entry.name)).toContain(created.repositoryName)
  })
})

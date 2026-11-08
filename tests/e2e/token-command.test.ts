// `buddy token:create` and `buddy token:revoke`, against the database.
//
// Automation that needed a token (HQ's CI cancelling superseded runs) had no
// way to get one but inserting rows into `access_tokens` by hand. These pin the
// command to the same rules and the same audit line as the settings page: the
// token it prints authenticates with exactly the grants and reach asked for, a
// repository the owner cannot read is refused rather than dropped, and the
// operator who acted is on the audit row.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { authenticateToken } from '../../app/Actions/Tokens/authenticate'
import { createTokenFromCli, parsePermissions, revokeTokenFromCli } from '../../app/Commands/Tokens'

const created = { userId: 0, otherId: 0, handle: '', otherHandle: '', repositoryId: 0, privateId: 0, name: '', privateName: '' }

let available = false
let db: any = null

function unique(prefix: string): string {
  return `${prefix}${Buffer.from(crypto.getRandomValues(new Uint8Array(5))).toString('hex')}`
}

beforeAll(async () => {
  try {
    const { injectGlobalAutoImports } = await import('@stacksjs/server')
    await injectGlobalAutoImports()
    db = (globalThis as any).db
    await db.selectFrom('users').select(['id']).limit(1).execute()

    created.handle = unique('tc')
    const user: any = await db.insertInto('users')
      .values({ name: 'Token Command', email: `${created.handle}@example.com`, handle: created.handle, password: 'x' })
      .returning(['id']).executeTakeFirst()
    created.userId = Number(user.id)

    created.otherHandle = unique('tco')
    const other: any = await db.insertInto('users')
      .values({ name: 'Somebody Else', email: `${created.otherHandle}@example.com`, handle: created.otherHandle, password: 'x' })
      .returning(['id']).executeTakeFirst()
    created.otherId = Number(other.id)

    created.name = unique('repo')
    const repository: any = await db.insertInto('repositories')
      .values({ owner_type: 'user', owner_id: created.userId, name: created.name, visibility: 'private', default_branch: 'main', disk_path: `${created.handle}/${created.name}.git` })
      .returning(['id']).executeTakeFirst()
    created.repositoryId = Number(repository.id)

    // Somebody else's private repository, which the first account cannot read.
    created.privateName = unique('secret')
    const hidden: any = await db.insertInto('repositories')
      .values({ owner_type: 'user', owner_id: created.otherId, name: created.privateName, visibility: 'private', default_branch: 'main', disk_path: `${created.otherHandle}/${created.privateName}.git` })
      .returning(['id']).executeTakeFirst()
    created.privateId = Number(hidden.id)

    available = true
  }
  catch (error) {
    console.warn(`[token-command] skipping: ${error instanceof Error ? error.message : String(error)}`)
    available = false
  }
}, 120_000)

afterAll(async () => {
  try {
    for (const userId of [created.userId, created.otherId].filter(Boolean)) {
      const tokens: any[] = await db.selectFrom('access_tokens').select(['id']).where('user_id', '=', userId).execute()
      for (const token of tokens) {
        await db.deleteFrom('access_token_permissions').where('access_token_id', '=', Number(token.id)).execute()
        await db.deleteFrom('access_token_repositories').where('access_token_id', '=', Number(token.id)).execute()
        await db.deleteFrom('audit_events').where('subject_type', '=', 'access_token').where('subject_id', '=', Number(token.id)).execute()
      }
      await db.deleteFrom('access_tokens').where('user_id', '=', userId).execute()
    }
    for (const id of [created.repositoryId, created.privateId].filter(Boolean))
      await db.deleteFrom('repositories').where('id', '=', id).execute()
    for (const id of [created.userId, created.otherId].filter(Boolean))
      await db.deleteFrom('users').where('id', '=', id).execute()
  }
  catch { /* the next run uses fresh names */ }
})

describe('reading --permission', () => {
  test('scope:level pairs are read as grants', () => {
    const parsed = parsePermissions(['actions:write', 'actions_logs:read'])
    expect(parsed.ok && parsed.value).toEqual([{ scope: 'actions', level: 'write' }, { scope: 'actions_logs', level: 'read' }])
  })

  test('a typo is refused, naming what is known, rather than dropped', () => {
    const parsed = parsePermissions(['action:write'])
    expect(parsed.ok).toBe(false)
    expect(!parsed.ok && parsed.error).toContain('`action` is not a token scope')
  })

  test('as are a bad level, a bad shape and nothing at all', () => {
    expect(parsePermissions(['actions:execute']).ok).toBe(false)
    expect(parsePermissions(['actions']).ok).toBe(false)
    expect(parsePermissions([]).ok).toBe(false)
  })
})

describe('token:create', () => {
  test('prints a token that authenticates with the grants and reach asked for, and audits it', async () => {
    if (!available)
      return

    const now = Date.now()
    const made = await createTokenFromCli({
      user: `${created.handle}@example.com`,
      name: 'CI automation',
      repository: `${created.handle}/${created.name}`,
      permission: ['actions:write', 'actions_logs:read'],
      expiresInDays: '1',
    }, now)

    expect(made.ok).toBe(true)
    if (!made.ok)
      return

    expect(made.value.token.startsWith(`${made.value.prefix}_`)).toBe(true)
    expect(made.value.selection).toBe('selected')
    expect(made.value.repository_ids).toEqual([created.repositoryId])
    expect(Date.parse(made.value.expires_at)).toBe(now + 86_400_000)

    const authenticated = await authenticateToken(made.value.token)
    expect(authenticated.ok).toBe(true)
    if (authenticated.ok) {
      expect(authenticated.token.userId).toBe(created.userId)
      expect(authenticated.token.grants.map((grant: any) => `${grant.scope}:${grant.level}`).sort()).toEqual(['actions:write', 'actions_logs:read'])
    }

    // The hash is stored, never the secret.
    const row: any = await db.selectFrom('access_tokens').select(['token_hash']).where('id', '=', made.value.id).executeTakeFirst()
    expect(String(row.token_hash)).not.toContain(made.value.token)

    const audit: any = await db.selectFrom('audit_events')
      .select(['action', 'actor_id', 'external_actor', 'detail'])
      .where('subject_type', '=', 'access_token').where('subject_id', '=', made.value.id)
      .executeTakeFirst()
    expect(audit.action).toBe('token:created')
    // An operator at the shell, not the account the token belongs to.
    expect(audit.actor_id).toBeNull()
    expect(String(audit.external_actor)).toStartWith('cli:')
    expect(String(audit.detail)).not.toContain(made.value.token)
  })

  test('the account can be named by handle', async () => {
    if (!available)
      return

    const made = await createTokenFromCli({ user: created.handle, name: 'by handle', all: true, permission: 'contents:read' })
    expect(made.ok && made.value.selection).toBe('all')
  })

  test('a repository the account cannot read is refused, and nothing is issued', async () => {
    if (!available)
      return

    const before: any[] = await db.selectFrom('access_tokens').select(['id']).where('user_id', '=', created.userId).execute()
    const made = await createTokenFromCli({
      user: created.handle,
      name: 'too far',
      repository: [`${created.handle}/${created.name}`, `${created.otherHandle}/${created.privateName}`],
      permission: 'actions:write',
    })

    expect(made.ok).toBe(false)
    expect(!made.ok && made.error).toContain(`${created.otherHandle}/${created.privateName}`)
    const after: any[] = await db.selectFrom('access_tokens').select(['id']).where('user_id', '=', created.userId).execute()
    expect(after.length).toBe(before.length)
  })

  test('the shared rules still apply: a name, an account, a reach and a lifetime inside the ceiling', async () => {
    if (!available)
      return

    const base = { user: created.handle, name: 'x', all: true, permission: 'contents:read' }
    expect((await createTokenFromCli({ ...base, name: '' })).ok).toBe(false)
    expect((await createTokenFromCli({ ...base, user: 'nobody-here@example.com' })).ok).toBe(false)
    expect((await createTokenFromCli({ ...base, all: false })).ok).toBe(false)
    expect((await createTokenFromCli({ ...base, repository: `${created.handle}/${created.name}` })).ok).toBe(false)
    expect((await createTokenFromCli({ ...base, expiresInDays: '0' })).ok).toBe(false)
    const tooLong = await createTokenFromCli({ ...base, expiresInDays: '400' })
    expect(!tooLong.ok && tooLong.error).toContain('cannot last longer')
  })
})

describe('token:revoke', () => {
  test('stops the token on its next use and records who did it', async () => {
    if (!available)
      return

    const made = await createTokenFromCli({ user: created.handle, name: 'short lived', all: true, permission: 'contents:read' })
    expect(made.ok).toBe(true)
    if (!made.ok)
      return

    const revoked = await revokeTokenFromCli(made.value.id, 'rotated')
    expect(revoked.ok && revoked.value.alreadyRevoked).toBe(false)

    const authenticated = await authenticateToken(made.value.token)
    expect(authenticated.ok).toBe(false)
    expect(!authenticated.ok && authenticated.reason).toBe('revoked')

    const audit: any = await db.selectFrom('audit_events')
      .select(['actor_id', 'external_actor', 'reason'])
      .where('subject_type', '=', 'access_token').where('subject_id', '=', made.value.id)
      .where('action', '=', 'token:revoked')
      .executeTakeFirst()
    expect(audit.actor_id).toBeNull()
    expect(String(audit.external_actor)).toStartWith('cli:')
    expect(audit.reason).toBe('rotated')

    // A second revocation says so rather than writing a second line.
    const again = await revokeTokenFromCli(made.value.id, null)
    expect(again.ok && again.value.alreadyRevoked).toBe(true)
  })

  test('an id that names no token is refused', async () => {
    if (!available)
      return

    expect((await revokeTokenFromCli(0, null)).ok).toBe(false)
    expect((await revokeTokenFromCli(2_000_000_000, null)).ok).toBe(false)
  })
})

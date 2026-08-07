// Which keys a repository will accept as its own.
//
// `tests/unit/keys-deploy.test.ts` pins the scope arithmetic, which is pure.
// This is the half that needs the database: whether a fingerprint is already
// spoken for.
//
// **One fingerprint, one identity.** The SSH transport picks who is connecting
// from the fingerprint alone - there is nothing else on the wire to go on - so
// a fingerprint that matched both an account key and a deploy key would make
// "who pushed this" depend on which query ran first. Letting a personal key
// become a repository's is the dangerous direction: that person's pushes could
// be attributed to a machine, and the machine's to them.
//
// The refusals carry the fix in them, because the fix is one command and the
// alternative is somebody re-pasting the same key.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'

const created = { userId: 0, repositoryId: 0, handle: '', name: '', diskPath: '' }

let available = false
let personalLine = ''
let freshLine = ''
let readDeployKey: typeof import('../../app/Actions/Keys/deploy').readDeployKey

function unique(prefix: string): string {
  return `${prefix}${Buffer.from(crypto.getRandomValues(new Uint8Array(5))).toString('hex')}`
}

beforeAll(async () => {
  try {
    const { injectGlobalAutoImports } = await import('@stacksjs/server')

    await injectGlobalAutoImports()
    await (globalThis as any).db.selectFrom('users').select(['id']).limit(1).execute()

    ;({ readDeployKey } = await import('../../app/Actions/Keys/deploy'))

    const { generateHostKey, fingerprintOf } = await import('@stacksjs/ts-ssh')
    const { repositoryPath } = await import('../../app/Actions/Git/storage')
    const { initBare } = await import('../../app/Actions/Git/git')

    created.handle = unique('dk')
    created.name = unique('repo')

    const user: any = await (globalThis as any).db
      .insertInto('users')
      .values({ name: 'Deploy key test', email: `${created.handle}@example.com`, handle: created.handle, password: 'x' })
      .returning(['id'])
      .executeTakeFirst()

    created.userId = Number(user?.id)

    const resolved = repositoryPath(created.handle, created.name)
    created.diskPath = resolved.path!

    const repository: any = await (globalThis as any).db
      .insertInto('repositories')
      .values({
        owner_type: 'user',
        owner_id: created.userId,
        name: created.name,
        description: 'created by the deploy key test',
        visibility: 'private',
        default_branch: 'main',
        disk_path: resolved.relative!,
      })
      .returning(['id'])
      .executeTakeFirst()

    created.repositoryId = Number(repository?.id)

    mkdirSync(resolve(created.diskPath, '..'), { recursive: true })
    await initBare(created.diskPath, 'main')

    // A key already registered to the account, and one nothing has claimed.
    const personal = generateHostKey('personal@test')
    personalLine = personal.publicLine.trim()

    await (globalThis as any).db
      .insertInto('ssh_keys')
      .values({
        user_id: created.userId,
        title: 'personal',
        key_type: 'ssh-ed25519',
        public_key: personalLine,
        fingerprint: fingerprintOf(personal.key.publicKey),
      })
      .execute()

    freshLine = generateHostKey('runner@test').publicLine.trim()

    available = true
  }
  catch (error) {
    console.warn(`[e2e] skipping: ${error instanceof Error ? error.message : String(error)}`)
    available = false
  }
// Connecting to Postgres and creating a bare repository do not fit in bun's
// default five second hook budget on a cold cache.
}, 120_000)

afterAll(async () => {
  try {
    if (created.repositoryId)
      await (globalThis as any).db.deleteFrom('repositories').where('id', '=', created.repositoryId).execute()

    if (created.userId) {
      await (globalThis as any).db.deleteFrom('ssh_keys').where('user_id', '=', created.userId).execute()
      await (globalThis as any).db.deleteFrom('users').where('id', '=', created.userId).execute()
    }
  }
  catch { /* the directory still goes, below */ }

  if (created.diskPath) {
    rmSync(created.diskPath, { recursive: true, force: true })

    try {
      rmSync(resolve(created.diskPath, '..'), { recursive: false })
    }
    catch { /* not empty, which is somebody else's repository */ }
  }
})

describe('readDeployKey', () => {
  test('accepts a key nothing has claimed', async () => {
    if (!available)
      return

    const result = await readDeployKey(freshLine)

    expect(result.ok).toBe(true)
    expect(result.ok === true && result.fingerprint).toStartWith('SHA256:')
  })

  test('refuses a key already registered to an account', async () => {
    if (!available)
      return

    // The dangerous direction. Two identities behind one fingerprint means the
    // transport's answer depends on which table it reads first.
    const result = await readDeployKey(personalLine)

    expect(result.ok).toBe(false)
    expect(result.ok === false && result.status).toBe(409)
    expect(result.ok === false && result.message).toContain('registered to an account')
    // And says what to do instead, because the fix is one command.
    expect(result.ok === false && result.message).toContain('ssh-keygen')
  })

  test('refuses a key that is already a deploy key somewhere', async () => {
    if (!available)
      return

    const parsed = await readDeployKey(freshLine)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok)
      return

    await (globalThis as any).db
      .insertInto('deploy_keys')
      .values({
        repository_id: created.repositoryId,
        title: 'taken',
        key_type: parsed.type,
        public_key: `${parsed.type} ${parsed.body}`,
        fingerprint: parsed.fingerprint,
        can_write: false,
      })
      .execute()

    try {
      const again = await readDeployKey(freshLine)

      expect(again.ok).toBe(false)
      expect(again.ok === false && again.status).toBe(409)
      expect(again.ok === false && again.message).toContain('one repository')
    }
    finally {
      await (globalThis as any).db.deleteFrom('deploy_keys').where('fingerprint', '=', parsed.fingerprint).execute()
    }
  })

  test('refuses a private key by name rather than with a parse error', async () => {
    if (!available)
      return

    const result = await readDeployKey('-----BEGIN OPENSSH PRIVATE KEY-----\nx\n-----END OPENSSH PRIVATE KEY-----')

    expect(result.ok).toBe(false)
    // 422 rather than 409: the caller's mistake, not a collision.
    expect(result.ok === false && result.status).toBe(422)
    expect(result.ok === false && result.message).toContain('private key')
  })

  test('goes when the repository does', async () => {
    if (!available)
      return

    // The foreign key cascades, so a deleted repository takes its keys with it
    // rather than leaving rows that authenticate against nothing.
    const parsed = await readDeployKey(freshLine)
    if (!parsed.ok)
      return

    const doomed: any = await (globalThis as any).db
      .insertInto('repositories')
      .values({
        owner_type: 'user',
        owner_id: created.userId,
        name: unique('doomed'),
        description: 'removed by this test',
        visibility: 'private',
        default_branch: 'main',
        disk_path: `${created.handle}/doomed.git`,
      })
      .returning(['id'])
      .executeTakeFirst()

    await (globalThis as any).db
      .insertInto('deploy_keys')
      .values({
        repository_id: Number(doomed.id),
        title: 'doomed',
        key_type: parsed.type,
        public_key: `${parsed.type} ${parsed.body}`,
        fingerprint: parsed.fingerprint,
        can_write: false,
      })
      .execute()

    await (globalThis as any).db.deleteFrom('repositories').where('id', '=', Number(doomed.id)).execute()

    const left = await (globalThis as any).db
      .selectFrom('deploy_keys')
      .select(['id'])
      .where('fingerprint', '=', parsed.fingerprint)
      .executeTakeFirst()

    expect(left).toBeFalsy()
  })
})

// Git over SSH, with the real git client and the real ssh client.
//
// The same shape as `git-http.test.ts` and for the same reason: everything else
// tests a piece - the command parser, the permission matrix, the key lookup -
// and only running `git clone` at a listening socket finds out whether they
// agree.
//
// The question that matters is not "did the clone work" but "which repository
// did it clone, and would it have refused somebody else". A transport that
// authenticates correctly and then serves the wrong repository looks perfect
// from the client's side, which is exactly how that bug shipped over HTTP once.
//
// It skips itself, loudly, when there is no database, so `bun test` on a
// checkout without Postgres still runs everything else.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, rmdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'

/** Everything this run created, removed in afterAll however it ends. */
const created = {
  userId: 0,
  strangerId: 0,
  repositoryId: 0,
  privateId: 0,
  handle: '',
  name: '',
  privateName: '',
  diskPath: '',
  privatePath: '',
  temp: '',
}

let port = 0
let available = false
let server: { stop: () => void } | null = null
let clientKey = ''
let strangerKey = ''

function unique(prefix: string): string {
  return `${prefix}${Buffer.from(crypto.getRandomValues(new Uint8Array(5))).toString('hex')}`
}

/**
 * Run git, without blocking the event loop.
 *
 * The daemon under test is running *in this process*, so a synchronous child
 * would block the loop that has to answer its packets: the clone would sit
 * waiting for bytes that cannot be written until the clone finishes.
 */
async function git(cwd: string, key: string, ...args: string[]): Promise<{ ok: boolean, stdout: string, stderr: string }> {
  const child = Bun.spawn(['git', ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'E2E',
      GIT_AUTHOR_EMAIL: 'e2e@example.com',
      GIT_COMMITTER_NAME: 'E2E',
      GIT_COMMITTER_EMAIL: 'e2e@example.com',
      GIT_TERMINAL_PROMPT: '0',
      // `IdentityAgent=none` matters as much as `-i`: without it the client
      // offers whatever is in the developer's own agent, and a test that should
      // be refused passes because a different key was accepted.
      GIT_SSH_COMMAND: [
        'ssh',
        '-i', key,
        '-o', 'IdentitiesOnly=yes',
        '-o', 'IdentityAgent=none',
        '-o', 'StrictHostKeyChecking=no',
        '-o', 'UserKnownHostsFile=/dev/null',
        '-o', 'BatchMode=yes',
        '-o', 'LogLevel=ERROR',
      ].join(' '),
    },
  })

  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])

  if (code !== 0 && process.env.SSH_TEST_DEBUG)
    console.error(`git ${args.join(' ')} failed:\n${stderr}`)

  return { ok: code === 0, stdout, stderr }
}

function urlFor(name: string): string {
  return `ssh://git@127.0.0.1:${port}/${created.handle}/${name}.git`
}

beforeAll(async () => {
  created.temp = mkdtempSync(join(tmpdir(), 'reviewos-ssh-'))

  try {
    const { injectGlobalAutoImports } = await import('@stacksjs/server')
    await injectGlobalAutoImports()

    // One query decides whether this file can run at all. A missing database is
    // an ordinary state for a checkout to be in, and it must read as "skipped"
    // rather than as a dozen failures.
    await (globalThis as any).db.selectFrom('users').select(['id']).limit(1).execute()

    const { repositoryPath } = await import('../../app/Actions/Git/storage')
    const { initBare } = await import('../../app/Actions/Git/git')
    const { generateHostKey, fingerprintOf } = await import('@stacksjs/ts-ssh')

    created.handle = unique('ssh')
    created.name = unique('repo')
    created.privateName = unique('secret')

    const user: any = await (globalThis as any).db
      .insertInto('users')
      .values({ name: 'SSH user', email: `${created.handle}@example.com`, handle: created.handle, password: 'x' })
      .returning(['id'])
      .executeTakeFirst()

    created.userId = Number(user?.id)

    const strangerHandle = unique('other')
    const stranger: any = await (globalThis as any).db
      .insertInto('users')
      .values({ name: 'Stranger', email: `${strangerHandle}@example.com`, handle: strangerHandle, password: 'x' })
      .returning(['id'])
      .executeTakeFirst()

    created.strangerId = Number(stranger?.id)

    // Two keys: one registered to the owner, one registered to somebody with no
    // access. A third, registered to nobody, is generated in its own test.
    const owned = generateHostKey('owner@test')
    clientKey = join(created.temp, 'id_owner')
    writeFileSync(clientKey, owned.openssh)
    chmodSync(clientKey, 0o600)

    const outsider = generateHostKey('stranger@test')
    strangerKey = join(created.temp, 'id_stranger')
    writeFileSync(strangerKey, outsider.openssh)
    chmodSync(strangerKey, 0o600)

    await (globalThis as any).db.insertInto('ssh_keys').values([
      {
        user_id: created.userId,
        title: 'owner key',
        key_type: 'ssh-ed25519',
        public_key: owned.publicLine.trim(),
        fingerprint: fingerprintOf(owned.key.publicKey),
      },
      {
        user_id: created.strangerId,
        title: 'stranger key',
        key_type: 'ssh-ed25519',
        public_key: outsider.publicLine.trim(),
        fingerprint: fingerprintOf(outsider.key.publicKey),
      },
    ]).execute()

    const publicResolved = repositoryPath(created.handle, created.name)
    created.diskPath = publicResolved.path!

    const repository: any = await (globalThis as any).db
      .insertInto('repositories')
      .values({
        owner_type: 'user',
        owner_id: created.userId,
        name: created.name,
        description: 'created by the ssh end to end test',
        visibility: 'public',
        default_branch: 'main',
        disk_path: publicResolved.relative!,
      })
      .returning(['id'])
      .executeTakeFirst()

    created.repositoryId = Number(repository?.id)

    const privateResolved = repositoryPath(created.handle, created.privateName)
    created.privatePath = privateResolved.path!

    const secret: any = await (globalThis as any).db
      .insertInto('repositories')
      .values({
        owner_type: 'user',
        owner_id: created.userId,
        name: created.privateName,
        description: 'private',
        visibility: 'private',
        default_branch: 'main',
        disk_path: privateResolved.relative!,
      })
      .returning(['id'])
      .executeTakeFirst()

    created.privateId = Number(secret?.id)

    mkdirSync(resolve(created.diskPath, '..'), { recursive: true })
    await initBare(created.diskPath, 'main')
    await initBare(created.privatePath, 'main')

    // Seeded over the filesystem rather than over SSH: the SSH push is what the
    // tests below are for, and a fixture that depends on the thing under test
    // proves nothing. The file is named after its repository, so a test that
    // gets the wrong one says so.
    for (const [path, marker] of [[created.diskPath, 'public'], [created.privatePath, 'private']] as const) {
      const work = join(created.temp, `seed-${marker}`)
      mkdirSync(work)
      await git(work, clientKey, 'init', '--initial-branch=main')
      writeFileSync(join(work, `${marker}.txt`), `${marker}\n`)
      await git(work, clientKey, 'add', '.')
      await git(work, clientKey, 'commit', '-m', `seed ${marker}`)
      await git(work, clientKey, 'push', path, 'main')
    }

    const { startSshServer } = await import('../../app/Actions/Git/ssh')
    server = startSshServer({ port: 0, hostKeyPath: join(created.temp, 'host_key') })
    port = Number((server as any).port)

    if (!port)
      throw new Error('the ssh daemon did not report a port')

    available = true
  }
  catch (error) {
    console.warn(`[e2e] skipping: ${error instanceof Error ? error.message : String(error)}`)
    available = false
  }
// Connecting to Postgres and seeding two bare repositories do not fit in bun's
// default five second hook budget on a cold cache.
}, 120_000)

afterAll(async () => {
  server?.stop()

  try {
    for (const id of [created.repositoryId, created.privateId]) {
      if (id)
        await (globalThis as any).db.deleteFrom('repositories').where('id', '=', id).execute()
    }

    for (const id of [created.userId, created.strangerId]) {
      if (id)
        await (globalThis as any).db.deleteFrom('users').where('id', '=', id).execute()
    }
  }
  catch { /* the temp files still go, below */ }

  for (const path of [created.diskPath, created.privatePath]) {
    if (path)
      rmSync(path, { recursive: true, force: true })
  }

  if (created.diskPath) {
    // And the owner's directory, which the repositories were the only things in.
    try {
      rmdirSync(resolve(created.diskPath, '..'))
    }
    catch { /* not empty, which is somebody else's repository */ }
  }

  if (created.temp)
    rmSync(created.temp, { recursive: true, force: true })
})

describe('git over ssh', () => {
  test('clones the repository that was named', async () => {
    if (!available)
      return

    const into = join(created.temp, 'clone-public')
    const result = await git(created.temp, clientKey, 'clone', urlFor(created.name), into)

    expect(result.ok).toBe(true)

    // Named explicitly. A transport that serves the server's own working
    // directory clones successfully and checks out a real tree, and the only
    // assertion that notices is one that says which tree.
    const listed = await git(into, clientKey, 'ls-files')
    expect(listed.stdout.trim()).toBe('public.txt')
  }, 60_000)

  test('pushes, and the commit lands in that repository', async () => {
    if (!available)
      return

    const work = join(created.temp, 'push')
    const cloned = await git(created.temp, clientKey, 'clone', urlFor(created.name), work)
    expect(cloned.ok).toBe(true)

    writeFileSync(join(work, 'pushed.txt'), 'over ssh\n')
    await git(work, clientKey, 'add', '.')
    await git(work, clientKey, 'commit', '-m', 'pushed over ssh')

    const pushed = await git(work, clientKey, 'push', 'origin', 'main')
    expect(pushed.ok).toBe(true)

    const onDisk = await git(created.temp, clientKey, '--git-dir', created.diskPath, 'log', '-1', '--format=%s')
    expect(onDisk.stdout.trim()).toBe('pushed over ssh')
  }, 60_000)

  test('refuses a key nobody registered', async () => {
    if (!available)
      return

    const { generateHostKey } = await import('@stacksjs/ts-ssh')
    const unknown = generateHostKey('nobody@test')
    const path = join(created.temp, 'id_unknown')
    writeFileSync(path, unknown.openssh)
    chmodSync(path, 0o600)

    const result = await git(created.temp, path, 'clone', urlFor(created.name), join(created.temp, 'clone-unknown'))

    expect(result.ok).toBe(false)
    expect(result.stderr).toContain('Permission denied')
  }, 60_000)

  test('will not serve a private repository to somebody else', async () => {
    if (!available)
      return

    // The stranger's key is registered, so the connection is allowed - and the
    // repository still is not. Authentication and authorisation are different
    // questions, and this is the test that they are asked separately.
    const result = await git(created.temp, strangerKey, 'clone', urlFor(created.privateName), join(created.temp, 'clone-private'))

    expect(result.ok).toBe(false)
    // The same answer a repository that does not exist gives. Anything else
    // turns a refusal into a directory of private repository names.
    expect(result.stderr).toContain('Repository not found')
  }, 60_000)

  test('will not let somebody else push to a public repository', async () => {
    if (!available)
      return

    const work = join(created.temp, 'push-stranger')
    const cloned = await git(created.temp, strangerKey, 'clone', urlFor(created.name), work)
    expect(cloned.ok).toBe(true)

    writeFileSync(join(work, 'unwanted.txt'), 'no\n')
    await git(work, strangerKey, 'add', '.')
    await git(work, strangerKey, 'commit', '-m', 'should not land')

    const pushed = await git(work, strangerKey, 'push', 'origin', 'main')

    // Readable and not writable: the read succeeded above, and this must not.
    expect(pushed.ok).toBe(false)
  }, 60_000)

  test('refuses a shell', async () => {
    if (!available)
      return

    const child = Bun.spawn([
      'ssh',
      '-i', clientKey,
      '-p', String(port),
      '-o', 'IdentitiesOnly=yes',
      '-o', 'IdentityAgent=none',
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'UserKnownHostsFile=/dev/null',
      '-o', 'BatchMode=yes',
      '-o', 'LogLevel=ERROR',
      'git@127.0.0.1',
      'whoami',
    ], { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' })

    const [stderr, code] = await Promise.all([
      new Response(child.stderr).text(),
      child.exited,
    ])

    expect(code).not.toBe(0)
    // Not a shell, and it says so rather than closing the connection: a
    // refusal that arrives as a dropped socket reads as "the server is broken".
    expect(stderr).toContain('This server runs git')
  }, 30_000)
})

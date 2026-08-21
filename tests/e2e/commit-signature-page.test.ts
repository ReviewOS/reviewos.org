// The verified badge, for a commit that is really signed.
//
// `tests/e2e/git-signature.test.ts` proves the verification rules against a
// real gpg with the keys handed to it. This proves the wiring above that: the
// keys come out of `gpg_keys`, the signer is resolved to a person, and the
// three answers a reader can be given are the right ones:
//
//   Verified    the signature is good, the key is registered here, and it
//               claims the address on the commit
//   Unverified  signed, and this server has nothing to check it against
//   nothing     unsigned, which is most commits
//
// The middle case is the one worth having a test for. It is one row in
// `gpg_keys` away from the first, and getting it wrong in the other direction -
// showing "Verified" for a key nobody registered - is the whole feature failing
// silently while looking like it works.
//
// It asserts at both levels. The badge's *content* is decided by two calls the
// page makes, and those are checked directly; the page is then fetched to prove
// the component reaches a reader at all. The second half was not possible when
// this was written - a view served by `route.serve` could not resolve anything
// in `resources/components/` - and `tests/helpers/server.ts` is what changed
// that.
//
// The fixture is the same signed commit the unit tests use, replayed into a
// fresh repository with git plumbing. Behind `REVIEWOS_GPG_TESTS=1` for the
// same reason as its sibling: gpg allocates locked, unswappable memory, and a
// process the kernel kills reports nothing.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { removeRepositoryDirectory, removeRepositoryOwnerDirectory } from '../helpers/repositoryDirectory'

const FIXTURES = 'tests/fixtures/gpg'
const meta = JSON.parse(readFileSync(join(FIXTURES, 'meta.json'), 'utf8'))
const publicKey = readFileSync(join(FIXTURES, 'ada.public.asc'), 'utf8')

const created = { userId: 0, repositoryId: 0, keyId: 0, handle: '', name: '', diskPath: '' }

let available = false
let port = 0

function unique(prefix: string): string {
  return `${prefix}${Buffer.from(crypto.getRandomValues(new Uint8Array(5))).toString('hex')}`
}

async function git(args: string[]): Promise<string> {
  const child = Bun.spawn(['git', ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1' },
  })
  const [out] = await Promise.all([new Response(child.stdout).text(), child.exited])

  return out.trim()
}

/** Write bytes into the repository as an object of the given type. */
async function writeObject(kind: 'blob' | 'tree' | 'commit', bytes: Buffer, scratch: string): Promise<string> {
  const path = join(scratch, `object.${kind}`)
  await Bun.write(path, bytes)

  return await git(['--git-dir', created.diskPath, 'hash-object', '-w', '-t', kind, path])
}

/** The commit page, as a reader gets it. */
async function page(): Promise<string> {
  const response = await fetch(`http://127.0.0.1:${port}/${created.handle}/${created.name}/commit/${meta.commit}`, {
    headers: { Accept: 'text/html' },
  })

  return await response.text()
}

/** The badge the commit page would draw, through the same two calls it makes. */
async function badge(): Promise<{ label: string, tone: string, detail: string, show: boolean }> {
  const { verifySignature } = await import('../../app/Actions/Git/signatures')
  const { signatureBadge } = await import('../../app/Actions/Browse/rows')

  const signed = await verifySignature(created.diskPath, meta.commit)

  return signatureBadge(signed.verification.status, signed.signer?.name ?? null)
}

beforeAll(async () => {
  try {
    // Opting in is a judgement about the host: a process the OOM killer takes
    // reports nothing, and it cannot be probed for from inside the process it
    // would kill.
    if (process.env.REVIEWOS_GPG_TESTS !== '1') {
      console.warn('[signature] page cases skipped: set REVIEWOS_GPG_TESTS=1 to run them')

      return
    }

    const { injectGlobalAutoImports } = await import('@stacksjs/server')
    const { serveForTest } = await import('../helpers/server')

    await injectGlobalAutoImports()
    await (globalThis as any).db.selectFrom('users').select(['id']).limit(1).execute()

    // Through the helper rather than `route.serve` directly, so the view can
    // find `SignatureBadge` in `resources/components/`.
    port = (await serveForTest()).port

    const { repositoryPath } = await import('../../app/Actions/Git/storage')

    created.handle = unique('sig')
    created.name = unique('repo')

    // The user the key belongs to, with the address the fixture commit claims.
    // Both halves matter: a key registered to somebody who is not the author is
    // exactly what the verification refuses.
    const user: any = await (globalThis as any).db
      .insertInto('users')
      .values({ name: 'Ada Lovelace', email: meta.email, handle: created.handle, password: 'x' })
      .returning(['id'])
      .executeTakeFirst()

    created.userId = Number(user?.id)

    const key: any = await (globalThis as any).db
      .insertInto('gpg_keys')
      .values({
        user_id: created.userId,
        key_id: meta.keyId,
        public_key: publicKey,
        emails: JSON.stringify([meta.email]),
        expires_at: null,
      })
      .returning(['id'])
      .executeTakeFirst()

    created.keyId = Number(key?.id)

    const resolved = repositoryPath(created.handle, created.name)
    created.diskPath = resolved.path!

    const repository: any = await (globalThis as any).db
      .insertInto('repositories')
      .values({
        owner_type: 'user',
        owner_id: created.userId,
        name: created.name,
        description: 'created by the signature page test',
        visibility: 'public',
        default_branch: 'main',
        disk_path: resolved.relative!,
      })
      .returning(['id'])
      .executeTakeFirst()

    created.repositoryId = Number(repository?.id)

    mkdirSync(resolve(created.diskPath, '..'), { recursive: true })
    await git(['init', '--bare', '--quiet', created.diskPath])

    // The fixture commit, replayed as objects. Replayed rather than made,
    // because *making* a signature needs a private key and this one went with
    // the temporary directory it was generated in.
    const scratch = resolve(created.diskPath, '..')
    await writeObject('blob', readFileSync(join(FIXTURES, 'a.txt.blob')), scratch)
    await writeObject('tree', Buffer.concat([Buffer.from('100644 a.txt\0'), Buffer.from(meta.blob, 'hex')]), scratch)
    await writeObject('commit', readFileSync(join(FIXTURES, 'signed-commit.object')), scratch)
    await git(['--git-dir', created.diskPath, 'update-ref', 'refs/heads/main', meta.commit])

    available = true
  }
  catch (error) {
    console.warn(`[e2e] skipping: ${error instanceof Error ? error.message : String(error)}`)
    available = false
  }
// Connecting to Postgres and replaying the fixture do not fit in bun's default
// five second hook budget on a cold cache.
}, 120_000)

afterAll(async () => {
  try {
    if (created.repositoryId)
      await (globalThis as any).db.deleteFrom('repositories').where('id', '=', created.repositoryId).execute()

    if (created.keyId)
      await (globalThis as any).db.deleteFrom('gpg_keys').where('id', '=', created.keyId).execute()

    if (created.userId)
      await (globalThis as any).db.deleteFrom('users').where('id', '=', created.userId).execute()
  }
  catch { /* the directory still goes, below */ }

  if (created.diskPath) {
    removeRepositoryDirectory(created.diskPath)

    try {
      removeRepositoryOwnerDirectory(created.diskPath)
    }
    catch { /* not empty, which is somebody else's repository */ }
  }
})

describe('a signed commit', () => {
  test('is verified when the key is registered to its author', async () => {
    if (!available)
      return

    const drawn = await badge()

    expect(drawn.show).toBe(true)
    expect(drawn.label).toBe('Verified')
    expect(drawn.tone).toBe('good')
    // And it says who, which is the part that makes it worth anything: "signed"
    // is a fact about bytes, "signed by Ada" is a fact about a person.
    expect(drawn.detail).toContain('Ada Lovelace')

    // And it is on the page, not just computable. The commit view uses
    // `<SignatureBadge>` directly, which is the shape that renders.
    const html = await page()
    expect(html).toContain('>Verified<')
    // The class on the element, not the name in the stylesheet: the component
    // ships `.sig-good { … }` in a `<style>` block whatever tone it drew, so
    // matching the bare word passes for every status.
    expect(html).toContain('class="sig sig-good"')
    expect(html).not.toContain('Error loading component')
  }, 60_000)

  test('is unverified once the key is no longer registered', async () => {
    if (!available)
      return

    // The same commit, the same signature, one row deleted. A server that still
    // said "Verified" here would be reporting on the signature's shape rather
    // than on who made it - which is the whole feature failing silently while
    // looking like it works.
    await (globalThis as any).db.deleteFrom('gpg_keys').where('id', '=', created.keyId).execute()

    try {
      const drawn = await badge()

      expect(drawn.label).toBe('Unverified')
      expect(drawn.tone).toBe('quiet')

      const html = await page()
      expect(html).toContain('>Unverified<')
      expect(html).toContain('class="sig sig-quiet"')
      expect(html).not.toContain('class="sig sig-good"')
    }
    finally {
      // Put it back, so the test above can run in either order.
      const restored: any = await (globalThis as any).db
        .insertInto('gpg_keys')
        .values({
          user_id: created.userId,
          key_id: meta.keyId,
          public_key: publicKey,
          emails: JSON.stringify([meta.email]),
          expires_at: null,
        })
        .returning(['id'])
        .executeTakeFirst()

      created.keyId = Number(restored?.id)
    }
  }, 60_000)
})

/*
 * A revision nobody has, on a repository somebody does.
 *
 * The page already answered 404 for a missing repository and had the argument
 * for it written above the guard - "a page that renders 'no such repository'
 * under a 200 tells a crawler, a cache and an uptime check that the page is
 * fine". A forty-character hex string is a larger space than a repository
 * name, and it was the half that had not been applied.
 */
describe('a commit nobody has', () => {
  test('is a 404 rather than an empty page under a 200', async () => {
    if (!available)
      return

    const answer = await fetch(
      `http://127.0.0.1:${port}/${created.handle}/${created.name}/commit/${'0'.repeat(40)}`,
      { headers: { Accept: 'text/html' } },
    )

    expect(answer.status).toBe(404)
  }, 30_000)
})

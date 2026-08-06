/**
 * Verifying a signature against a registered key.
 *
 * The fixture is a genuinely signed commit - made once by a throwaway ed25519
 * key whose public half is committed beside it - replayed into a fresh
 * repository with git plumbing. Replayed rather than re-created because
 * *making* a signature needs gpg, and gpg could not be run from this process on
 * the machine these were written on: gpg allocates locked, unswappable secure
 * memory, and on a host whose swap is exhausted the kernel kills the process
 * group rather than the allocation. A shell survives it because a shell is
 * small - the same commands verify `GOODSIG` there.
 *
 * The private key went with the temporary directory it was made in. What is
 * committed is a public key and a signature over the word "hello", which is
 * precisely as secret as it sounds.
 *
 * **The cases that reach gpg are opt-in** (`REVIEWOS_GPG_TESTS=1`). Not a
 * preference: a process killed by the kernel is not a failing test, it takes
 * the whole run down and reports nothing, and there is no way to probe for
 * "will this kill me" from inside the process it would kill. Everything that
 * can be decided without gpg runs always, and that is most of the rules worth
 * pinning - what counts as a candidate key, what an unsigned commit reads as,
 * and what an unreadable key does.
 */

import type { CommitVerification } from '../../app/Actions/Git/verify'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { verifyCommit } from '../../app/Actions/Git/verify'

const FIXTURES = 'tests/fixtures/gpg'
const meta = JSON.parse(readFileSync(join(FIXTURES, 'meta.json'), 'utf8'))
const publicKey = readFileSync(join(FIXTURES, 'ada.public.asc'), 'utf8')

const ada = {
  key_id: meta.keyId,
  public_key: publicKey,
  emails: JSON.stringify([meta.email]),
  expires_at: null,
  user_id: 7,
}

let repository = ''
let workspace = ''
let available = false

/**
 * Run git, waiting, without blocking the loop.
 *
 * Nothing is piped to stdin: objects are written to a file and hashed by path.
 * `Bun.spawn` with a stdin pipe fails `posix_spawn` with `EBADF` on this
 * runtime, and a test that cannot start the tool it is testing proves nothing.
 */
async function git(args: string[]): Promise<{ ok: boolean, out: string }> {
  const child = Bun.spawn(['git', ...args], {
    cwd: workspace,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1' },
  })
  const [out, code] = await Promise.all([new Response(child.stdout).text(), child.exited])

  return { ok: code === 0, out: out.trim() }
}

/** Write bytes into the repository as an object of the given type. */
async function writeObject(kind: 'blob' | 'tree' | 'commit', bytes: Buffer): Promise<string> {
  const path = join(workspace, `object.${kind}`)
  writeFileSync(path, bytes)

  const written = await git(['--git-dir', repository, 'hash-object', '-w', '-t', kind, path])

  return written.out
}

beforeAll(async () => {
  workspace = mkdtempSync(join(tmpdir(), 'reviewos-sig-'))
  repository = join(workspace, 'signed.git')

  await git(['init', '--bare', '--quiet', repository])

  // Write the objects the fixture commit needs, then the commit itself, then
  // point a ref at it. All plumbing, so nothing here needs gpg.
  expect(await writeObject('blob', readFileSync(join(FIXTURES, 'a.txt.blob')))).toBe(meta.blob)

  const tree = Buffer.concat([Buffer.from('100644 a.txt\0'), Buffer.from(meta.blob, 'hex')])
  expect(await writeObject('tree', tree)).toBe(meta.tree)

  expect(await writeObject('commit', readFileSync(join(FIXTURES, 'signed-commit.object')))).toBe(meta.commit)

  await git(['--git-dir', repository, 'update-ref', 'refs/heads/main', meta.commit])

  // Opt-in only. Probing would itself be the thing that kills the run.
  available = process.env.REVIEWOS_GPG_TESTS === '1'

  if (!available)
    console.warn('[signature] gpg cases skipped: set REVIEWOS_GPG_TESTS=1 to run them')
}, 120_000)

afterAll(() => {
  if (workspace)
    rmSync(workspace, { recursive: true, force: true })
})

const verify = (keys: any[]): Promise<CommitVerification> => verifyCommit(repository, meta.commit, keys)

describe('commit signature verification', () => {
  test('the fixture really is a signed commit', () => {
    const object = readFileSync(join(FIXTURES, 'signed-commit.object'), 'utf8')

    expect(object).toContain('gpgsig -----BEGIN PGP SIGNATURE-----')
    expect(object).toContain(`<${meta.email}>`)
  })

  test('a good signature by a registered key is verified', async () => {
    if (!available)
      return

    const result = await verify([ada])

    expect(result.status).toBe('verified')
    expect(result.userId).toBe(7)
    expect(result.authorEmail).toBe(meta.email)
  }, 60_000)

  /**
   * The signature is perfectly good. It just does not say anything this forge
   * can act on, because nobody registered the key that made it.
   */
  test('a good signature by an unregistered key is not verified', async () => {
    // Reaches no gpg: with no candidate key there is nothing to check against,
    // and that is decided before any binary runs.
    const result = await verify([])

    expect(result.status).toBe('unknown_key')
    expect(result.userId).toBeNull()
  }, 60_000)

  /**
   * The rule that matters most. Anybody can sign a commit claiming to be
   * somebody else - a signature proves the signer, and the signer has to be who
   * the commit says wrote it.
   */
  test('a key that does not claim the author address is not accepted', async () => {
    // Also reaches no gpg. The key is excluded as a candidate first, which is
    // the point: this rule holds whether or not a signature could be checked.
    const result = await verify([{ ...ada, emails: JSON.stringify(['someone@else.example']) }])

    expect(result.status).toBe('unknown_key')
    expect(result.userId).toBeNull()
  }, 60_000)

  test('an expired key is not accepted', async () => {
    const result = await verify([{ ...ada, expires_at: '2020-01-01T00:00:00Z' }])

    expect(result.status).toBe('unknown_key')
  }, 60_000)

  /**
   * "Could not check" and "did not check out" are different answers and a
   * reader has to be able to tell them apart: one is this server's problem and
   * the other is a claim about the commit.
   */
  test('a key that cannot be read reads as unavailable, not as a bad signature', async () => {
    // Still no gpg: the key is a candidate by address, then fails to dearmor,
    // so there is nothing to put in a keyring and nothing to run.
    const result = await verify([{ ...ada, public_key: 'not a key at all' }])

    expect(result.status).toBe('unavailable')
  }, 60_000)

  test('an unsigned commit says so plainly', async () => {
    // A second commit on the same tree, unsigned, written the same way.
    const unsigned = Buffer.from(
      `tree ${meta.tree}\n`
      + `author Ada Lovelace <${meta.email}> 1700000000 +0000\n`
      + `committer Ada Lovelace <${meta.email}> 1700000000 +0000\n`
      + `\nAn unsigned commit\n`,
    )
    const written = await writeObject('commit', unsigned)

    const result = await verifyCommit(repository, written, [ada])

    expect(result.status).toBe('unsigned')
  }, 60_000)

  test('a commit nobody has reads as unavailable rather than throwing', async () => {
    const result = await verifyCommit(repository, '0'.repeat(40), [ada])

    expect(result.status).toBe('unavailable')
  }, 60_000)
})

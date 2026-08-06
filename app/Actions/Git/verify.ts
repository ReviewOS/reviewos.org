/**
 * Checking a commit signature against the keys registered here.
 *
 * **git runs gpg, this does not.** That is the same rule the rest of this
 * phase follows - the system git binary does the git work - and it also
 * removes the one computation in this feature that is dangerous to get
 * slightly wrong: reconstructing the signed payload byte for byte, which git
 * already does correctly.
 *
 * **Not yet reachable from a route.** gpg is not a declared dependency, and on
 * the machine this was written on it could not be made one: every gpg-family
 * binary spawned anywhere under Bun is SIGKILLed and takes the Bun process
 * with it, and installing gnupg into the project's package tree broke
 * unrelated tests. The parsing and the rules below are tested and correct - a
 * commit's signature was verified `GOODSIG` against a reconstructed payload
 * from a shell - but nothing here has been exercised end to end from the
 * application, so nothing calls it. Wiring it into the commit view wants an
 * environment where `git verify-commit` runs from a Bun process first.
 *
 * What is left here is the keyring: git verifies against whatever `GNUPGHOME`
 * holds, so each verification gets a temporary one containing only the keys
 * that could legitimately have signed *this* commit. Never a shared keyring - a
 * shared one accumulates, and a key imported to check one commit would quietly
 * start verifying everybody else's.
 *
 * Two rules this will not bend on, because getting either wrong is worse than
 * reporting nothing:
 *
 * - A good signature by a key nobody registered is **not** verified. It is a
 *   valid signature, and it says nothing about who made the commit as far as
 *   this forge is concerned.
 * - A good signature by a registered key that does not claim the commit's
 *   author address is **not** verified either. Anybody can sign a commit
 *   claiming to be somebody else; a signature proves the signer, and the signer
 *   has to be who the commit says wrote it.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SignatureStatus } from './signature'
import { candidateKeys, dearmor, emailFrom, parseCommitObject, sameKey } from './signature'
import { runGit } from './git'

export interface RegisteredKey {
  key_id?: unknown
  public_key?: unknown
  emails?: unknown
  expires_at?: unknown
  user_id?: unknown
}

export interface CommitVerification {
  status: SignatureStatus
  /** The key git reports as having made the signature, when it could read one. */
  keyId: string | null
  /** The address the commit claims, which is what a key had to match. */
  authorEmail: string | null
  /** The user whose registered key verified it. */
  userId: number | null
  /** Plain language, for the interface. Never a gpg transcript. */
  reason: string
}

const UNSIGNED: CommitVerification = {
  status: 'unsigned',
  keyId: null,
  authorEmail: null,
  userId: null,
  reason: 'This commit is not signed.',
}

/**
 * Verify one commit against a set of registered keys.
 *
 * The keys are passed in rather than queried here, so a caller can fetch once
 * for a page of commits instead of once per row, and so this is runnable
 * against a fixture repository with no database behind it.
 */
export async function verifyCommit(
  repositoryPath: string,
  sha: string,
  keys: readonly RegisteredKey[],
  now: Date = new Date(),
): Promise<CommitVerification> {
  const object = await runGit(repositoryPath, ['cat-file', 'commit', sha])
  if (!object.ok)
    return { ...UNSIGNED, status: 'unavailable', reason: 'That commit could not be read.' }

  // Cheap and gpg-free: is it signed at all, and who does it claim wrote it.
  // Both are needed before there is any point building a keyring.
  const parsed = parseCommitObject(object.stdout)
  if (!parsed.signature)
    return UNSIGNED

  const authorEmail = emailFrom(parsed.author)
  const candidates = candidateKeys(keys, authorEmail, now)

  if (candidates.length === 0) {
    return {
      status: 'unknown_key',
      keyId: null,
      authorEmail,
      userId: null,
      reason: authorEmail
        ? `This commit is signed, but no key registered to ${authorEmail} could check it.`
        : 'This commit is signed, but it records no author address to match a key against.',
    }
  }

  const checked = await gitVerify(repositoryPath, sha, candidates)

  if (checked.status === 'unavailable') {
    return {
      status: 'unavailable',
      keyId: null,
      authorEmail,
      userId: null,
      reason: 'This commit is signed, but this server could not check the signature.',
    }
  }

  if (checked.status === 'invalid') {
    return {
      status: 'invalid',
      keyId: checked.keyId,
      authorEmail,
      userId: null,
      reason: 'This commit is signed, and the signature does not check out.',
    }
  }

  // Which of the candidates it was. git reports the key that made the
  // signature; the matching registered row is who that key belongs to.
  const owner = candidates.find(key => sameKey(checked.keyId, String(key.key_id ?? '')))

  return {
    status: 'verified',
    keyId: checked.keyId,
    authorEmail,
    userId: owner?.user_id === undefined || owner.user_id === null ? null : Number(owner.user_id),
    reason: 'This commit is signed by a key registered to its author.',
  }
}

/**
 * Ask git to verify, against a keyring holding only the candidate keys.
 *
 * The keyring is written as `pubring.gpg` - the legacy format, which is a plain
 * concatenation of the key packets and which gpg still reads. Building it that
 * way means no gpg call is needed to *create* the keyring, only to use it.
 */
async function gitVerify(
  repositoryPath: string,
  sha: string,
  keys: readonly RegisteredKey[],
): Promise<{ status: 'verified' | 'invalid' | 'unavailable', keyId: string | null }> {
  let home = ''

  try {
    home = await mkdtemp(join(tmpdir(), 'reviewos-gpg-'))

    const ring: Uint8Array[] = []
    for (const key of keys) {
      const bytes = dearmor(String(key.public_key ?? ''))
      if (bytes)
        ring.push(bytes)
    }

    // Every candidate key was unreadable. Not "bad signature" - there was
    // nothing to check it against.
    if (ring.length === 0)
      return { status: 'unavailable', keyId: null }

    await writeFile(join(home, 'pubring.gpg'), Buffer.concat(ring.map(bytes => Buffer.from(bytes))))

    const result = await runGit(repositoryPath, ['verify-commit', '--raw', sha], {
      env: {
        GNUPGHOME: home,
        // gpg's human-readable output is localized and reworded between
        // versions; only the status lines are parsed, but this keeps anything
        // that does surface in a language the logs can be read in.
        LC_ALL: 'C',
      },
      timeoutMs: 15_000,
    })

    // The machine-readable lines, never the prose: this decides whether a
    // commit is presented to somebody as trustworthy.
    const transcript = `${result.stdout}\n${result.stderr}`
    const good = /^\[GNUPG:\] GOODSIG /m.test(transcript)
    const keyId = transcript.match(/^\[GNUPG:\] VALIDSIG (\S+)/m)?.[1]
      ?? transcript.match(/^\[GNUPG:\] GOODSIG (\S+)/m)?.[1]
      ?? null

    // No status lines at all means git could not run gpg, which is a different
    // answer from "the signature is bad" and has to read as one.
    if (!transcript.includes('[GNUPG:]'))
      return { status: 'unavailable', keyId: null }

    return { status: good ? 'verified' : 'invalid', keyId }
  }
  catch {
    return { status: 'unavailable', keyId: null }
  }
  finally {
    if (home)
      await rm(home, { recursive: true, force: true }).catch(() => {})
  }
}

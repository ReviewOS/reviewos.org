/**
 * The database half of signature verification.
 *
 * `verify.ts` is deliberately free of it: it takes the keys it is to check
 * against as an argument, so the rules can be tested against a fixture
 * repository with nothing behind them. This is where the keys come from, and
 * where the answer is turned into something a page can draw.
 *
 * **Verified on read, and only where that is affordable.** One commit costs one
 * gpg process, which is fine for a commit page and is not fine for a list of
 * thirty. The list would want the answer stored rather than recomputed, and
 * storing it wants a `commits` table this does not have yet - so the badge is
 * on the commit page, and the history stays as it was. A slow list is a worse
 * failure than a missing badge: nobody waits four seconds to read a subject
 * line, and nobody knows why it is slow.
 */

import type { CommitVerification, RegisteredKey } from './verify'
import { db } from '@stacksjs/database'
import { verifyCommit } from './verify'

/**
 * Every registered key.
 *
 * All of them, rather than the ones matching the commit's author: the address
 * is inside the commit object, so filtering in SQL would mean reading and
 * parsing the commit here as well as inside `verifyCommit`, and `candidateKeys`
 * already narrows by address and expiry before any keyring is built. The table
 * holds one row per key a person has registered, so on any instance this is a
 * small read - and if that ever stops being true, the fix is to store the
 * verification at receive time rather than to make this query cleverer.
 */
export async function registeredKeys(): Promise<RegisteredKey[]> {
  const rows = await db
    .selectFrom('gpg_keys')
    .select(['key_id', 'public_key', 'emails', 'expires_at', 'user_id'])
    .execute()

  return rows as RegisteredKey[]
}

/** The people behind the keys, so a badge can name who signed. */
export interface Signer {
  userId: number
  handle: string | null
  name: string | null
}

/**
 * Verify one commit, and say who signed it if anybody did.
 *
 * Never throws. A page that renders a commit is not a page that should fail
 * because gpg is missing, a key is malformed, or a keyring could not be
 * written: those are all `unavailable`, which the interface says out loud
 * rather than dressing up as either verified or forged.
 */
export async function verifySignature(
  repositoryPath: string,
  sha: string,
): Promise<{ verification: CommitVerification, signer: Signer | null }> {
  try {
    const keys = await registeredKeys()
    const verification = await verifyCommit(repositoryPath, sha, keys)

    if (verification.userId === null)
      return { verification, signer: null }

    const user: any = await db
      .selectFrom('users')
      .select(['id', 'handle', 'name'])
      .where('id', '=', verification.userId)
      .executeTakeFirst()

    return {
      verification,
      signer: user
        ? { userId: Number(user.id), handle: user.handle ?? null, name: user.name ?? null }
        : null,
    }
  }
  catch (error) {
    return {
      verification: {
        status: 'unavailable',
        keyId: null,
        authorEmail: null,
        userId: null,
        // The reason is for a log. What reaches a reader is the status.
        reason: `The signature could not be checked: ${error}`,
      },
      signer: null,
    }
  }
}

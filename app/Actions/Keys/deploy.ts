/**
 * Deciding whether a pasted key may become a deploy key.
 *
 * The format is `parseSshPublicKey`'s job, and the same policy applies: which
 * types this forge takes, how small an RSA key may be, and what to say to
 * somebody who pasted a private key. What is here is the part that is specific
 * to a key belonging to a repository rather than to a person.
 *
 * **One fingerprint, one identity.** The SSH transport picks who is connecting
 * from the fingerprint alone - there is nothing else on the wire to go on - so
 * a fingerprint that matched both an account key and a deploy key would make
 * "who pushed this" unanswerable, and the answer would depend on which table
 * was read first. So a key registered to an account cannot become a deploy key,
 * and a deploy key cannot be added to a second repository. The database enforces
 * the half it can see; this enforces the half that spans two tables.
 *
 * That is a real restriction and worth stating plainly: somebody who wants the
 * same machine to reach two repositories generates a second key. That is one
 * command, and it means revoking access to one repository cannot silently
 * revoke it to another.
 */

import { db } from '@stacksjs/database'
import { fingerprintOf, parseSshPublicKey } from './ssh'

export type DeployKeyParse
  = | { ok: true, type: string, body: string, comment: string, fingerprint: string }
    | { ok: false, message: string, status: number }

/**
 * Read a pasted key and check nothing else already claims it.
 *
 * Returns the status the endpoint should answer with, because the two failures
 * are genuinely different: an unreadable key is the caller's mistake (422) and
 * a key somebody else already registered is a conflict (409).
 */
export async function readDeployKey(raw: string): Promise<DeployKeyParse> {
  const parsed = parseSshPublicKey(raw)
  if (!parsed.ok)
    return { ok: false, message: parsed.message, status: 422 }

  const fingerprint = await fingerprintOf(parsed.body)

  // An account key first. This is the direction that matters most: letting
  // somebody's personal key become a repository's would mean their pushes could
  // be attributed to a machine, and the machine's to them.
  const account = await db
    .selectFrom('ssh_keys')
    .select(['id'])
    .where('fingerprint', '=', fingerprint)
    .executeTakeFirst()

  if (account) {
    return {
      ok: false,
      status: 409,
      message: 'That key is already registered to an account. A deploy key is for a machine, so generate it one of its own: ssh-keygen -t ed25519 -f deploy_key',
    }
  }

  const elsewhere = await db
    .selectFrom('deploy_keys')
    .select(['id', 'repository_id'])
    .where('fingerprint', '=', fingerprint)
    .executeTakeFirst()

  if (elsewhere) {
    return {
      ok: false,
      status: 409,
      message: 'That key is already a deploy key on a repository. A deploy key reaches one repository, so this needs a key of its own.',
    }
  }

  return { ok: true, type: parsed.type, body: parsed.body, comment: parsed.comment, fingerprint }
}

/** A deploy key's row, as the transport needs it. */
export interface DeployKeyIdentity {
  id: number
  repositoryId: number
  canWrite: boolean
}

/**
 * The deploy key with this fingerprint, if there is one.
 *
 * Separate from `userForKey` and asked after it: an account key is the more
 * specific answer, and the two cannot both match anyway - `readDeployKey`
 * refuses a fingerprint either table already holds.
 */
export async function deployKeyFor(fingerprint: string): Promise<DeployKeyIdentity | null> {
  const row = await db
    .selectFrom('deploy_keys')
    .select(['id', 'repository_id', 'can_write'])
    .where('fingerprint', '=', fingerprint)
    .executeTakeFirst()

  if (!row)
    return null

  return {
    id: Number(row.id),
    repositoryId: Number(row.repository_id),
    canWrite: Boolean(row.can_write),
  }
}

/**
 * Whether this deploy key may run this service on this repository.
 *
 * Two questions and both are answered here rather than by the caller, because
 * getting either wrong is silent: a key scoped to repository A that is allowed
 * to read repository B is the whole feature failing, and a read-only key that
 * can push is the default meaning nothing.
 */
export function deployKeyMay(
  key: DeployKeyIdentity,
  repositoryId: number,
  service: 'upload-pack' | 'receive-pack',
): boolean {
  if (key.repositoryId !== repositoryId)
    return false

  return service === 'upload-pack' || key.canWrite
}

/**
 * Note that a key was used.
 *
 * Not awaited by the caller and never allowed to fail a clone: a key being
 * visibly unused is worth a write, and not worth refusing somebody's fetch
 * over. It is the only way to tell a key that is doing a job from one added for
 * a machine that no longer exists.
 */
export async function markDeployKeyUsed(id: number): Promise<void> {
  try {
    await db
      .updateTable('deploy_keys')
      .set({ last_used_at: new Date().toISOString() })
      .where('id', '=', id)
      .execute()
  }
  catch {
    // Nothing downstream depends on it.
  }
}

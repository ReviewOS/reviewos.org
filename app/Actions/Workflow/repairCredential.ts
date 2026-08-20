/**
 * The credential a repair gets, which is the smallest one that can do the job.
 *
 * `jobToken.ts` mints what a *workflow* asked for, resolved against what the
 * run is trusted to have. This mints something narrower and it takes no input
 * about what to grant, deliberately: a repair needs to write one branch in one
 * repository, and every extra level is one an agent could be talked into using.
 *
 * Three properties, and the third is the one the roadmap names:
 *
 * **One repository.** `selection: 'selected'`, the same as a job's token. An
 * agent that can push to the repository it is repairing must not be able to
 * push to every repository its actor can reach.
 *
 * **`contents: write` and nothing else.** No `actions`, so it cannot read the
 * workflow secrets the run had; no `administration`, so it cannot change the
 * branch protection that would stop it; no `pull_requests`, so it cannot
 * approve anything - including its own proposal. That last one is a defence in
 * depth rather than the mechanism: `mayApproveRepair` refuses self-approval
 * with no switch to turn it off, and this token could not carry it out anyway.
 *
 * **It dies with the attempt.** Minted for the policy's own `maxMinutes` and
 * revoked when the attempt closes, so a repair that hangs leaves a credential
 * that stops working inside the window its budget already described.
 *
 * ## Why a token at all, when the commit is written by plumbing
 *
 * `createCommit` writes into the bare repository directly and needs no
 * credential. The token is for the part after: reporting the proposal, opening
 * the pull request, and anything a future agent does over the API. Minting it
 * scoped rather than letting the agent act as the instance is the difference
 * between a bug that writes a bad branch and one that writes anywhere.
 */

import { db } from '@stacksjs/database'
import { generateToken } from '../Tokens/secret'

/** The one grant a repair gets. */
export const REPAIR_GRANTS = { contents: 'write' } as const

export interface RepairCredential {
  token: string
  id: number
  /** The branch this credential is for, which is the only one a repair may write. */
  branch: string
  expiresAt: string
}

/** The name a repair's token is stored under, and the handle its revocation uses. */
export function repairTokenName(attemptId: number): string {
  return `Repair attempt ${attemptId}`
}

/**
 * Mint one, for one attempt.
 *
 * Returns null with no actor, exactly as a job's token does. A credential has
 * to belong to somebody for the audit log to mean anything, and "the instance"
 * is the answer that makes every repair unattributable.
 */
export async function mintRepairCredential(input: {
  attemptId: number
  repositoryId: number
  actorId: number | null
  branch: string
  minutes: number
  now?: Date
}): Promise<RepairCredential | null> {
  if (!input.actorId)
    return null

  const now = input.now ?? new Date()
  // Never longer than the repair's own time budget: a credential outliving the
  // work it was for is one nothing is watching.
  const minutes = Math.max(1, Math.min(Math.floor(input.minutes) || 1, 60))
  const expiresAt = new Date(now.getTime() + minutes * 60_000).toISOString()
  const secret = generateToken()

  const row = await db
    .insertInto('access_tokens')
    .values({
      user_id: input.actorId,
      name: repairTokenName(input.attemptId),
      prefix: secret.prefix,
      token_hash: secret.hash,
      selection: 'selected',
      expires_at: expiresAt,
    })
    .returning(['id'])
    .executeTakeFirst()
    .catch(() => null)

  if (!row?.id)
    return null

  await db
    .insertInto('access_token_repositories')
    .values({ access_token_id: Number(row.id), repository_id: input.repositoryId })
    .execute()
    .catch(() => null)

  for (const [scope, level] of Object.entries(REPAIR_GRANTS)) {
    await db
      .insertInto('access_token_permissions')
      .values({ access_token_id: Number(row.id), scope, level })
      .execute()
      .catch(() => null)
  }

  return { token: secret.token, id: Number(row.id), branch: input.branch, expiresAt }
}

/**
 * Revoke it, when the attempt is over.
 *
 * By name rather than by id, for the reason `revokeJobTokens` is: the caller
 * that would hold the id is the one that may have died, and a revocation that
 * only runs on the happy path leaves a live credential every time it does not.
 */
export async function revokeRepairCredential(attemptId: number, now: Date = new Date()): Promise<void> {
  await db
    .updateTable('access_tokens')
    .set({ revoked_at: now.toISOString() })
    .where('name', '=', repairTokenName(attemptId))
    .whereNull('revoked_at')
    .execute()
    .catch(() => null)
}

import { Action } from '@stacksjs/actions'
import { schema } from '@stacksjs/validation'
import { resolveExpiry, tokenState } from '../../TokenScopes'
import { currentUser } from '../Identity/lookup'
import { recordTokenAudit } from './audit'
import { planRotation, ROTATION_OVERLAP_MS } from './rotate'
import { generateToken } from './secret'

/**
 * Issue a replacement for a token, keeping the old one alive for a day.
 *
 * The grants and the reach are copied from the row rather than taken from the
 * request, and that is the point: a rotation that let the caller restate the
 * permissions would be a way to widen a token without anybody reviewing it, and
 * it would silently drop a scope the caller forgot to repeat. Rotation changes
 * the secret and nothing else.
 *
 * The replacement is returned in full, once, exactly as `CreateTokenAction`
 * does. The old token's new expiry comes back too, so whoever is deploying can
 * see how long they have.
 */
export default new Action({
  name: 'RotateAccessToken',
  description: 'Replace an access token, with a short overlap',
  method: 'POST',

  /*
   * Declared here so the reference lists them and the validator enforces them
   * from the same object. Read against the handler rather than the field name:
   * a declared rule is enforced, so a wrong one turns an ordinary request into
   * a 422.
   */
  validations: {
    id: { rule: schema.number().required() },
    expires_at: { rule: schema.string() },
  },

  responses: {
    200: { description: 'The new token, shown once, with the old one revoked.' },
    401: { description: 'Unauthenticated.' },
    403: { description: 'Not yours to rotate.' },
    404: { description: 'No such token.' },
  },

  async handle(request: RequestInstance) {
    const user = await currentUser(request)
    if (!user)
      return response.json({ error: 'Unauthenticated' }, 401)

    const id = Number(request.get('id'))
    if (!Number.isInteger(id) || id <= 0)
      return response.json({ error: 'A token id is required' }, 422)

    const existing = await db
      .selectFrom('access_tokens')
      .select(['id', 'user_id', 'name', 'selection', 'organization_id', 'expires_at', 'revoked_at'])
      .where('id', '=', id)
      .executeTakeFirst()

    // Somebody else's token is reported as missing rather than forbidden, for
    // the same reason a private repository is: the alternative confirms the id.
    if (!existing || Number(existing.user_id) !== user.id)
      return response.json({ error: 'No such token' }, 404)

    const nowMs = Date.now()

    const plan = planRotation({
      state: tokenState({
        expiresAtMs: parseTime(existing.expires_at),
        revokedAtMs: parseTime(existing.revoked_at),
      }, nowMs),
      expiresAtMs: parseTime(existing.expires_at),
      nowMs,
    })

    if (!plan.ok)
      return response.json({ error: plan.error }, plan.status)

    // A fresh full lifetime, or one the caller asked for. The replacement is a
    // new token and gets a new token's expiry rather than inheriting whatever
    // was left of the old one, which would make every rotation shorter than the
    // last until somebody rotated weekly.
    const requestedExpiry = request.get('expires_at')
      ? Date.parse(String(request.get('expires_at')))
      : null

    if (requestedExpiry !== null && Number.isNaN(requestedExpiry))
      return response.json({ error: 'An expiry has to be a date' }, 422)

    const expiry = resolveExpiry(requestedExpiry, nowMs)
    if (!expiry.ok)
      return response.json({ error: expiry.error }, 422)

    const grants = await db
      .selectFrom('access_token_permissions')
      .select(['scope', 'level'])
      .where('access_token_id', '=', id)
      .execute()

    const repositories = await db
      .selectFrom('access_token_repositories')
      .select(['repository_id'])
      .where('access_token_id', '=', id)
      .execute()

    const issued = generateToken()

    const created = await db
      .insertInto('access_tokens')
      .values({
        user_id: user.id,
        // Named for what it replaces, so the pair is recognisable in a list
        // that will contain both of them for a day.
        name: String(existing.name),
        prefix: issued.prefix,
        token_hash: issued.hash,
        selection: existing.selection,
        organization_id: existing.organization_id,
        expires_at: new Date(expiry.expiresAtMs).toISOString(),
      })
      .returning(['id'])
      .executeTakeFirst()

    const replacementId = Number(created?.id)

    for (const grant of grants) {
      await db
        .insertInto('access_token_permissions')
        .values({ access_token_id: replacementId, scope: grant.scope, level: grant.level })
        .execute()
    }

    for (const entry of repositories) {
      await db
        .insertInto('access_token_repositories')
        .values({ access_token_id: replacementId, repository_id: Number(entry.repository_id) })
        .execute()
    }

    // The old token is brought forward to the end of the overlap rather than
    // revoked. Revoking it would be the gap this feature exists to remove, and
    // an expiry is the honest description of what is happening: it still works,
    // and it stops on its own.
    const oldExpiresAt = new Date(plan.oldExpiresAtMs).toISOString()

    await db
      .updateTable('access_tokens')
      .set({ expires_at: oldExpiresAt })
      .where('id', '=', id)
      .execute()

    // One row, on the replacement, carrying what it replaces. The old token has
    // no event of its own because nothing happened to it that the log does not
    // already imply: it was not revoked, its expiry moved, and this row says
    // when and why.
    await recordTokenAudit({
      event: 'token:created',
      tokenId: replacementId,
      ownerId: user.id,
      prefix: issued.prefix,
      detail: {
        name: String(existing.name),
        replaces: id,
        selection: existing.selection,
        organization_id: existing.organization_id,
        permissions: grants.map((grant: any) => `${grant.scope}:${grant.level}`).sort(),
        expires_at: new Date(expiry.expiresAtMs).toISOString(),
        // The window in which both work, which is the thing somebody reading
        // this row after an incident wants to know the bounds of.
        replaced_token_expires_at: oldExpiresAt,
      },
    })

    return response.json({
      id: replacementId,
      replaces: id,
      name: String(existing.name),
      // The only time this is ever returned.
      token: issued.token,
      prefix: issued.prefix,
      selection: String(existing.selection ?? 'selected'),
      organization_id: existing.organization_id === null ? null : Number(existing.organization_id),
      repository_ids: repositories.map((entry: any) => Number(entry.repository_id)),
      permissions: grants.map((grant: any) => ({ scope: String(grant.scope), level: String(grant.level) })),
      expires_at: new Date(expiry.expiresAtMs).toISOString(),
      // What the caller actually needs to know: how long the thing they are
      // replacing keeps answering.
      previous_expires_at: oldExpiresAt,
      overlap_ms: Math.max(0, plan.oldExpiresAtMs - nowMs),
      overlap_default_ms: ROTATION_OVERLAP_MS,
    }, 201)
  },
})

function parseTime(value: unknown): number | null {
  if (value === null || value === undefined || value === '')
    return null

  const parsed = Date.parse(String(value))

  return Number.isNaN(parsed) ? null : parsed
}

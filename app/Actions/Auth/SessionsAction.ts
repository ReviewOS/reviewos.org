import { Action } from '@stacksjs/actions'
import { schema } from '@stacksjs/validation'
import { auditEvent } from '../../Audit/events'
import { auditFrom } from '../Git/audit'
import { currentUser } from '../Identity/lookup'
import { describeAgent, sessionsFor } from './sessions'
import { sessionCookieName } from './session'

/**
 * The browsers signed in as you, and the button that ends one.
 *
 * The question this answers is "is anybody else signed in as me", and it is
 * asked by somebody who has just sold a laptop, left a job, or seen a
 * notification they did not expect. Most self-hosted software has no answer,
 * and the reason is circular: the token table records nothing you could
 * recognise a row by, so the page would be a column of identical timestamps -
 * and a page you cannot act on is a page nobody builds.
 *
 * So this went in with the two columns that make it usable. `user_agent` and
 * `ip_address` are recorded at sign-in, and the list marks which row is the
 * browser reading it, because "revoke" is a frightening button to press when
 * you cannot tell whether you are about to sign yourself out.
 *
 * **Your own, always.** The rows are found by the caller's own id, and there is
 * no parameter that could say otherwise - so an endpoint that lists somebody
 * else's sessions does not exist to be forgotten. That matters more here than
 * in most places: a list of where an account signs in from is a list of where a
 * person is.
 *
 * One endpoint for the read and the revocation, like the audit log and the
 * instance settings, and for the same reason: a second is a second place the
 * ownership check has to be right.
 */
export default new Action({
  name: 'Sessions',
  description: 'List the sessions signed in as you, or end one',
  method: 'POST',

  validations: {
    operation: { rule: schema.enum(['list', 'revoke', 'revoke-others']) },
    id: { rule: schema.number() },
  },

  async handle(request: any) {
    const user = await currentUser(request)
    if (!user)
      return response.json({ error: 'Unauthenticated' }, 401)

    const name = await sessionCookieName()
    const current = cookieValue(request, name)
    const operation = String(request.get('operation') ?? 'list').trim()

    if (operation === 'list') {
      const sessions = await sessionsFor(user.id, current)

      return response.json({
        sessions: sessions.map(one => ({
          id: one.id,
          current: one.current,
          device: describeAgent(one.userAgent),
          user_agent: one.userAgent,
          ip_address: one.ipAddress,
          created_at: one.createdAt,
          last_seen_at: one.lastSeenAt,
          expires_at: one.expiresAt,
        })),
      })
    }

    if (operation === 'revoke-others') {
      /*
       * The button somebody actually wants.
       *
       * "Sign out everywhere else" is the response to a suspicion, and it has
       * to leave the browser you are pressing it in signed in - otherwise the
       * person who has just realised something is wrong is thrown out of the
       * page where they were dealing with it, which is how they end up not
       * pressing it at all.
       */
      const sessions = await sessionsFor(user.id, current)
      const others = sessions.filter(one => !one.current)

      for (const one of others)
        await revoke(one.id, user.id)

      await auditEvent('session:revoked', {
        subject: { type: 'user', id: user.id },
        actorId: user.id,
        ...await auditFrom(request),
        detail: { count: others.length, kept_current: true },
      })

      return response.json({ revoked: others.length })
    }

    if (operation !== 'revoke')
      return response.json({ error: `Unknown operation: ${operation}` }, 422)

    const id = Number(request.get('id') ?? 0)

    if (!Number.isInteger(id) || id <= 0)
      return response.json({ error: 'Which session?' }, 422)

    /*
     * Scoped to the caller in the update, not checked and then updated.
     *
     * One statement that can only ever match a row the caller owns has no
     * window in between and cannot be got wrong by a later edit - the same
     * shape the key deletions use. A session id that is not theirs matches
     * nothing, and the answer is the same as for one that was just revoked:
     * anything else tells whoever is guessing ids which ones exist.
     */
    const sessions = await sessionsFor(user.id, current)
    const target = sessions.find(one => one.id === id)

    await revoke(id, user.id)

    if (target) {
      await auditEvent('session:revoked', {
        subject: { type: 'user', id: user.id },
        actorId: user.id,
        ...await auditFrom(request),
        detail: { count: 1, was: describeAgent(target.userAgent), current: target.current },
      })
    }

    return response.json({ ok: true })
  },
})

/** Revoke one session row, scoped to its owner in the statement. */
async function revoke(id: number, userId: number): Promise<void> {
  await db
    .updateTable('oauth_access_tokens')
    .set({ revoked: true })
    .where('id', '=', id)
    .where('user_id', '=', userId)
    .execute()
}

/** The value of one cookie on this request, or an empty string. */
function cookieValue(request: any, name: string): string {
  const header = String(request?.headers?.get?.('cookie') ?? request?.header?.('cookie') ?? '')

  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=')

    if (key === name)
      return decodeURIComponent(rest.join('='))
  }

  return ''
}

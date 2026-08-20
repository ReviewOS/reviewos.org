import { Action } from '@stacksjs/actions'
import { db } from '@stacksjs/database'
import { encrypt } from '@stacksjs/security'
import { schema } from '@stacksjs/validation'
import { dbTimestamp } from '../Support/sql'
import { GitHubClient } from './github-client'

/**
 * Connecting, listing and disconnecting your own credential for a forge.
 *
 * The half of write-through review that makes the other half usable: without
 * somewhere for a person to put their own token, `credentialFor` always answers
 * null and every review stays local. There is deliberately no admin path to add
 * one *for* somebody - a credential that acts as a person has to be handed over
 * by that person, or the attribution it exists to protect is a fiction.
 *
 * ## The token is checked before it is stored
 *
 * A token that does not work is worth refusing at the moment somebody can fix
 * it, rather than at the moment they submit a review and find out their verdict
 * did not travel. So the token is used once, against the host it names, to ask
 * who it belongs to - and the login that comes back is what is displayed
 * afterwards. A token whose owner cannot be read is not stored.
 *
 * ## What is never returned
 *
 * The token, in any form. The list shows the host, the login it acts as, when
 * it was last used and the last error - which is everything the person needs to
 * decide whether to reconnect, and nothing an attacker who reaches the endpoint
 * can use elsewhere.
 */
export default new Action({
  name: 'ForgeCredential',
  description: 'Connect, list or disconnect your own credential for an upstream forge',

  method: 'POST',

  validations: {
    operation: { rule: schema.enum(['connect', 'list', 'disconnect']) },
    host: { rule: schema.string().max(255) },
    provider: { rule: schema.enum(['github', 'gitlab', 'gitea']) },
    token: { rule: schema.string().max(500) },
  },

  async handle(request: any) {
    const { response } = await import('@stacksjs/router')
    const { currentUser } = await import('../Identity/lookup')
    const user = await currentUser(request)

    if (!user)
      return response.json({ error: 'Sign in first.' }, 401)

    const operation = String(request.get('operation') ?? 'list')
    const provider = String(request.get('provider') ?? 'github')
    const host = String(request.get('host') ?? 'github.com').trim().toLowerCase()

    if (operation === 'list') {
      const rows = await db
        .selectFrom('forge_credentials')
        .select(['id', 'provider', 'host', 'remote_login', 'scopes', 'last_used_at', 'last_error'])
        .where('user_id', '=', Number(user.id))
        .execute()

      return response.json({
        credentials: rows.map(row => ({
          id: Number(row.id),
          provider: String(row.provider),
          host: String(row.host),
          acting_as: row.remote_login ? String(row.remote_login) : null,
          scopes: String(row.scopes ?? '').split(/[\s,]+/).filter(Boolean),
          last_used_at: row.last_used_at ?? null,
          last_error: row.last_error ?? null,
        })),
      })
    }

    if (operation === 'disconnect') {
      await db
        .deleteFrom('forge_credentials')
        .where('user_id', '=', Number(user.id))
        .where('provider', '=', provider)
        .where('host', '=', host)
        .execute()

      // Deleted rather than disabled. A credential somebody has taken back
      // should not survive as a row that could be re-enabled by anybody.
      return response.json({ disconnected: true, host })
    }

    const token = String(request.get('token') ?? '').trim()

    if (!token)
      return response.json({ error: 'A credential needs a token.' }, 422)

    if (!/^[\w.\-~+/]+=*$/.test(token))
      return response.json({ error: 'That does not look like a token.' }, 422)

    /*
     * Used once, against the host it names, before it is stored.
     *
     * The base URL is derived from the host rather than taken from the request,
     * so a caller cannot have this instance send their token - or anybody
     * else's - to a server of their choosing. `github.com` is the API's own
     * exception: its API lives on a different name than its website.
     */
    const baseUrl = host === 'github.com' ? 'https://api.github.com' : `https://${host}/api/v3`

    if (!/^[a-z0-9.-]+$/.test(host))
      return response.json({ error: 'That is not a host.' }, 422)

    const client = new GitHubClient({ token, baseUrl })
    const whoami = await client.viewer()

    if (!whoami.ok)
      return response.json({ error: `That token was refused by ${host}: ${whoami.message}` }, 422)

    const now = dbTimestamp()
    const sealed = String(await encrypt(token))

    const existing = await db
      .selectFrom('forge_credentials')
      .select(['id'])
      .where('user_id', '=', Number(user.id))
      .where('provider', '=', provider)
      .where('host', '=', host)
      .executeTakeFirst()

    if (existing) {
      await db
        .updateTable('forge_credentials')
        .set({ sealed, remote_login: whoami.login, scopes: whoami.scopes.join(' '), last_error: null, updated_at: now })
        .where('id', '=', Number(existing.id))
        .execute()
    }
    else {
      await db
        .insertInto('forge_credentials')
        .values({
          user_id: Number(user.id),
          provider,
          host,
          remote_login: whoami.login,
          scopes: whoami.scopes.join(' '),
          sealed,
          created_at: now,
          updated_at: now,
        })
        .execute()
    }

    return response.json({ connected: true, host, acting_as: whoami.login, scopes: whoami.scopes })
  },
})

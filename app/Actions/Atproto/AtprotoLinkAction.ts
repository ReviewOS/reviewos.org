import { Action } from '@stacksjs/actions'
import { db } from '@stacksjs/database'
import { schema } from '@stacksjs/validation'
import { dbTimestamp } from '../Support/sql'
import { resolveIdentity } from './identity'

/**
 * Link, list or unlink an AT Protocol identity on your own account.
 *
 * This is the whole of the federation surface, and its smallness is the point.
 * Phase 10 chose identity portability over content federation, so there is no
 * inbox to defend and no delivery to retry: somebody proves which permanent
 * identifier is theirs, and afterwards this instance knows them by it.
 *
 * ## Linking proves the identifier, not the person
 *
 * Resolution verifies that the handle and the DID document agree - which stops
 * somebody pointing a domain they own at somebody else's DID - but it does not
 * prove that the person at the keyboard controls either. That proof is the
 * signature step, and it needs a PDS to sign against; until this instance can
 * ask for one, **linking is an authenticated action that binds an identity to
 * the account already signed in**, which is the same trust model as adding an
 * email address and is stated here rather than implied.
 *
 * Signing *in* with a DID - the thing that removes the registration form - is
 * deliberately not built on top of that weaker proof. It waits for the
 * signature, because an unproven identity that can create a session is an
 * account takeover with extra steps.
 */
export default new Action({
  name: 'AtprotoLink',
  description: 'Link, list or unlink an AT Protocol identity on your own account',

  method: 'POST',

  validations: {
    operation: { rule: schema.enum(['link', 'list', 'unlink']) },
    identifier: { rule: schema.string().max(253) },
  },

  async handle(request: any) {
    const { response } = await import('@stacksjs/router')
    const { currentUser } = await import('../Identity/lookup')
    const user = await currentUser(request)

    if (!user)
      return response.json({ error: 'Sign in first.' }, 401)

    const operation = String(request.get('operation') ?? 'list')

    if (operation === 'list') {
      const rows = await db
        .selectFrom('atproto_identities')
        .select(['id', 'did', 'handle', 'pds', 'last_verified_at'])
        .where('user_id', '=', Number(user.id))
        .execute()

      return response.json({ identities: rows })
    }

    const identifier = String(request.get('identifier') ?? '').trim().toLowerCase()

    if (!identifier)
      return response.json({ error: 'Give a handle or a DID.' }, 422)

    if (operation === 'unlink') {
      // By DID rather than by row id: the caller knows the identity, and
      // scoping the delete to their own user is what stops one account
      // unlinking another's.
      await db
        .deleteFrom('atproto_identities')
        .where('user_id', '=', Number(user.id))
        .where('did', '=', identifier)
        .execute()

      return response.json({ unlinked: true, did: identifier })
    }

    const identity = await resolveIdentity(identifier)

    if (!identity) {
      return response.json({
        error: 'That identity could not be verified. A handle has to name a DID whose document names the handle back.',
      }, 422)
    }

    const taken = await db
      .selectFrom('atproto_identities')
      .select(['user_id'])
      .where('did', '=', identity.did)
      .executeTakeFirst()

    if (taken && Number(taken.user_id) !== Number(user.id)) {
      // Deliberately the same sentence whoever asks: "linked to another
      // account" would confirm that an identity exists here to somebody
      // enumerating handles.
      return response.json({ error: 'That identity cannot be linked.' }, 409)
    }

    const now = dbTimestamp()

    if (taken) {
      await db
        .updateTable('atproto_identities')
        .set({ handle: identity.handle, pds: identity.pds, last_verified_at: now, updated_at: now })
        .where('did', '=', identity.did)
        .execute()
    }
    else {
      await db
        .insertInto('atproto_identities')
        .values({
          user_id: Number(user.id),
          did: identity.did,
          handle: identity.handle,
          pds: identity.pds,
          last_verified_at: now,
          created_at: now,
          updated_at: now,
        })
        .execute()
    }

    return response.json({ linked: true, did: identity.did, handle: identity.handle, pds: identity.pds })
  },
})

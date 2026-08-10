import { Action } from '@stacksjs/actions'
import { auditEvent } from '../../Audit/events'
import { auditFrom } from '../Git/audit'
import { currentUser } from '../Identity/lookup'
import { fingerprintOf, parseSshPublicKey } from './ssh'

/**
 * Register a public key for pushing.
 *
 * The fingerprint is unique across every account, so a key already registered
 * elsewhere is refused rather than silently attached to a second identity:
 * whoever holds the private half would otherwise be able to push as either.
 */
export default new Action({
  name: 'AddSshKey',
  description: 'Register an SSH public key for the caller',
  method: 'POST',

  async handle(request: any) {
    const user = await currentUser(request)
    if (!user)
      return response.json({ error: 'Unauthenticated' }, 401)

    const raw = String(request.get('key') ?? '')
    const parsed = parseSshPublicKey(raw)
    if (!parsed.ok)
      return response.json({ error: parsed.message }, 422)

    const fingerprint = await fingerprintOf(parsed.body)

    const clash = await db
      .selectFrom('ssh_keys')
      .select(['id', 'user_id'])
      .where('fingerprint', '=', fingerprint)
      .executeTakeFirst()

    if (clash) {
      return response.json({
        error: Number(clash.user_id) === user.id
          ? 'You have already added this key.'
          : 'That key is already registered to another account.',
      }, 409)
    }

    const title = String(request.get('title') ?? '').trim() || parsed.comment || 'SSH key'

    const created = await db
      .insertInto('ssh_keys')
      .values({
        user_id: user.id,
        title,
        key_type: parsed.type,
        public_key: `${parsed.type} ${parsed.body}`,
        fingerprint,
      })
      .returning(['id'])
      .executeTakeFirst()

    /*
     * A key is a credential that can push, and it is the one credential with no
     * expiry, no login notification and no session list. The fingerprint is
     * public by design - it is on the settings page and in every log line the
     * ssh daemon writes - so recording it is what lets somebody match "this key
     * pushed that" to "this key was added then, by this account".
     */
    await auditEvent('key:added', {
      subject: { type: 'ssh_key', id: Number(created?.id) },
      actorId: user.id,
      ...await auditFrom(request),
      detail: { kind: 'ssh', title, fingerprint, key_type: parsed.type },
    })

    return response.json({ id: Number(created?.id), title, fingerprint }, 201)
  },
})

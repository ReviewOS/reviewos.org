import { Action } from '@stacksjs/actions'
import { auditEvent } from '../../Audit/events'
import { auditFrom } from '../Git/audit'
import { currentUser } from '../Identity/lookup'
import { readGpgKey } from './gpg'

/**
 * Register a GPG public key, so signed commits can be verified as this account's.
 *
 * The fingerprint is unique across every account, for the same reason an SSH
 * key's is: a key identifies whoever holds the private half, so the same key on
 * two accounts would make a signature's author ambiguous.
 *
 * The addresses are stored as they are on the key. That is what the
 * verification matches a commit's author against, and taking the account's
 * email instead would verify commits the key never claimed.
 */
export default new Action({
  name: 'AddGpgKey',
  description: 'Register a GPG public key for the caller',
  method: 'POST',

  async handle(request: RequestInstance) {
    const user = await currentUser(request)
    if (!user)
      return response.json({ error: 'Unauthenticated' }, 401)

    const parsed = await readGpgKey(String(request.get('key') ?? ''))
    if (!parsed.ok)
      return response.json({ error: parsed.message }, 422)

    const clash = await db
      .selectFrom('gpg_keys')
      .select(['id', 'user_id'])
      .where('key_id', '=', parsed.fingerprint)
      .executeTakeFirst()

    if (clash) {
      return response.json({
        error: Number(clash.user_id) === user.id
          ? 'You have already added this key.'
          : 'That key is already registered to another account.',
      }, 409)
    }

    const created = await db
      .insertInto('gpg_keys')
      .values({
        user_id: user.id,
        // The full fingerprint, not the short id: `sameKey` matches by suffix,
        // so the longer form is the one that cannot collide.
        key_id: parsed.fingerprint,
        public_key: String(request.get('key') ?? '').trim(),
        emails: JSON.stringify(parsed.emails),
        expires_at: parsed.expiresAt,
      })
      .returning(['id'])
      .executeTakeFirst()

    // A GPG key cannot push, so this is not quite the credential an SSH key is.
    // It is still an identity claim: it decides which commits this account is
    // shown as having signed, and a key added quietly is signatures verified
    // quietly.
    await auditEvent('key:added', {
      subject: { type: 'gpg_key', id: Number(created?.id) },
      actorId: user.id,
      ...await auditFrom(request),
      detail: { kind: 'gpg', fingerprint: parsed.fingerprint, emails: parsed.emails },
    })

    return response.json({
      id: Number(created?.id),
      keyId: parsed.keyId,
      emails: parsed.emails,
      expiresAt: parsed.expiresAt,
    }, 201)
  },
})

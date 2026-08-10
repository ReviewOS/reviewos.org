import { Action } from '@stacksjs/actions'
import { schema } from '@stacksjs/validation'
import { auditEvent } from '../../Audit/events'
import { auditFrom } from '../Git/audit'
import { currentUser } from '../Identity/lookup'
import { issueRecoveryCodes, remainingRecoveryCodes, verifySecondFactor } from './twoFactor'

/**
 * Turning the second factor on, and off, and getting new recovery codes.
 *
 * One endpoint with an `operation`, like the other management surfaces here: a
 * browser form can only send GET or POST, and every write in this product goes
 * through one.
 *
 * **Enrolment is two requests and the second one is not optional.** `begin`
 * writes a secret and leaves the factor off; `enable` turns it on only after a
 * code from that secret has been verified. Skipping the verification is the
 * commonest way this feature locks people out - a wrong clock, or a QR code
 * photographed and never scanned - and they find out at the next sign-in with
 * no way back.
 *
 * **Your own, always.** Every operation acts on the caller and takes no user
 * id, so an endpoint that turns off somebody else's second factor does not
 * exist to be forgotten.
 */
export default new Action({
  name: 'TwoFactor',
  description: 'Enrol in two-factor authentication, disable it, or reissue recovery codes',
  method: 'POST',

  validations: {
    operation: { rule: schema.enum(['status', 'begin', 'enable', 'disable', 'recovery-codes']) },
    code: { rule: schema.string() },
  },

  async handle(request: any) {
    const user = await currentUser(request)
    if (!user)
      return response.json({ error: 'Unauthenticated' }, 401)

    const row: any = await db
      .selectFrom('users')
      .select(['id', 'email', 'handle', 'two_factor_secret', 'two_factor_enabled'])
      .where('id', '=', user.id)
      .executeTakeFirst()

    if (!row)
      return response.json({ error: 'Unauthenticated' }, 401)

    const enabled = Boolean(row.two_factor_enabled)
    const operation = String(request.get('operation') ?? 'status').trim()

    if (operation === 'status') {
      return response.json({
        enabled,
        // So a settings page can warn before somebody runs out rather than
        // after, which is the difference between a nuisance and a lockout.
        recovery_codes_remaining: enabled ? await remainingRecoveryCodes(user.id) : 0,
      })
    }

    if (operation === 'begin') {
      if (enabled)
        return response.json({ error: 'Two-factor is already on. Disable it first to enrol a new device.' }, 409)

      const { generateTwoFactorSecret, generateTwoFactorUri } = await import('@stacksjs/auth')
      const secret = generateTwoFactorSecret()

      /*
       * Written, and the factor stays off.
       *
       * A secret with `two_factor_enabled = false` grants nothing and blocks
       * nothing - it is a scratch value until `enable` verifies a code from it.
       * Keeping it in the database rather than in the response means the second
       * request does not have to be trusted with it, and an abandoned enrolment
       * is overwritten by the next `begin` rather than left in a session.
       */
      await db.updateTable('users').set({ two_factor_secret: secret }).where('id', '=', user.id).execute()

      const label = String(row.email ?? row.handle ?? `user ${user.id}`)
      const { instanceName } = await instanceLabel()

      return response.json({
        // The URI, not a rendered QR code. Drawing one is the page's job, and
        // an image generated here would have to be inlined into a JSON response
        // and rendered by the caller anyway.
        otpauth_uri: generateTwoFactorUri(label, instanceName, secret),
        secret,
        next: 'Scan it, then send the six digits to `enable`.',
      })
    }

    if (operation === 'enable') {
      if (enabled)
        return response.json({ error: 'Two-factor is already on.' }, 409)

      const secret = String(row.two_factor_secret ?? '')

      if (!secret)
        return response.json({ error: 'Start with `begin` to get a secret to scan.' }, 409)

      const { verifyTwoFactorCode } = await import('@stacksjs/auth')
      const code = String(request.get('code') ?? '').trim()

      // The verification that makes this safe to turn on. Recovery codes are
      // not accepted here - there are none yet, and accepting one would mean
      // enabling the factor without ever proving the device works.
      if (!/^\d{6}$/.test(code) || !await verifyTwoFactorCode(code, secret))
        return response.json({ error: 'That code is not right. Check your device clock and try the current one.' }, 422)

      await db.updateTable('users').set({ two_factor_enabled: true }).where('id', '=', user.id).execute()

      // Issued by the same click that enables the factor. Everybody understands
      // the second factor; what stops them turning it on is losing the device,
      // and this is the answer to that.
      const codes = await issueRecoveryCodes(user.id)

      await auditEvent('two-factor:enabled', {
        subject: { type: 'user', id: user.id },
        actorId: user.id,
        ...await auditFrom(request),
        detail: { recovery_codes: codes.length },
      })

      return response.json({
        enabled: true,
        recovery_codes: codes,
        warning: 'These are shown once. Store them somewhere that is not this device.',
      })
    }

    if (operation === 'disable') {
      if (!enabled)
        return response.json({ enabled: false })

      /*
       * A current code is required to turn it off.
       *
       * Without it, a stolen session is a way past two-factor: sign in with the
       * cookie somebody left on a shared machine, disable the factor, and the
       * account is back to a password. Requiring the factor to remove the
       * factor is the whole point of having it.
       *
       * A recovery code works here, because somebody whose phone is gone is
       * precisely who needs to turn it off.
       */
      const check = await verifySecondFactor(row, String(request.get('code') ?? ''))

      if (!check.ok)
        return response.json({ error: 'Enter a current code, or one of your recovery codes.' }, 422)

      await db
        .updateTable('users')
        .set({ two_factor_enabled: false, two_factor_secret: null })
        .where('id', '=', user.id)
        .execute()

      // The codes go with it. Leaving them live would mean a set somebody
      // printed still bypasses a factor they later turn back on with a
      // different device.
      await db.deleteFrom('recovery_codes').where('user_id', '=', user.id).execute()

      await auditEvent('two-factor:disabled', {
        subject: { type: 'user', id: user.id },
        actorId: user.id,
        ...await auditFrom(request),
        detail: { used_recovery_code: Boolean(check.usedRecoveryCode) },
      })

      return response.json({ enabled: false })
    }

    if (operation !== 'recovery-codes')
      return response.json({ error: `Unknown operation: ${operation}` }, 422)

    if (!enabled)
      return response.json({ error: 'Two-factor is not on, so there is nothing to recover.' }, 409)

    // Reissuing needs the factor too, for the same reason disabling does.
    if (!(await verifySecondFactor(row, String(request.get('code') ?? ''))).ok)
      return response.json({ error: 'Enter a current code, or one of your recovery codes.' }, 422)

    const codes = await issueRecoveryCodes(user.id)

    await auditEvent('two-factor:recovery-codes-reissued', {
      subject: { type: 'user', id: user.id },
      actorId: user.id,
      ...await auditFrom(request),
      detail: { recovery_codes: codes.length },
    })

    return response.json({
      recovery_codes: codes,
      warning: 'The previous set stopped working just now.',
    })
  },
})

/**
 * What the authenticator app should call this instance.
 *
 * The instance's own name, from the settings table, because a phone with three
 * entries all reading "ReviewOS" is a phone whose owner cannot tell which
 * belongs to work.
 */
async function instanceLabel(): Promise<{ instanceName: string }> {
  try {
    const { setting } = await import('../../Ops/settings')

    return { instanceName: await setting('instance_name') }
  }
  catch {
    return { instanceName: 'ReviewOS' }
  }
}

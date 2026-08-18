/**
 * Telling somebody their account was signed into from somewhere new.
 *
 * The one notification in this product that is not about the product. Every
 * other message here is "somebody replied to you"; this one is "somebody may
 * not be you", and it is the only signal a person gets between a password
 * leaking and the damage being visible.
 *
 * ## What counts as new
 *
 * A device is new when this account has no *earlier* session recording the same
 * browser family and the same address. Both, not either:
 *
 * - Agent alone cries wolf constantly. Chrome updates every fortnight and the
 *   version is in the string, so a raw comparison makes every update a new
 *   device - and a warning that fires monthly is one people learn to dismiss,
 *   which is worse than none because they dismiss the real one too.
 * - Address alone is worse in the other direction. A phone changes address
 *   walking between two rooms, and an office shares one between everybody.
 *
 * So the agent is compared **coarsely** - "Chrome on macOS", the same
 * description the session list shows - and the address exactly. A person moving
 * between home and a cafe on the same laptop gets one notification per network,
 * which is the right amount: they can recognise it, and an attacker cannot
 * avoid it without also being on their network.
 *
 * ## Never fails a sign-in
 *
 * Everything here runs after the session exists, and every failure is
 * swallowed. Refusing to sign somebody in because a notification could not be
 * written is a worse outcome than the notification not arriving, and it is the
 * outcome that gets the feature removed.
 */

import { describeAgent } from './sessions'
import { db } from '@stacksjs/database'

export interface SignInContext {
  userId: number
  /** The session row just created, so it is excluded from "have we seen this". */
  tokenId?: number | null
  userAgent: string | null
  ipAddress: string | null
}

/**
 * Whether this account has signed in from this device and address before.
 *
 * Reads the token table rather than a table of its own. A second table of
 * "known devices" is one more thing to keep in step with revocation, and the
 * question - "has a session ever existed with this shape?" - is one the token
 * rows already answer. Sessions the person has revoked still count as seen:
 * revoking a session says "not now", not "I have never used that laptop", and
 * treating a revocation as amnesia would notify them again about their own
 * phone.
 */
export async function isKnownDevice(context: SignInContext): Promise<boolean> {
  const description = describeAgent(context.userAgent)

  try {
    const rows = await db
      .selectFrom('oauth_access_tokens')
      .select(['id', 'user_agent', 'ip_address'])
      .where('user_id', '=', context.userId)
      .execute()

    return rows.some((row) => {
      // The session that was just created is not evidence of itself.
      if (context.tokenId && Number(row.id) === Number(context.tokenId))
        return false

      const seenAgent = row.user_agent ? String(row.user_agent) : null
      const seenAddress = row.ip_address ? String(row.ip_address) : null

      return describeAgent(seenAgent) === description && seenAddress === context.ipAddress
    })
  }
  catch {
    /*
     * Unknown means *known*, and that is the deliberate direction.
     *
     * A database that will not answer would otherwise make every sign-in look
     * new, and an instance that emails somebody on every single sign-in has
     * taught them to ignore the one that mattered within a week. A missed
     * warning is bad; a warning nobody reads is the same thing plus noise.
     */
    return true
  }
}

/**
 * One line, as somebody reads it in an inbox at a glance.
 *
 * Deliberately says where *and* when, and deliberately does not say "suspicious"
 * or "unrecognised". Most of these are the person themselves on a new laptop,
 * and language that starts by alarming them is language they stop reading.
 */
export function describeSignIn(context: SignInContext, when: Date): string {
  const device = describeAgent(context.userAgent)
  const where = context.ipAddress ? ` from ${context.ipAddress}` : ''
  const at = when.toISOString().replace('T', ' ').slice(0, 16)

  return `New sign-in: ${device}${where} at ${at} UTC`
}

/**
 * Write the notification, if this device is new.
 *
 * Inbox only, and that is a real decision rather than a first step. The inbox
 * is the channel that works when mail is misconfigured, which on a self-hosted
 * instance is most of them - and a security notice that depends on the one
 * subsystem an operator most often skips is a security notice that does not
 * exist. An instance with mail set up gets it by email too, through the
 * ordinary delivery path, once notification preferences cover this type.
 *
 * Returns whether anything was written, for the test and for nothing else.
 */
export async function noticeSignIn(context: SignInContext, now = new Date()): Promise<boolean> {
  try {
    if (await isKnownDevice(context))
      return false


    await db.insertInto('notifications').values({
      user_id: context.userId,
      type: 'auth:new-device',
      data: JSON.stringify({
        title: describeSignIn(context, now),
        // Straight to the list, which is the only useful thing to do about it -
        // a notice with nowhere to go is one people read and forget.
        url: '/settings/sessions',
        reason: 'this is a new device on your account',
        device: describeAgent(context.userAgent),
        ip_address: context.ipAddress,
      }),
    }).execute()

    return true
  }
  catch {
    // Never fails a sign-in. See the note at the top of this file.
    return false
  }
}

import type { MuteDuration, SubjectType } from './settings'
import { Action } from '@stacksjs/actions'
import { schema } from '@stacksjs/validation'
import { currentUser } from '../Identity/lookup'
import { MUTE_DURATIONS, muteExpiry } from './settings'
import { coerced } from '../inputs'

const SUBJECTS = ['repository', 'organization', 'issue', 'pull_request'] as const

/**
 * Mute or unmute a repository, organization, issue, or pull request.
 *
 * Reachable from wherever the subject appears rather than only from settings,
 * because a mute somebody has to go and find is a mute they will not use: they
 * will turn notifications off entirely instead, and then be unreachable for the
 * review everybody is waiting on.
 *
 * Muting is not unwatching. The subscription is left alone, so unmuting restores
 * exactly what was there.
 */
export default new Action({
  name: 'MuteNotifications',
  description: 'Mute or unmute notifications for a subject',
  method: 'POST',

  // Declared so the document can publish them: every key is one the handler
  // reads. **Enforced, not descriptive**: the framework checks these before the
  // handler runs and answers 422 itself, so a named type here is a promise that
  // the endpoint refuses every other spelling of the value. A field the handler
  // coerces takes `coerced` from `app/Actions/inputs.ts` instead.
  validations: {
    duration: { rule: schema.string() },
    muted: { rule: schema.string() },
    subject_id: { rule: coerced },
    subject_type: { rule: schema.string() },
  },

  async handle(request: RequestInstance) {
    const user = await currentUser(request)
    if (!user)
      return response.json({ error: 'Unauthenticated' }, 401)

    const subjectType = String(request.get('subject_type') ?? '')
    if (!(SUBJECTS as readonly string[]).includes(subjectType))
      return response.json({ error: 'A subject is a repository, organization, issue, or pull request' }, 422)

    const subjectId = Number(request.get('subject_id'))
    if (!Number.isInteger(subjectId) || subjectId <= 0)
      return response.json({ error: 'A subject is required' }, 422)

    const existing = await db
      .selectFrom('notification_mutes')
      .select(['id'])
      .where('user_id', '=', user.id)
      .where('subject_type', '=', subjectType as SubjectType)
      .where('subject_id', '=', subjectId)
      .executeTakeFirst()

    // Unmuting deletes the row rather than expiring it. There is nothing worth
    // keeping about a mute somebody has ended.
    if (request.get('muted') === false || String(request.get('muted') ?? '') === 'false') {
      if (existing) {
        await db
          .deleteFrom('notification_mutes')
          .where('id', '=', Number(existing.id))
          .execute()
      }

      return response.json({ subject_type: subjectType, subject_id: subjectId, muted: false })
    }

    const duration = String(request.get('duration') ?? 'forever')
    if (!(MUTE_DURATIONS as readonly string[]).includes(duration))
      return response.json({ error: `A duration is one of ${MUTE_DURATIONS.join(', ')}` }, 422)

    const schedule = await db
      .selectFrom('notification_schedules')
      .select(['timezone'])
      .where('user_id', '=', user.id)
      .executeTakeFirst()

    const expiresAt = muteExpiry(
      duration as MuteDuration,
      String(schedule?.timezone ?? 'UTC'),
      Date.now(),
    )

    const expiresAtText = expiresAt === null ? null : new Date(expiresAt).toISOString()

    if (existing) {
      await db
        .updateTable('notification_mutes')
        .set({ expires_at: expiresAtText })
        .where('id', '=', Number(existing.id))
        .execute()
    }
    else {
      await db
        .insertInto('notification_mutes')
        .values({
          user_id: user.id,
          subject_type: subjectType as SubjectType,
          subject_id: subjectId,
          expires_at: expiresAtText,
        })
        .execute()
    }

    return response.json({
      subject_type: subjectType,
      subject_id: subjectId,
      muted: true,
      expires_at: expiresAtText,
    }, existing ? 200 : 201)
  },
})

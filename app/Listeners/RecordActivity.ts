import type { EventSubject, NotificationEvent } from '../Notifications/definitions'
import { activityFor } from '../Activity/verbs'

/**
 * Write down that something happened.
 *
 * The third listener on the same nine events, beside `Notify` and
 * `DispatchWebhooks`, and separate for the same reason they are separate from
 * each other: they answer different questions and fail differently. Notifying
 * is about subscriptions and quiet hours, webhooks are about signatures and
 * SSRF, and this is a record. Sharing a listener would let one failure cost the
 * others, and the record is the one that should survive the other two being
 * misconfigured.
 *
 * **Visibility is decided here and stored**, from the repository as it is at
 * this moment. Deriving it when the feed is read would make a repository going
 * private retroactively erase its history from the people who were there, and -
 * far worse - a repository going public retroactively expose activity from when
 * it was not. Only one of those two is noticed.
 *
 * Never throws. An event is a consequence of somebody's action and must not be
 * able to fail it: by the time this runs a branch has moved and a row says
 * merged.
 */
export default {
  listensTo: [
    'pr:opened',
    'pr:merged',
    'pr:closed',
    'review:submitted',
    'issue:opened',
    'issue:closed',
    'comment:created',
    'release:published',
  ],

  async handle(payload: EventSubject & { event?: NotificationEvent }, eventName?: string): Promise<void> {
    try {
      // Both accepted, for the reason written in `Notify`: the two event
      // libraries in play disagree about whether a handler is told which event
      // fired, and guessing wrong records every row under the first verb.
      const event = String(payload.event ?? eventName ?? '')
      const activity = activityFor(event, payload)

      if (!activity)
        return

      const repositoryId = Number(payload.repositoryId ?? 0)

      // Read rather than assumed. A public repository's activity is public and
      // a private one's is not, and the whole point of storing the answer is
      // that it is the answer *now*.
      const repository: any = repositoryId
        ? await db
            .selectFrom('repositories')
            .select(['id', 'visibility', 'owner_type', 'owner_id'])
            .where('id', '=', repositoryId)
            .executeTakeFirst()
        : null

      // A repository that cannot be read is not public. Defaulting the other
      // way would make a missing row a disclosure, and a missing row is exactly
      // what a race between a delete and an event looks like.
      const isPublic = String(repository?.visibility ?? '') === 'public'

      await db.insertInto('activity_events').values({
        actor_id: Number(payload.actorId),
        verb: activity.verb,
        subject_type: String(payload.subjectType ?? ''),
        subject_id: Number(payload.subjectId ?? 0),
        repository_id: repositoryId || null,
        organization_id: String(repository?.owner_type ?? '') === 'organization'
          ? Number(repository?.owner_id ?? 0) || null
          : null,
        is_public: isPublic,
        detail: activity.detail,
      }).execute()
    }
    catch (error) {
      // Reported rather than swallowed. A feed that quietly stopped filling
      // reads exactly like a quiet week, which is the failure this codebase has
      // already been bitten by on two other channels.
      console.error('[activity] could not record:', error)
    }
  },
}

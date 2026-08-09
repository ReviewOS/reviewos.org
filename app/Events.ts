import type { Events } from '@stacksjs/types'

/**
 * **Events Configuration**
 *
 * This configuration defines all of your events. Because Stacks is fully-typed, you may
 * hover any of the options below and the definitions will be provided. In case you
 * have any questions, feel free to reach out via Discord or GitHub Discussions.
 */
export default {
  // eventName: ['Listener1', 'Listener2'] -> listeners default to ./app/actions/*
  'user:registered': ['SendWelcomeEmail'],
  'user:created': ['NotifyUser'],

  // A sync reports what it did rather than the job deciding who cares, so
  // reindexing and notifications can be added without touching the fetch.
  'mirror:synced': ['MirrorSynced'],
  'mirror:failed': ['MirrorFailed'],

  // Metadata is reported separately from refs: one means the code moved, the
  // other means the discussion around it did, and a reader cares about them
  // at different times.
  'mirror:metadata-synced': ['MirrorMetadataSynced'],
  'mirror:metadata-failed': ['MirrorMetadataFailed'],

  /*
   * The domain events, all handled by one listener.
   *
   * One rather than ten, because every one of them does the same thing: work
   * out who is subscribed and why, and write them an inbox entry. Ten listeners
   * would be ten copies of that with the reason string changed, and the tenth
   * would be the one that forgets not to notify the person who caused it.
   *
   * The *shape* of each payload is what differs, and that lives in
   * `app/Notifications/` where it can be read next to the sentence it produces.
   *
   * `DispatchWebhooks` is a second listener rather than a branch inside the
   * first, because the two answer different questions and fail differently.
   * Notifying a person is about subscriptions and quiet hours; calling
   * somebody's server is about signatures, timeouts and SSRF. Sharing a
   * listener would mean one failure could cost the other, and the inbox is the
   * channel that has to work when everything else does not.
   *
   * `RecordActivity` is a third, on the same reasoning. It is a record rather
   * than a message, and it should survive the other two being misconfigured -
   * a forge whose webhooks are broken should still be able to say what
   * happened. `review:requested` is deliberately not among its events: asking
   * somebody for a review is a message to that person, and a feed listing it
   * reports who is behind on what to anybody who scrolls.
   */
  'pr:opened': ['Notify', 'DispatchWebhooks', 'RecordActivity'],
  /*
   * Webhooks only, for both of these, and that is the interesting part.
   *
   * `pr:synchronized` is a push to an open pull request's branch, and it is the
   * event a reviewing agent most needs: without it, an agent that reviewed a
   * change and hears nothing when the author pushes a fix must either poll
   * every open pull request forever or never look again.
   *
   * Notifying a *person* about it would be wrong. Telling every reviewer about
   * every push is how an inbox becomes something people filter, and the inbox
   * is the channel that has to work when everything else does not. It is also
   * not activity: a feed of "pushed again" entries buries the things somebody
   * would actually scroll to find.
   */
  'pr:synchronized': ['DispatchWebhooks'],
  'pr:ready_for_review': ['DispatchWebhooks'],
  'pr:merged': ['Notify', 'DispatchWebhooks', 'RecordActivity'],
  'pr:closed': ['Notify', 'DispatchWebhooks', 'RecordActivity'],
  'review:requested': ['Notify', 'DispatchWebhooks'],
  'review:submitted': ['Notify', 'DispatchWebhooks', 'RecordActivity'],
  'issue:opened': ['Notify', 'DispatchWebhooks', 'RecordActivity'],
  'issue:closed': ['Notify', 'DispatchWebhooks', 'RecordActivity'],
  'comment:created': ['Notify', 'DispatchWebhooks', 'RecordActivity'],
  'release:published': ['Notify', 'DispatchWebhooks', 'RecordActivity'],
} satisfies Events

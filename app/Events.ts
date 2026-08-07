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
   */
  'pr:opened': ['Notify', 'DispatchWebhooks'],
  'pr:merged': ['Notify', 'DispatchWebhooks'],
  'pr:closed': ['Notify', 'DispatchWebhooks'],
  'review:requested': ['Notify', 'DispatchWebhooks'],
  'review:submitted': ['Notify', 'DispatchWebhooks'],
  'issue:opened': ['Notify', 'DispatchWebhooks'],
  'issue:closed': ['Notify', 'DispatchWebhooks'],
  'comment:created': ['Notify', 'DispatchWebhooks'],
  'release:published': ['Notify', 'DispatchWebhooks'],
} satisfies Events

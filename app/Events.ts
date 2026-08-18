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
  'pr:opened': ['Notify', 'DispatchWebhooks', 'RecordActivity', 'DispatchPullRequestRuns'],
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
  /*
   * `DispatchPullRequestRuns` joins both of these, and it is the reason
   * `on: pull_request` works at all: the trigger was stored on every version
   * and read by nothing, so a workflow that named it never ran - on a forge
   * built around review, which is the wrong trigger to be missing.
   */
  'pr:synchronized': ['DispatchWebhooks', 'DispatchPullRequestRuns'],
  'pr:ready_for_review': ['DispatchWebhooks', 'DispatchPullRequestRuns'],
  /*
   * A check reported. Webhooks only, on the same reasoning and more so.
   *
   * Every transition of every check fires this - a repository with six checks
   * and a busy morning would put a hundred entries in an inbox nobody would
   * read afterwards - and it is the event a deployment gate, a dashboard or a
   * merge queue exists to wait on. A feed of "ci/build is running" would bury
   * the things somebody scrolls to find.
   */
  'check:reported': ['DispatchWebhooks'],
  'status:reported': ['DispatchWebhooks'],
  /*
   * The run lifecycle, for the programs waiting on it.
   *
   * Same reasoning again, and the strongest case for it: a run lives for
   * minutes on a machine this instance does not own, and everything downstream
   * of CI either hears about it or polls for it.
   */
  'run:transitioned': ['DispatchWebhooks'],
  'job:transitioned': ['DispatchWebhooks'],
  /*
   * A rule about the tests started, or stopped, holding.
   *
   * Webhook-only for the same reason as the two above, with one addition: it
   * is already rate-limited by its own design, since only a *transition* is an
   * event. A monitor in alarm for a month sends one message.
   */
  'test:monitor': ['DispatchWebhooks'],
  /*
   * A test crossed from steady to flaky. Webhook-only again, and rate-limited
   * by being a transition: the test that has been flaky for a month is not
   * news, and a receiver told about it every run writes a filter that hides
   * the one that broke today.
   */
  'test:flaky': ['DispatchWebhooks'],
  'test:recorded': ['DispatchWebhooks'],
  'pr:merged': ['Notify', 'DispatchWebhooks', 'RecordActivity', 'ExpirePreviews'],
  'pr:closed': ['Notify', 'DispatchWebhooks', 'RecordActivity', 'ExpirePreviews'],
  'review:requested': ['Notify', 'DispatchWebhooks'],
  'review:submitted': ['Notify', 'DispatchWebhooks', 'RecordActivity'],
  /*
   * `DispatchSubjectRuns` joins these four, which is what makes `on: issues`,
   * `on: issue_comment` and `on: release` real. The events themselves are years
   * old; nothing had ever read them for CI.
   */
  'issue:opened': ['Notify', 'DispatchWebhooks', 'RecordActivity', 'DispatchSubjectRuns'],
  'issue:closed': ['Notify', 'DispatchWebhooks', 'RecordActivity', 'DispatchSubjectRuns'],
  'comment:created': ['Notify', 'DispatchWebhooks', 'RecordActivity', 'DispatchSubjectRuns'],
  'release:published': ['Notify', 'DispatchWebhooks', 'RecordActivity', 'DispatchSubjectRuns'],

  /*
   * The security events, and none of the above.
   *
   * They are a separate family on purpose. A domain event is something a person
   * did to the *product* - opened, merged, commented - and its audiences are an
   * inbox, a webhook and a feed. These are things done to the *permissions and
   * credentials* of the instance, and their audience is somebody reconstructing
   * an incident. Nobody wants an inbox entry every time a key is added, and a
   * feed that listed role changes would report who trusts whom to anybody who
   * scrolls.
   *
   * `RecordAudit` declares its own `listensTo` from `app/Audit/events.ts`,
   * which is the list that matters and the one a test checks. These lines exist
   * because this file is where somebody looks to find out what is wired to
   * what, and a family of twenty events that appears nowhere in it reads as a
   * family that is not wired at all. Registration is deduplicated by (event,
   * listener), so saying it twice does not write the row twice.
   */
  'member:invited': ['RecordAudit'],
  'member:joined': ['RecordAudit'],
  'member:role-changed': ['RecordAudit'],
  'member:removed': ['RecordAudit'],
  'collaborator:changed': ['RecordAudit'],
  'collaborator:removed': ['RecordAudit'],
  'team:access-changed': ['RecordAudit'],
  'token:created': ['RecordAudit'],
  'token:first-used': ['RecordAudit'],
  'token:revoked': ['RecordAudit'],
  'key:added': ['RecordAudit'],
  'key:removed': ['RecordAudit'],
  'session:revoked': ['RecordAudit'],
  'sso:signed-in': ['RecordAudit'],
  'sso:provisioned': ['RecordAudit'],
  'sso:deprovisioned': ['RecordAudit'],
  'passkey:registered': ['RecordAudit'],
  'passkey:removed': ['RecordAudit'],
  'two-factor:enabled': ['RecordAudit'],
  'two-factor:disabled': ['RecordAudit'],
  'two-factor:recovery-codes-reissued': ['RecordAudit'],
  'branch:protection-changed': ['RecordAudit'],
  'branch:protection-removed': ['RecordAudit'],
  'push:protection-bypassed': ['RecordAudit'],
  // Dispatched by `ProcessPushJob` and, until now, listened to by nobody.
  // `SyncWorkflows` keeps the workflow definitions current from the default
  // branch - the trusted ref - and starts nothing.
  'push:received': ['SyncWorkflows'],
  'repository:visibility-changed': ['RecordAudit'],
  'repository:transferred': ['RecordAudit'],
  'repository:deleted': ['RecordAudit'],
  'organization:deleted': ['RecordAudit'],
  'instance:setting-changed': ['RecordAudit'],
  'admin:granted': ['RecordAudit'],
  'admin:revoked': ['RecordAudit'],
  'admin:job-retried': ['RecordAudit'],
  // The fleet: boundary changes that are invisible after the fact.
  'fleet:secret-written': ['RecordAudit'],
  'fleet:secret-removed': ['RecordAudit'],
  'fleet:pool-created': ['RecordAudit'],
  'workflow:fork-run-approved': ['RecordAudit'],
  'workflow:fork-run-refused': ['RecordAudit'],
  'workflow:run-dispatched': ['RecordAudit'],
  'workflow:run-cancelled': ['RecordAudit'],
  'workflow:job-cancelled': ['RecordAudit'],
  'workflow:run-rerun': ['RecordAudit'],
  'workflow:gate-approved': ['RecordAudit'],
  'workflow:enabled': ['RecordAudit'],
  'workflow:disabled': ['RecordAudit'],
  'workflow:secret-written': ['RecordAudit'],
  'workflow:secret-removed': ['RecordAudit'],
  'workflow:variable-written': ['RecordAudit'],
  'workflow:variable-removed': ['RecordAudit'],
  'workflow:environment-configured': ['RecordAudit'],
  'workflow:environment-removed': ['RecordAudit'],
  'deployment:recorded': ['RecordAudit'],
  'deployment:updated': ['RecordAudit'],
  'fleet:signatures-required': ['RecordAudit'],
  'fleet:plugin-attached': ['RecordAudit'],
  'fleet:plugin-detached': ['RecordAudit'],
  'fleet:plugin-policy-set': ['RecordAudit'],
  'fleet:queue-created': ['RecordAudit'],
  'fleet:queue-paused': ['RecordAudit'],
  'fleet:queue-resumed': ['RecordAudit'],
  'fleet:repository-assigned': ['RecordAudit'],
  'fleet:repository-unassigned': ['RecordAudit'],
  'fleet:runner-assigned': ['RecordAudit'],
  'fleet:runner-created': ['RecordAudit'],
  'fleet:runner-registered': ['RecordAudit'],
  'fleet:token-created': ['RecordAudit'],
  'fleet:token-revoked': ['RecordAudit'],
  'fleet:maintainer-added': ['RecordAudit'],
  'fleet:maintainer-removed': ['RecordAudit'],
  'fleet:runner-stopped': ['RecordAudit'],
  'audit:exported': ['RecordAudit'],
} satisfies Events

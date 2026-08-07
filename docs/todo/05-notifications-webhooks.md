# 05 - Notifications and webhooks

Telling people, and telling other systems. The bar for notifications is that a reviewer can rely on
them without also watching a chat channel, and that nobody has to mute the product to get work done.

## Prerequisites

- [x] Resolve the missing `notifications.user_id` and `notification_deliveries.user_id` foreign keys
      left over from bootstrap. Those tables come from the framework guarantee path rather than the
      model corpus, so the declared relations are not enforced.

  Fixed in the **models**, which is the whole point and was not my first attempt. I wrote a
  hand-written migration first; `tests/unit/migrations-from-models.test.ts` refused it, and it was
  right to. `migrate:regenerate` rebuilds the corpus from the models, so a hand-written file is a
  rule the models do not know about that the next regeneration silently deletes - which for a
  foreign key means the constraint quietly stops existing. That test's own comment says it was
  written after exactly this mistake, and names two other columns where a relation had been written
  as a plain attribute.

  `notification_deliveries` was a third. Its `userId` is declared in the framework default as a
  plain numeric attribute with no `belongsTo` at all, so nothing generated a constraint and nothing
  stopped a row pointing at a deleted account. `notifications` did declare `belongsTo: ['User']`,
  but the table is created by the framework's guarantee path rather than from the corpus, so the
  declaration reached no SQL. Both are overridden under `app/Models/`, which is the supported
  resolution order and puts them in the corpus; the generator then emits the constraints itself.

  `notification_deliveries.user_id` was also `integer` against a `bigint` `users.id`. Postgres
  compares the two happily, so a foreign key between them is accepted and the mismatch stays
  invisible until an id passes two billion.

  The two differ on delete on purpose: `notifications` cascades, because an inbox entry for an
  account that no longer exists is unreachable; `notification_deliveries` sets null, because it is a
  log of what was actually sent and it carries the recipient address independently of the account.
  Deleting a user should unlink that record, not erase the evidence that mail went out.

- [ ] Resolve the missing `jobs` table so the queue works. Everything here is queue-driven.

  The table exists now, and two of its columns described something other than what the queue stores.
  Both are fixed, through an `app/Models/Job.ts` override rather than a patch to
  `node_modules` - the framework default is at
  `storage/framework/defaults/app/Models/Job.ts` and `app/` wins, which is the supported mechanism
  and survives an install.

  **`reserved_at` was `schema.date()`.** The queue writes a unix timestamp and its reservation sweep
  asks `reserved_at <= $1` with an integer, so Postgres answered `operator does not exist: date <=
  integer` **on every tick**. Nothing was ever reserved, so nothing was ever processed, and the
  failure was one log line inside the worker's loop - a job dispatched to the database driver sat in
  the table forever while the worker cheerfully reported "Listening for jobs..." once a second. It is
  the same kind of value as `available_at`, which is correctly a number three lines above it.

  **`payload` had no `max`, so it generated `varchar(255)`.** A payload is JSON - job name,
  arguments, options - and the trivial two-field probe used to find the bug above was already eighty
  characters. Postgres refuses an over-length varchar rather than truncating, so this is a dispatch
  that throws for large payloads and works for small ones: it passes every test written with a short
  one.

  Still open, because **the database queue driver cannot reserve a job**, and the cause is a
  dependency defect this repository cannot fix from inside itself.

  `@stacksjs/queue` reserves with an optimistic lock, which is the right shape - claim the row only
  if it is still unclaimed, so two workers cannot take the same job:

  ```js
  db.updateTable('jobs')
    .set({ reserved_at: now, attempts: (row.attempts || 0) + 1 })
    .where('id', '=', row.id)
    .whereNull('reserved_at')
    .executeTakeFirst()
  ```

  **`whereNull` does not exist on the update builder.** It exists on the select builder, which is
  why it reads as correct and why `reviewLoad` in `app/Actions/Pull/suggest.ts` uses it happily.
  Checked directly: on a select, `whereNull` and `whereNotNull` are both functions; on an update,
  both are `undefined`. So every reserve throws `TypeError: ....whereNull is not a function`.

  It is invisible because the processor's loop swallows it whole:

  ```js
  try { z = await z5(K, $) } catch { continue }
  ```

  No logging, no failed job, no retry - the worker polls forever, reserves nothing, and reports
  "Listening for jobs..." once a second. `QUEUE_LOG_LEVEL=debug` adds nothing, because nothing is
  logged to raise the level of. A job dispatched to the database driver sits in the table until
  somebody looks.

  The fix is upstream, in one of two places: `bun-query-builder` gains `whereNull`/`whereNotNull` on
  the update builder, or `@stacksjs/queue` writes that predicate a way the builder supports. The
  second `catch` is worth fixing either way - a reserve that fails silently is how this stayed
  hidden through every "the jobs table exists" check.

  Two smaller things found on the way, neither of them the cause:

  - **`--queue` never reaches the worker.** `buddy queue:work` advertises `-q, --queue [queue]`, and
    the worker action parses its own argv with a splitter that only understands `--key=value`. A
    space-separated `--queue default` becomes the string `"true"`, so the worker polls a queue named
    `true`. The log line says so - "Processing queues: true" - and reads exactly like a boolean
    status message. Running the action directly with `--queue=default` prints the real name.
  - **`queue_circuit_state` does not exist.** The worker says so and disables the circuit breaker.
    Graceful, and not the cause. No framework migration creates it.

  `.env` stays on `QUEUE_DRIVER=sync`, deliberately. Every `dispatch()` in the product therefore runs
  inline, inside the request that triggered it, which makes retries, backoff, held notifications and
  digests meaningless and turns a slow SMTP server into a slow page. It is still the right setting
  until the reserve works, because `database` would mean jobs stop running at all rather than
  running in the wrong place.

## Events

- [ ] `app/Events.ts` mapping domain events to listeners: `push:received`, `pr:opened`,
      `pr:merged`, `pr:closed`, `review:requested`, `review:submitted`, `issue:opened`,
      `issue:closed`, `comment:created`, `release:published`
- [ ] Events are emitted from actions, once, at the point the state actually changed. Not from
      controllers, and not twice on retry.

## Notifications

- [x] `app/Models/NotificationSubscription.ts`: polymorphic subject, `user_id`, `reason`
      (author, assigned, review_requested, mentioned, watching, participating, team_mention),
      `unsubscribed`
- [x] Subscription is implicit: opening, commenting on, or being assigned to something subscribes
      you, and the reason is recorded so the notification can say why you got it
- [ ] `app/Notifications/ReviewRequested.ts`, `ReviewSubmitted.ts`, `PrMerged.ts`, `IssueOpened.ts`,
      `IssueCommented.ts`, `Mentioned.ts`, `NewRelease.ts`, `Welcome.ts`
- [ ] Email templates as `resources/emails/*.stx`
- [ ] In-app inbox: unread state, mark read, mark all read, filter by reason
- [ ] Per-user delivery preferences by event type and channel, with a real digest option rather than
      only all-or-nothing
- [x] Batching: ten comments in five minutes is one email, not ten
- [ ] `app/Jobs/SendNotificationJob.ts` on the `notifications` queue, with retries and backoff
- [ ] Unsubscribe links that work without logging in, and are scoped to one thread
- [x] Do not notify someone about their own action
- [ ] `resources/views/notifications.stx`, `settings/notifications.stx`

## Quiet hours and muting

The stated bar for this phase is that nobody has to mute the product to get work done. The way a
forge fails that bar is not by sending the wrong notifications, it is by sending the right ones at
eleven at night on a Saturday. A person who cannot control when a tool reaches them turns it off
entirely, and then the reviewer everybody is waiting on is unreachable by design.

Held is the important word below. A notification outside someone's hours is delayed, never dropped:
it arrives in the in-app inbox immediately, and the push and email leave when the window opens.

- [x] Every rule is evaluated in the recipient's timezone, so "after 18:00" means their 18:00 in
      whatever week of the year it is (`clock.ts`, tested across a daylight saving change and a
      zone where the local weekday differs from UTC's). Setting it from the browser at registration
      needs registration.
- [x] "Mute until tomorrow" is computed from the recipient's local midnight rather than from now,
      so choosing it at 23:50 does not expire in ten minutes somewhere else in the world
- [x] `PUT /api/user/notifications/schedule` and `POST /api/user/notifications/mutes`. The schedule
      response says in words what would happen to a review request right now, because a week grid
      that does not explain itself is how somebody silences the thing they were waiting for.
- [x] `app/Models/NotificationSchedule.ts`: `user_id`, `days` (which weekdays are active), `starts_at`,
      `ends_at`, `timezone`. Weekends are just days left out, not a separate flag, because a rotating
      shift and a Sunday-to-Thursday week are the same shape of problem. A window whose end is
      before its start wraps past midnight and belongs to the day it starts on, so a night shift is
      one row rather than two.
- [x] Outside the window, push and email are held rather than dropped, with the time the window next
      opens computed alongside the decision (`deliveryDecision`, `minutesUntilOpen`). In-app is
      never held.
- [ ] Held notifications are rolled into one digest when the window opens, rather than the backlog
      arriving one at a time. The decision and the delivery time exist; the digest does not.
- [x] A break-through list, per event type, for the things that genuinely cannot wait. Empty by
      default. It overrides the schedule but not an explicit mute, because muting is a decision
      about the subject and there is no hour at which somebody wants what they muted.
- [x] "Do not disturb until" as a one-click override, independent of the schedule and ending by
      itself
- [x] `app/Models/NotificationMute.ts`: polymorphic subject, `user_id`, `expires_at`. One model
      covers muting a repository, an organization, a pull request thread, or an issue, and a null
      expiry means indefinitely.
- [x] Muting leaves the subscription intact, so unmuting restores exactly what was there, and
      unmuting deletes the row rather than expiring it. Reaching it from anywhere the subject
      appears, rather than only from settings, needs those views.
- [x] A muted repository still writes to the in-app inbox, marked muted. This is what makes muting
      safe enough that people actually use it instead of leaving. Filtering the inbox by it needs
      the inbox.
- [x] Muted and held state is decided once, in one resolver
      (`app/Actions/Notification/delivery.ts`), alongside the recipient resolution in
      `recipients.ts`. Every channel asks the same question and gets the same answer.
- [x] Tests for the awkward clock cases: a window that wraps past midnight, the morning after a
      schedule's last day, a Friday evening waiting until Monday, and a schedule with one day in it
- [ ] `settings/notifications.stx` shows the schedule as a week grid, the active mutes with their
      expiry, and a plain sentence of what would happen to a review request right now
- [ ] Tests: an event at 03:00 is held and arrives once at the window's open, a muted repository
      still lands in the inbox, a mute expires on its own, break-through ignores the schedule, and a
      user whose clocks changed over the weekend still gets the right window

## Web push

The point is that a review request or a red build reaches the desk without the phone being part of
the loop. A browser notification arrives whether or not the tab is open, which is the whole reason
to prefer it to a badge nobody is looking at.

- [ ] `app/Models/PushSubscription.ts`: `user_id`, `endpoint`, `p256dh`, `auth`, `user_agent`,
      `last_seen_at`. One row per browser, so revoking one desk does not sign out the other.
- [ ] VAPID keys generated at install and kept in the environment, not committed. A self-hosted
      instance generates its own on first boot rather than shipping a shared key.
- [ ] A service worker that shows the notification and, on click, focuses an existing tab on that
      pull request instead of opening a fourth copy of it
- [ ] Permission is asked at the moment someone opts in from settings, never on page load. A
      browser that has been asked once and refused cannot be asked again, so spending that prompt on
      a first visit costs the feature permanently.
- [ ] Delivery through the same `SendNotificationJob` as every other channel, subject to the same
      quiet hours and mutes. A push that ignores the schedule is worse than no push.
- [ ] Prune dead subscriptions on `404` and `410` from the push service, rather than retrying an
      endpoint that will never accept again
- [ ] Collapse by subject: three pushes about one pull request replace each other rather than
      stacking, using the notification tag
- [ ] A test button in settings that sends one to this browser, because the failure mode is a
      permission or a key being wrong and there is no way to tell from the outside
- [ ] Tests: a subscription that returns 410 is pruned, a held notification does not push, and the
      payload carries no private repository content beyond what the recipient can already read

## Webhooks

- [x] `app/Models/Webhook.ts`: owner (repository or organization), `url`, `secret`, `events`,
      `content_type`, `active`, `insecure_ssl`
- [x] `app/Models/WebhookDelivery.ts`: `webhook_id`, `event`, `payload`, `request_headers`,
      `response_status`, `response_body`, `duration_ms`, `delivered_at`, `attempt`
- [ ] Payload shapes documented and stable. People build against these, so breaking one is a real
      cost.
- [x] HMAC SHA-256 signature header, computed over the exact bytes sent
- [ ] `app/Jobs/DeliverWebhookJob.ts` on the `webhooks` queue: timeout, retries with exponential
      backoff, and automatic deactivation after sustained failure
- [ ] Delivery log in the interface, with redelivery
- [ ] Ping event on creation so a user can verify the endpoint immediately
- [x] **SSRF protection.** A webhook URL is attacker-controlled and the request originates from the
      server: block loopback, link-local, and private ranges, resolve DNS before connecting and
      validate the resolved address, and re-validate on redirects. This is the highest-risk feature
      in this phase.
- [x] Tests: signature verification against a known vector, retry behavior, and the SSRF blocks

## Realtime

- [ ] Live updates on an open pull request: new comments, review submissions, status changes
- [ ] Presence: who else is looking at this pull request right now
- [ ] Degrade to polling where the connection is unavailable, rather than silently going stale

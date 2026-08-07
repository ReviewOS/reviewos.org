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

- [x] Resolve the missing `jobs` table so the queue works. Everything here is queue-driven.

  It works. A job dispatched to the `database` driver is reserved, run and removed, the circuit
  breaker tracks it, and `QUEUE_DRIVER` is `database` in `.env` and `.env.example`. Getting there
  took four fixes and three of them were upstream, because the table existing was never the problem.

  **`reserved_at` was `schema.date()`.** The queue writes a unix timestamp and its reservation sweep
  asks `reserved_at <= $1` with an integer, so Postgres answered
  `operator does not exist: date <= integer` on every tick.
  Fixed by overriding the framework's `Job` model under `app/Models/`, which
  is the supported resolution order rather than a patch to `node_modules`. `payload` was
  `varchar(255)` in the same model - a payload is JSON, and Postgres refuses an over-length varchar
  rather than truncating, so it worked for small payloads and threw for large ones.

  **`whereNull` did not exist on the update builder.** The reserve is an optimistic lock - claim the
  row only if nobody else has - and the method was present on selects and absent on writes, so every
  claim threw a `TypeError`. Fixed at source in `bun-query-builder`, released as `0.2.23`, with
  tests for both the update and delete builders.

  **The failure was swallowed.** The poll loop caught it bare and continued, so a transient database
  failure and a reserve that could never work looked identical, and the worker printed "Listening for
  jobs..." once a second forever. It reports now, rate-limited to once a minute per queue. Fixed at
  source, in Stacks `0.70.297`.

  **`--queue` never reached the worker.** `buddy queue:work` advertises `-q, --queue [queue]` and the
  worker parsed its own argv with a splitter that only understood `--key=value`, so `--queue default`
  became the string `"true"` and it polled a queue named `true`. The log line said so - "Processing
  queues: true" - and reads exactly like a boolean status message. Also `0.70.297`.

  Then the app still could not see any of it, because seven nested copies of
  `bun-query-builder@0.2.21` sat under the Stacks packages. The answer was not an `overrides` pin -
  that hides the problem and drifts out of date - but `stacks` itself, which the app declares and
  which had been held at `0.70.289`. Updating it collapsed every copy to one.

  `queue_circuit_state` is modelled here too. The framework reads it, prints "table missing - circuit
  breaker disabled. Run migrations to enable" when it is absent, and carries on - and nothing in the
  framework creates it, so "run migrations" had nothing to run and the protection was off in every
  application whose author never read the line. A queue whose downstream is refusing every connection
  now burns one attempt a minute rather than the whole backlog and all of its retries.

  Tests force `sync` in `tests/setup.ts`, whatever `.env` says. There is no worker under test, so a
  queued job is one that never runs, and a test asserting a push reached the application would be
  asserting the queue's scheduling instead - which is how switching the driver first showed up.

- [x] `app/Events.ts` mapping domain events to listeners: `pr:opened`, `pr:merged`, `pr:closed`,
      `review:requested`, `review:submitted`, `issue:opened`, `issue:closed`, `comment:created`,
      `release:published`.

  All nine map to one listener rather than nine, because the work is identical every time: find who
  is subscribed and why, drop the person who caused it, write a row. Nine listeners would be nine
  copies of that with the reason string changed, and the ninth is the one that forgets the rule.
  What differs is the sentence, and that lives in `app/Notifications/definitions.ts` where the nine
  can be read against each other.

  `push:received` is deliberately absent. Nobody is notified about a push directly - they are
  notified about what it did, which is a pull request opening or a check reporting.

- [x] Events are emitted from actions, once, at the point the state actually changed.

  All nine, each *after* the write and never before: by the time `pr:merged` fires a branch has
  moved and a row says merged, and an event sent first and then rolled back is a notification about
  something that did not happen, which cannot be taken back.

  Three carry a judgement about when *not* to fire, and each one is the difference between a product
  people keep notifications on for and one they mute:

  - **A reopen is not a close.** Only closing announces; reopening is usually the same person
    correcting themselves a moment later.
  - **A draft release is not published.** Announcing one would tell every watcher about a release
    that is deliberately unannounced, which is the whole thing a draft is keeping.
  - **A mention is addressed, not broadcast.** Naming somebody in a comment reaches them whether or
    not they were following the thread, which is why people write an `@`.

  Whether the actor is subscribed by their own action is decided per event too. Opening or
  commenting signs you up; closing somebody else's issue or merging their pull request does not,
  because acting *on* a thread is not joining it.

## Notifications

- [x] `app/Models/NotificationSubscription.ts`: polymorphic subject, `user_id`, `reason`
      (author, assigned, review_requested, mentioned, watching, participating, team_mention),
      `unsubscribed`
- [x] Subscription is implicit: opening, commenting on, or being assigned to something subscribes
      you, and the reason is recorded so the notification can say why you got it
- [ ] `app/Notifications/ReviewRequested.ts`, `ReviewSubmitted.ts`, `PrMerged.ts`, `IssueOpened.ts`,
      `IssueCommented.ts`, `Mentioned.ts`, `NewRelease.ts`, `Welcome.ts`
- [ ] Email templates as `resources/emails/*.stx`
- [x] In-app inbox: unread state, mark read, mark all read, filter by reason

  `resources/views/notifications.stx`, rendered entirely on the server with no client script, for
  the reason the review queue is: an inbox is a list of links, and a page that reads its own state
  on every load can never show a count that disagrees with itself.

  Three decisions the box does not contain:

  - **Repeats collapse by destination.** Six comments on one pull request are six rows and one trip,
    so they render as one line and a count. The newest supplies the sentence, because that describes
    the state the reader is about to find: "approved" over "review requested" matters, because the
    older line would send somebody to do work already done. A group counts as unread if anything in
    it is, or hiding one unread row behind five read ones would lose exactly the notification worth
    keeping.
  - **Mark all read is scoped to the filter on screen.** It cannot be undone, and clearing four
    hundred rows meaning to clear six is the single most destructive thing an inbox can do by
    accident. The button says what it will do rather than leaving the reader to infer it from which
    chips are lit.
  - **Read is dimmed, not hidden.** Finding the thing you read an hour ago is the second most common
    visit an inbox gets, and a list that drops rows on read makes that trip impossible.

  Two defects fell out of building it. `notifications.data` was `varchar(255)` in the framework's
  model, which a real notification exceeds between a title, a URL and a repository name - and
  Postgres refuses an over-length varchar rather than truncating, so the row was lost at insert on
  the one channel that has to work when the others do not. And `where(column, 'in', values)` bound
  the whole array to a single placeholder on updates and deletes, so marking a filtered set read was
  not expressible; fixed in bun-query-builder 0.2.24 along with `deleteFrom` interpolating an
  unchecked operator into its statement text.
- [x] Per-user delivery preferences by event type and channel, with a real digest option rather than
      only all-or-nothing

  `app/Actions/Notification/preferences.ts` holds the rules and
  `app/Models/NotificationEventPreference.ts` the rows. Three states, not a checkbox: `off`,
  `immediate`, `digest`. Collapsing digest into "on" is how somebody who wanted less mail ends up
  turning the channel off entirely, and then being unreachable for the review everybody is waiting
  on - which is the exact failure this phase exists to prevent.

  **The defaults matter more than the switches**, because most people never open a settings page.
  They are asymmetric on purpose: email is immediate for what is *addressed* to you (a review
  request, a verdict on your own work) and a digest for what you merely watch. Otherwise following a
  busy repository is indistinguishable from subscribing to a mailing list. The inbox is always
  immediate and cannot be turned off - it is the record. Push is off until somebody asks, which is
  what makes it worth having.

  A stored value nobody recognises falls back to the shipped default rather than to `off`. Wrong and
  talking costs somebody a notification they did not want; wrong and silent costs them a review they
  never heard about.

  The table is `notification_event_preferences`, not `notification_preferences`. The framework
  guarantees the latter outside the model corpus, shaped `(user_id, channel, category, enabled)`,
  and a boolean cannot express digest. Worth knowing generally: a generated
  `CREATE TABLE IF NOT EXISTS` against a name the guarantee path already claimed does nothing at
  all, silently, and the first sign is a query for a column that is not there. Stacks 0.70.303 now
  warns when that happens, and `app/Models/NotificationPreference.ts` declares the framework's table
  so the generator stops proposing to drop it as an orphan.
- [x] Batching: ten comments in five minutes is one email, not ten
- [x] `app/Jobs/SendNotificationJob.ts` on the `notifications` queue, with retries and backoff

  Email and push only. The inbox is written inline by the listener, because it is one insert per
  recipient and it is the channel that has to work when nothing else does - a reader who opens the
  product should see what happened whether or not mail is configured, a worker is running, or the
  network is up.

  **The decision is made in the job, not by the caller.** Preferences, quiet hours, mutes and
  do-not-disturb all move between the moment something happens and the moment a worker picks the job
  up, and the answer that matters is the one true when the message would actually arrive. Deciding
  in advance is how mail goes out at 03:00 that was correct at 22:00.

  Every outcome is written to `notification_deliveries`, including the ones that did not send.
  "Held until 09:00" and "the recipient turned email off" are what somebody needs when they ask why
  they did not hear about something, and a log of successes cannot answer either. `skipped` was
  added to the framework's four statuses for this: a deliberate choice does not belong in the same
  column as a refused mail server.

  Retried only for what retrying can fix. A deleted recipient returns rather than throwing, so it is
  one quiet no-op instead of three. A refused connection throws, which is what `tries: 3` exists
  for. Push is not wired up and fails saying so rather than recording a send that did not happen.
- [ ] Unsubscribe links that work without logging in, and are scoped to one thread
- [x] Do not notify someone about their own action
- [x] `settings/notifications.stx`

  The preference grid and the quiet hours on one screen, because they are one decision from the
  reader's side: what reaches me, and when is it allowed to. Splitting them across two pages is how
  somebody turns off email meaning to set quiet hours.

  Every cell is answered, including the ones nobody has a row for, and the defaults are labelled as
  defaults. A settings screen that renders unset as "off" is how somebody turns something on that
  was already on and concludes the switches do nothing - and a stored value that merely equals
  today's default would freeze it, so choosing the default deletes the row rather than writing one.

  One cell at a time, so a page left open in another tab cannot overwrite a change with values it
  read five minutes ago. Events are shown in words rather than wire names: nobody scanning a
  settings page should have to translate `review:requested`.

  Tested by asking the pages, not the functions. stx renders a page with every variable undefined
  when a server script throws, so a blank grid and an empty inbox both look like "nothing has
  happened yet" - the assertions are on content only a script that ran could produce.

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

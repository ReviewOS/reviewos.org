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
- [x] One notification definition per event. **Built as a table rather than as eight classes**, and
      the difference is deliberate.

  This line originally asked for `ReviewRequested.ts`, `ReviewSubmitted.ts`, `PrMerged.ts` and five
  more. Writing them showed what they would actually contain: each one is a sentence, a URL, and a
  list of subscription reasons that may receive it. Everything else - who is subscribed, dropping
  the actor, honouring an unsubscribe, choosing a channel, holding for quiet hours - is identical
  across all nine and lives in one listener.

  Eight files of three fields each would put the nine sentences where they can never be read against
  each other, and the sentence *is* the product: "somebody reviewed your pull request" makes the
  reader open it to find out whether they are blocked, and "your pull request was updated" does not.
  They are in `app/Notifications/definitions.ts`, side by side, which is how you notice that one of
  them is vaguer than the rest.

  `Welcome.ts` is not among them and should not be: it is not a domain event, it has no subject and
  no subscribers, and the framework already ships `SendWelcomeEmail`.
- [x] Email templates as `resources/emails/*.stx`

  `notification.stx` and `digest.stx`, resolved ahead of the framework defaults by `template()`.
  Two, not nine: the nine differ by one sentence, and that sentence is already written by the time
  it reaches a template.

  **Both halves are always sent.** A text part is not a fallback nobody sees - it is what a screen
  reader, a terminal client and every spam filter reads, and an HTML-only notification scores worse
  and is unreadable in exactly the clients on-call people use.

  The body is close to empty on purpose. A notification is one sentence, one link, and the reason it
  reached you. Everything a forge is tempted to add - the diff, the thread, avatars - is a reason to
  stay in the mail client rather than open the review, and the review screen is the product.

  A template that fails to render costs a plainer email, never the notification: the text part is
  complete on its own, so `render` returns an empty string rather than throwing.
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
- [x] Unsubscribe links that work without logging in, and are scoped to one thread

  Somebody reading a notification at 23:00 on their phone should be one tap from making it stop.
  Requiring a sign-in first is how people give up and add a mail rule instead - and a mail rule is
  invisible to this product forever, so a reviewer everybody is waiting on becomes unreachable and
  nothing here knows why.

  **The link does not unsubscribe anybody.** Mail security scanners and link previewers fetch every
  URL in a message before a human sees it, so a link that acted on being opened would unsubscribe
  people who never read the email, and they would never learn why the notifications stopped. The GET
  renders a page with a button; the button posts to the same URL, which is also what RFC 8058's
  one-click flow posts to, so Gmail's native button and the footer link do the same thing.

  The scope is signed into the token rather than carried beside it. `@stacksjs/email` 0.70.304 takes
  an optional scope for exactly this - a scope in a query string is one anybody can edit, and
  editing it from "this pull request" to "everything" is a one-character attack on somebody else's
  settings. The subscription is marked unsubscribed rather than deleted, so a later comment cannot
  quietly resubscribe somebody who asked to stop; and a row is written even when none existed,
  because a mention reaches somebody who was never subscribed.

  **`skipCsrf` is required on that route, and is not a weakening.** Gmail's one-click post is
  cross-origin with no cookie and no way to carry a token, so the default check refuses it - which
  would break the button most people press, in production, with nothing failing anywhere a developer
  looks. CSRF protection exists to stop a third party spending a victim's *ambient* credential, and
  this route has none: the signed token is the whole authorization, and anybody holding it can
  already unsubscribe by opening the link.
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
- [x] Held notifications are rolled into one digest when the window opens, rather than the backlog
      arriving one at a time.

  `app/Jobs/SendDigestJob.ts`, on the scheduler every five minutes. A sweep rather than a timer
  armed per notification: a timer has to survive a restart, and a sweep reads what is actually
  pending, so a process that dies mid-digest loses nothing - the rows are still marked pending and
  the next run picks them up.

  One message per thread. Ten comments on one pull request are one email, grouped by where the
  reader is being sent, which is the same rule the inbox collapses by. A gap longer than the window
  closes a batch, so a conversation running all afternoon does not arrive as one enormous message at
  the end of the day.

  **A failed send leaves the rows pending.** That is the whole promise: held, never dropped. Marking
  them sent would lose every notification in the batch, and the failure is not hypothetical -
  `mail.send` *resolves* with `{ success: false }` on a refused connection rather than throwing, so
  awaiting it and assuming success is how a delivery log fills with rows claiming somebody was
  reached while the mail server was down. Both jobs check the result now.

  The digest cannot break through quiet hours. It is not one of the nine events, so it has no
  break-through entry to match, and a digest that ignored the window would defeat the setting it
  exists to serve.
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
- [x] `settings/notifications.stx` shows the schedule as a week grid, the active mutes with their
      expiry, and a plain sentence of what would happen to a review request right now

  The sentence is the most useful thing on the page, and it is answered by calling `deliveryFor` -
  the same function delivery uses - rather than by re-deriving it from the switches. Four rules
  interact here and nobody holds them in their head at once; the failure people report is always the
  same shape, "I did not get told", and a page that cannot answer it sends them to support.

  Every mute shows when it ends, and expired ones are not listed. A mute with no visible expiry is
  one people forget they set, and then the product is quiet for a reason they cannot find - which
  reads as notifications being broken rather than as a switch they threw in March. Listing an
  expired one would have somebody unmuting something that is already sending.
- [x] Tests: an event at 03:00 is held and arrives once at the window's open, a muted repository
      still lands in the inbox, a mute expires on its own, break-through ignores the schedule, and a
      user whose clocks changed over the weekend still gets the right window

  `tests/e2e/quiet-hours.test.ts`, against real rows. The rules are unit tested as pure functions;
  what that cannot cover is that `deliveryFor` reads a schedule, a mute and a do-not-disturb and
  combines them, and every one of the four can be right on its own while the combination is wrong.

  The load-bearing assertion is that **a muted thing still lands in the inbox**. If muting lost the
  record nobody would use it, and they would turn notifications off instead - after which the
  reviewer everybody is waiting on is unreachable by design, which is the exact failure this phase
  exists to prevent. A mute also outranks break-through, because it is a decision about the subject
  and there is no hour at which somebody wants what they muted; and the widest mute wins, so a
  thread inside a muted repository is muted without having been named.

  The timezone case is covered by `clock.ts`'s own tests, which is where a clock change belongs -
  the schedule is stored as a local weekday and minute, so the conversion is the only thing a
  daylight change can get wrong.

## Web push

The point is that a review request or a red build reaches the desk without the phone being part of
the loop. A browser notification arrives whether or not the tab is open, which is the whole reason
to prefer it to a badge nobody is looking at.

- [x] `app/Models/PushSubscription.ts`: one row per browser, so revoking one desk does not sign
      out the other.

  The columns are `public_key` and `auth_secret`, not `p256dh` and `auth`. Those are the Push API's
  wire names - one names a curve rather than a thing, and the other would read in this codebase as
  authentication when it is an input to a key derivation. The mapping happens where the browser's
  JSON is read, which is the one place that vocabulary belongs.

  `endpoint` is `text` and unique across the table rather than per user. Unique per user would let
  one browser keep ringing an account it had moved away from; unique overall means an endpoint names
  exactly one browser, which is what it is.
- [x] VAPID keys generated at install and kept in the environment, not committed.

  `buddy push:keys` mints a pair and prints it. Printing rather than writing, because a command that
  edits its own `.env` fails on a read-only deployment and succeeds confusingly on a shared one.
  Running it twice is not idempotent and it says so before the keys rather than after: a browser
  subscribes *to* a public key, so replacing the pair invalidates every subscription on the instance.

  An instance with no keys is not broken. It sends email and fills the inbox exactly as before, and
  says "push is not configured" rather than logging a delivery it never attempted.
- [x] A service worker that shows the notification and, on click, focuses an existing tab.

  `public/push-worker.js`, served from the root because a worker's scope is its own directory - one
  at `/js/` would control `/js/*`, receive nothing, and report a successful registration.

  It matches on the path and calls `focus`, so four notifications about one pull request end in one
  tab rather than four copies with different scroll positions. `includeUncontrolled` matters:
  tabs opened before this worker took control are not controlled by it, which is most of them right
  after a deploy, and without it the first click after every deploy opens a duplicate.

  It does two things and refuses a third. Caching or offline here would make this file responsible
  for what the product serves, and a caching bug in a service worker survives a deploy.
- [x] Permission is asked at the moment someone opts in from settings, never on page load.

  `pushState()` reads `Notification.permission`, which prompts for nothing and is safe on load.
  `enablePush()` calls `requestPermission`, and it is reachable only from a button that says what it
  is for. A browser asked once and refused resolves `denied` immediately, forever, and the only undo
  is in browser site settings almost nobody finds - so that one prompt is spent deliberately or it
  is lost.
- [x] Delivery through the same `SendNotificationJob` as every other channel, subject to the same
      quiet hours and mutes.

  No separate path, so a push cannot arrive at 03:00 because somebody forgot to check the schedule
  on one branch. The job gained a third answer for it: `permanent`, meaning this will never work -
  no keys, no browser subscribed, no address on file. Without that distinction "this instance has no
  VAPID keys" costs three queue attempts and three log lines to reach the answer it had at the
  start, and lands in the log as `failed` beside a refused mail server rather than as `skipped`.
- [x] Prune dead subscriptions on `404` and `410`, and on nothing else.

  Those two mean the browser is gone: uninstalled, permission revoked, profile wiped. Keeping the
  row spends a request on it on every future notification, forever, and fills the delivery log with
  failures nobody can act on. Every other answer is transient - a 429 is "slow down" and a 5xx is
  theirs - and pruning on one would sign somebody out of push because a push service had a bad
  afternoon. A network error is not pruned either: the endpoint may be perfectly good and the
  network may not be.
- [x] Collapse by subject, in both places it can happen.

  The push service's `Topic` header collapses while the browser is offline; the notification tag
  collapses once it is awake. Using only one leaves the other case stacking, so both carry the
  thread. `renotify` is deliberately false - it would re-alert on every replacement, turning
  collapsing from a courtesy into being buzzed once per comment.

  The topic is base64url and capped at 32 characters, which every push service enforces by rejecting
  the whole request. An unencoded tag does not degrade to "no collapsing"; it stops the notification.
- [x] A test button in settings that sends one to this browser.

  Every way web push breaks - a downgraded permission, a key that does not match what the browser
  subscribed against, a worker that never activated, a subscription the service expired - produces
  exactly the same symptom: nothing arrives. None of them is distinguishable from "nothing has
  happened yet".

  It goes through `pushToUser`, the same function real notifications use, so what is tested is what
  runs. Quiet hours are deliberately skipped for it alone: somebody pressing a test button is asking
  for a notification now, and holding it until 09:00 looks exactly like the failure they are trying
  to diagnose.
- [x] Tests: a subscription that returns 410 is pruned, a held notification does not push, and the
      payload carries no private repository content.

  Against a real push service - a local server that answers whatever status the test asks for - so
  the pruning rule is exercised on 404, 410, 429 and 500 rather than asserted about.

  The payload test reads the source and asserts on the field list, which is unusual and deliberate:
  the risk is not that today's payload leaks, it is that somebody later adds the comment body
  because it would be useful. A notification lands on a device that may be locked on a desk or
  mirrored to a watch, and the preview is shown before anybody authenticates.

  The protocol itself is tested in `@stacksjs/push` against RFC 8291's own vector, and decrypted
  back the way a browser does it - a round trip against itself passes with the HKDF info strings
  swapped.

## Webhooks

- [x] `app/Models/Webhook.ts`: owner (repository or organization), `url`, `secret`, `events`,
      `content_type`, `active`, `insecure_ssl`
- [x] `app/Models/WebhookDelivery.ts`: `webhook_id`, `event`, `payload`, `request_headers`,
      `response_status`, `response_body`, `duration_ms`, `delivered_at`, `attempt`
- [x] Payload shapes documented and stable. People build against these, so breaking one is a real
      cost.

  `app/Webhooks/payloads.ts`, with a contract test that asserts on field *names* rather than
  behaviour. Reading as pedantic is the point: renaming a field should fail there loudly, because
  the alternative is finding out from somebody whose CI broke.

  Every payload shares one envelope - `event`, `delivered_at`, `repository`, `sender`, `subject`,
  `action` - so a receiver is written once rather than growing a switch it will get wrong. `subject`
  is the same shape for all nine, so somebody who only cares that "something happened to pull
  request 42" does not need nine field names to find the 42. `sender` is present-and-null rather
  than absent when nothing caused the event, because null is checkable and missing is a surprise.

  **Nothing on the wire is a database row.** The fields are chosen for the receiver and transcribed,
  so a column rename here is not a breaking change to somebody else's CI. That is the whole reason
  the file exists rather than `JSON.stringify(row)`.

  URLs are paths, not absolute. The host is the receiver's to know, and a stored absolute URL is
  wrong the day the forge moves behind a different name.

  An empty event list means *nothing*, not everything. A webhook created with no events selected
  should be silent rather than a firehose, and that is the default it is dangerous to get backwards.
- [x] HMAC SHA-256 signature header, computed over the exact bytes sent
- [x] `app/Jobs/DeliverWebhookJob.ts` on the `webhooks` queue: timeout, retries with exponential
      backoff, and automatic deactivation after sustained failure

  One attempt per job, re-queued with `retryDelayMs`. Retrying inside the handler would hold a
  worker for the whole backoff - an hour at the ceiling - and lose the schedule entirely on a
  restart. Re-queueing makes the delay the queue's problem, which is what a queue is for.

  **The SSRF policy is applied three times, not once**: the configured URL, the address it resolves
  to, and every redirect. Checking only the URL is the version that gets exploited, because DNS is
  under the configurer's control and a receiver answering `302 -> http://169.254.169.254/` is one
  line to write. Redirects are followed by hand rather than by `fetch` for the same reason: a
  followed redirect is a second request to an address nobody checked.

  Whether a *delivery* gives up and whether the *webhook* is switched off are separate questions
  with separate rules. One delivery running out of attempts is normal; a webhook that has not
  succeeded in days is an endpoint nobody owns any more, and continuing to call it is a slow
  outbound attack on somebody's server.

  `WEBHOOK_ALLOWED_HOSTS` is new, empty by default, and read from the environment rather than from a
  webhook row - the premise of `ssrf.ts` is that a webhook URL is not trusted, so a per-webhook
  override would be the same as no policy. A CI runner on the same LAN is the ordinary reason a
  self-hosted operator needs it, and a policy with no way to express that is one people work around
  by turning the whole check off. The port is part of the match, so naming one service does not open
  every port on that machine.

  The signature is redacted in the delivery log. It is reproducible from the payload and the secret,
  so storing it buys nothing and a log full of valid signatures is a log worth stealing.
- [x] Delivery log in the interface, with redelivery

  `{owner}/{repository}/webhooks`. The log *is* the page: a webhook that works needs no interface at
  all, and the only reason anybody opens this is that something did not arrive.

  Every row says whose fault it is in words - "your endpoint refused it", "could not be reached" -
  rather than a status code. The distinction that matters when debugging is not 200 versus 500, it
  is whether the request arrived at all, whether their handler refused it, or whether their server
  broke. A page of raw codes makes every reader triage that themselves and most of them do it wrong.

  Attempts are folded. A delivery that retried six times is one thing that happened, and six rows
  makes a log of ten look like sixty; the count is kept, because "delivered on the fourth attempt"
  is what tells somebody their endpoint is flaky rather than broken.

  **Redelivery replays the stored payload byte for byte** rather than rebuilding it. Rebuilding
  would send today's state under yesterday's event name - a different message wearing the same
  label - and somebody redelivering is doing it precisely to reprocess what they missed. The
  signature is recomputed, because it is a function of those bytes and the *current* secret, and a
  secret rotated since is the one the receiver checks against now. The delivery id is fresh:
  receivers deduplicate on it, so reusing the original would have the redelivery discarded by
  exactly the receivers who implemented deduplication correctly.

  A reader without `repository:settings` gets 404, not 403. A 403 would confirm to a stranger that
  this repository has webhooks configured, which is the one thing the page exists to protect - and
  the secret is never rendered, because a settings page that redisplays it turns every shoulder and
  every screenshot into a leak.
- [x] Ping event on creation so a user can verify the endpoint immediately

  Through the real delivery path - the same signature, the same headers, the same SSRF checks -
  because a special verification path only ever proves the special path works. It is the same
  envelope with no subject, so a receiver that handles the envelope handles the ping for free, and
  it carries a line of text because a ping with an empty body is one people mistake for a failure.

  `ManageWebhookAction` had to exist for this box to be honest: until it did, a webhook could only
  be created by writing to the table by hand. The URL is checked by `ssrf.ts` before it is stored
  *and* again before every delivery - the first refuses a URL the interface would otherwise display
  as working, and the second is what DNS cannot dodge. Neither is redundant.

  Re-enabling a webhook resets its failure counter, or it would switch off again on the first
  hiccup after somebody fixed their endpoint. An update with no secret keeps the old one: blanking
  it would silently turn signature checking off at the receiver, which is the one failure nobody
  would go looking for.
- [x] **SSRF protection.** A webhook URL is attacker-controlled and the request originates from the
      server: block loopback, link-local, and private ranges, resolve DNS before connecting and
      validate the resolved address, and re-validate on redirects. This is the highest-risk feature
      in this phase.
- [x] Tests: signature verification against a known vector, retry behavior, and the SSRF blocks

## Realtime

- [x] Live updates on an open pull request: new comments, review submissions, status changes

  **It reports counts, never content.** Splicing new comments into a page the reader has scrolled,
  folded, or started a draft in means reconciling against their unsaved work, and getting that wrong
  loses somebody's half-written review - which is unforgivable in a review tool. A banner costs a
  reload the reader chooses and never takes anything from them.

  Two messages, not one. A new comment leaves what is on screen correct and adds to it: "reload when
  you like". A new head commit does not - every line number may have moved and a draft anchored to
  one is now on the wrong line - so it says the stronger thing and looks different. A count that
  went *down* is not news and reports nothing.

  The banner sits above the header, because it is the one thing on the page that can make everything
  below it wrong, and a banner under a diff is one nobody scrolls back up to find. Its live region
  is `polite`: a screen reader user mid-sentence in a diff should hear the count when they pause,
  not be interrupted by it.
- [x] Presence: who else is looking at this pull request right now

  In the cache, not a table. It is true for sixty seconds and worthless after, and a row per reader
  per pull request would be a write on every heartbeat from every open tab - the one query pattern
  guaranteed to be the busiest in the product. A cache that is down costs the presence line and
  nothing else; the freshness check beside it is the half that matters.

  The reader is dropped from their own roster, or an empty room reads as one person. It is capped
  and counted, because presence is a glance - "somebody else is in here" is the whole signal and
  thirty faces is a widget rather than an answer. The sixty second window is generous on purpose: a
  laptop that slept for thirty seconds must not flicker out and back in, and the flicker is worse
  than the staleness because it makes the signal look unreliable.

  Answering it needs `repository:read`. "Who is looking at this" is information about people, and
  answering it to anybody who can guess a number is a way to watch a team work.
- [x] Degrade to polling where the connection is unavailable, rather than silently going stale

  **Polling is the baseline and the socket is an upgrade**, which is the opposite of the usual
  arrangement and the point. Make the socket primary and polling the fallback, and the fallback is
  the path nobody exercises - so it is broken on the day the socket is not there, which is exactly
  the day it matters. Here the poll always runs and a socket only makes it faster.

  Both ask the same endpoint for the same shape, so there is no second implementation to drift. A
  socket message is a nudge rather than the state: reading from the endpoint keeps one source of
  truth, and a socket that sends something malformed cannot put the page into a state the server
  never described.

  A socket does not stop the poll, it slows it - the poll is what keeps presence alive and what
  catches whatever the socket missed while the laptop was asleep, because a socket that reconnects
  has no idea what it lost. A dropped socket goes straight back to the fast poll, since the window
  between a drop and the next slow poll is exactly where "silently going stale" lives. There is no
  reconnect loop: against a server that does not speak WebSocket that is a page hammering it
  forever, and the poll has already lost the reader nothing but latency.

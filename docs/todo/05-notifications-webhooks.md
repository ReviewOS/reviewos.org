# 05 - Notifications and webhooks

Telling people, and telling other systems. The bar for notifications is that a reviewer can rely on
them without also watching a chat channel, and that nobody has to mute the product to get work done.

## Prerequisites

- [ ] Resolve the missing `notifications.user_id` and `notification_deliveries.user_id` foreign keys
      left over from bootstrap. Those tables come from the framework guarantee path rather than the
      model corpus, so the declared relations are not enforced.
- [ ] Resolve the missing `jobs` table so the queue works. Everything here is queue-driven.

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

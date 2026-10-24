# Emails, SMS and notification delivery

This is the delivery inventory for ReviewOS. A template on disk or a provider in
Stacks does not by itself cause a message to leave the instance. The tables below
describe the callers that exist, their defaults, and the cases that send nothing.
Examples use placeholder addresses and tokens. They are documentation previews,
never live deliveries.

## What can send

| Message | Trigger and recipient | Delivery |
|---|---|---|
| Review requested | A reviewer is addressed by `review:requested` | Inbox immediately; email defaults to immediate |
| Review submitted | An eligible subscriber receives `review:submitted` | Inbox immediately; email defaults to immediate |
| Pull request opened, merged or closed | An eligible subscriber receives `pr:opened`, `pr:merged` or `pr:closed` | Inbox immediately; email defaults to digest |
| Issue opened or closed | An eligible subscriber receives `issue:opened` or `issue:closed` | Inbox immediately; email defaults to digest |
| Comment added | An eligible conversation subscriber receives `comment:created` | Inbox immediately; email defaults to digest |
| Release published | An eligible subscriber receives `release:published` | Inbox immediately; email defaults to digest |
| Password reset | An existing account requests a link from `/forgot-password` | Framework mail transport, outside notification preferences |
| Email verification | A signed-in, unverified account asks to resend the link | Framework mail transport, outside notification preferences |

For domain events, the actor does not receive a notification about their own action. Subscription
reasons include author, assigned, mentioned, participating, review requested,
watching and team mention. Repository watchers do not receive every comment;
`comment:created` selects conversation participants. Direct review requests can
reach the addressed reviewer without an earlier subscription. A mention is a
recipient reason, not a separate event with its own immediate-email default.

Browser push defaults to **off** for all nine domain events. Immediate push
requires VAPID configuration, a browser subscription and an enabled preference.
The inbox remains immediate regardless of the stored channel setting.

Sources: `app/Notifications/definitions.ts`, `app/Notifications/recipients.ts`,
`app/Listeners/Notify.ts`, `app/Actions/Notification/preferences.ts`,
`app/Actions/Auth/PasswordResetAction.ts` and `app/Actions/Auth/VerifyEmailAction.ts`.

## Immediate notification email

The event sentence is both the inbox title and email subject. This example uses
the `review:requested` sentence and the `notification.stx` layout. Sender identity
comes from `MAIL_FROM_NAME` and `MAIL_FROM_ADDRESS`; the instance name in the footer
comes from instance settings. The HTML may fall back to a complete text part if
the template cannot render.

```email
from: {senderName} <{senderAddress}>
to: {reviewerEmail}
subject: chris asked you to review reviewos/engine#12
---
chris asked you to review reviewos/engine#12

reviewos/engine

[Open it](https://forge.example.com/reviewos/engine/pull/12/files)

---

You are getting this because your review was requested.

[Stop emails about this one](https://forge.example.com/unsubscribe/{token})

{instanceName}
```

When there is a subject, immediate email includes a signed unsubscribe link and
`List-Unsubscribe` / `List-Unsubscribe-Post` headers. Unsubscribing mutes that
thread, not the entire repository. Opening the link alone does not unsubscribe;
the confirmation or one-click POST does. Do not put a real unsubscribe token in
documentation.

Source: `app/Jobs/SendNotificationJob.ts`, `resources/emails/notification.stx` and
`routes/notifications.ts`.

## Digest email and quiet hours

Choosing digest, being outside the delivery window, or enabling do not disturb
creates a `pending` delivery instead of sending immediately. Muting drops the
interrupting channel; the inbox still records the event. Breakthrough events can
bypass the time window and do not disturb, but cannot bypass a mute.

`SendDigestJob` is scheduled every five minutes. It groups pending email by
recipient and thread, with a default 30-minute batching window. This is a grouping
window, not a promise that every digest waits exactly 30 minutes. The recipient's
current schedule and mutes are checked again before sending.

```email
from: {senderName} <{senderAddress}>
to: {recipientEmail}
subject: chris commented on reviewos/engine#12 (and 1 more)
---
chris commented on reviewos/engine#12 (and 1 more)

- chris commented on reviewos/engine#12
- ada commented on reviewos/engine#12

[Open the thread](https://forge.example.com/reviewos/engine/pull/12/files)

---

These were held until your notification window opened.

{instanceName}
```

The current digest sender does not supply an unsubscribe URL or
`List-Unsubscribe` headers, even though the template has an optional unsubscribe
section. Held push deliveries are also not drained by the digest job: it selects
email only. Use immediate or off for push until that path is implemented.

Failed digest sends stay pending for another sweep. Previously attempted failures
older than three days can be marked failed; being on holiday for three days alone
does not exhaust that retry policy. Immediate notification jobs have three
attempts with a 60-second backoff setting. A worker and the scheduler both have to
be running for queued delivery and digest sweeps to make progress.

Sources: `app/Jobs/SendDigestJob.ts`, `app/Actions/Notification/delivery.ts`,
`app/Actions/Notification/settings.ts` and `app/Scheduler.ts`.

## Account email

Password reset links expire after 60 minutes by default, configurable through
`AUTH_PASSWORD_RESET_EXPIRE`. Requests are throttled by
`AUTH_PASSWORD_RESET_THROTTLE`, default 60 seconds. The public response deliberately
does not distinguish an unknown address from a mail failure. A success response
from that endpoint is not delivery evidence.

This is the framework's plain-text fallback when the reset template is unavailable:

```email
from: {senderName} <{senderAddress}>
to: {accountEmail}
subject: Reset Your ReviewOS Password
---
Reset your password by visiting: https://forge.example.com/forgot-password?token={token}&email={email}

This link expires in 60 minutes. If you didn't request this, you can safely ignore this email.
```

Email verification is sent on an explicit resend request; the ReviewOS registration
action does not call `sendVerificationEmail`. The verification link points to
`/api/auth/verify?id={id}&token={token}`. The framework's fallback is:

```email
from: {senderName} <{senderAddress}>
to: {accountEmail}
subject: Verify Your ReviewOS Email Address
---
Please verify your email address by visiting: https://forge.example.com/api/auth/verify?id={id}&token={token}

This link expires in {expiryMinutes} minutes.
```

Sources: `config/auth.ts`, `app/Actions/Auth/RegisterAction.ts`,
`app/Actions/Auth/VerifyEmailAction.ts` and the Stacks auth package's
`password/reset.ts` and `email-verification.ts`. Shared framework templates can
change the HTML and wording without adding a new ReviewOS trigger.

## What currently sends nothing

| Capability or file | Current behavior |
|---|---|
| New-device sign-in notice | `noticeSignIn` writes `auth:new-device` to the inbox only; no email or SMS is queued |
| Workflow notification rules | `deliverRunNotifications` writes `workflow_run` inbox rows only; it does not dispatch `SendNotificationJob` |
| Welcome email | Scaffold action and job exist, and `user:registered` names the action, but ReviewOS registration does not dispatch that event |
| Subscription confirmation | `app/Mail/SubscriptionConfirmation.ts` and its template exist, but no ReviewOS route or action calls the function |
| SMS, including verification codes | No ReviewOS action, listener or job calls the SMS package; `config/sms.ts` is disabled |
| Framework default email routes | `.env.example` selects `STACKS_DEFAULT_ROUTES=none`; default routes are not mounted unless the operator opts in |

Two-factor authentication here uses authenticator codes, recovery codes and
passkeys. Configuring Twilio or Vonage does not turn those codes into SMS, add a
phone-number preference, or enable SMS notifications. A real SMS integration would
need its own trigger, recipient selection, consent, inbound opt-out handling,
delivery policy and provider evidence. There is deliberately no fictitious SMS
sample presented as a message this product sends.

Sources: `app/Actions/Auth/newDevice.ts`, `app/Actions/Workflow/notifyDelivery.ts`,
`app/Actions/Auth/RegisterAction.ts`, `app/Events.ts`, `app/Mail/SubscriptionConfirmation.ts`
and `config/sms.ts`.

## Checking delivery

1. For local preview, run `./buddy mail:dev`. The example SMTP settings use
   `127.0.0.1:1025` and the catcher UI is at `http://localhost:8025`. In that mode,
   mail is stored locally and does not leave the machine.
2. For external delivery, configure a real transport and sender. Follow
   [Self-hosting: email](./self-hosting.md#email). `config/email.ts` disables the
   managed mail server; that setting does not disable outbound SMTP.
3. Run `./buddy queue:work --concurrency 4` and the scheduler described in
   [Self-hosting](./self-hosting.md). A queued message is not a sent message.
4. Inspect `notification_deliveries`: `pending` means held, `skipped` means the
   channel was deliberately not sent, `failed` means an attempted delivery
   failed, and `sent` means the configured transport reported success. Auth
   email bypasses this notification log. Log and capture transports do not
   deliver to an external inbox; provider acceptance is not proof of receipt.

BunPress renders the `email` fences above as mail cards. It also supports `sms`
fences for actual SMS integrations, with phone bubbles and segment estimates.
These previews render documentation only and do not contact a mail or SMS provider.

import { Job } from '@stacksjs/queue'
import { batchNotifications } from '../Actions/Notification/recipients'
import { deliveryFor } from '../Actions/Notification/settings'

/**
 * Send what was held, as one message per thread.
 *
 * `SendNotificationJob` writes a `pending` row and stops whenever the answer is
 * "not now": the recipient asked for a digest, or their window is shut, or they
 * are on do-not-disturb. This is the half that eventually sends it. Without it,
 * `digest` and quiet hours would both be a polite way of dropping mail, which
 * is worse than either setting not existing - somebody who chose "digest" would
 * be silently unreachable and have no way to tell.
 *
 * **Held, never dropped.** That is the promise `delivery.ts` makes, and this is
 * where it is kept.
 *
 * Runs on a schedule rather than being armed per notification. A timer per
 * held message is a timer that has to survive a restart, and a sweep that reads
 * what is actually pending cannot lose one: a process that dies mid-digest
 * leaves rows still marked pending, and the next sweep picks them up.
 *
 * **One message per thread, not one per notification.** Ten comments on one
 * pull request are one email. The window is per person and per subject, because
 * collapsing across subjects loses the thing the reader needed to know. That
 * grouping is `batchNotifications`, tested as a pure function.
 */
export default new Job({
  name: 'SendDigest',
  description: 'Send held notifications, grouped by thread',
  queue: 'notifications',
  tries: 2,
  backoff: 120,

  async handle(payload: { windowMinutes?: number } = {}) {
    // The gap that closes a batch. Long enough that a burst is one message,
    // short enough that a conversation running all afternoon does not become
    // one enormous message at the end of the day.
    const windowMs = Math.max(1, Number(payload?.windowMinutes ?? 30)) * 60_000
    const now = Date.now()

    const pending = await db
      .selectFrom('notification_deliveries')
      .select(['id', 'user_id', 'channel', 'recipient', 'subject', 'body', 'created_at'])
      .where('status', '=', 'pending')
      // Email only. Push is not wired up, and a digest push would be an
      // interruption about a list, which is the opposite of what the channel is
      // for. Its rows stay pending rather than being marked sent by something
      // that did not send them.
      .where('channel', '=', 'email')
      .orderBy('created_at', 'asc')
      .limit(2000)
      .execute()

    if (pending.length === 0)
      return { ok: true, sent: 0, held: 0 }

    // Whose window is open right now, asked once per person rather than once
    // per row: a reader with forty held notifications is the ordinary case.
    const open = new Map<number, boolean>()

    for (const row of pending) {
      const userId = Number(row.user_id)
      if (open.has(userId))
        continue

      try {
        const outcome = await deliveryFor({
          userId,
          channel: 'email',
          // The digest itself is not one of the nine events, so it cannot break
          // through a schedule the way a named event can. A digest that ignored
          // quiet hours would defeat the setting it exists to serve.
          event: 'digest',
          subjects: [],
          nowMs: now,
        })

        open.set(userId, outcome.decision === 'send')
      }
      catch {
        // A recipient whose settings cannot be read is left held rather than
        // mailed. The next sweep tries again; the alternative is sending at an
        // hour they asked to be left alone because a query failed.
        open.set(userId, false)
      }
    }

    const ready = pending.filter(row => open.get(Number(row.user_id)))

    const batches = batchNotifications(
      ready.map(row => ({
        userId: Number(row.user_id),
        event: String(row.subject ?? ''),
        // The link is the thread. Grouping by it means two notifications that
        // send the reader to the same screen are one trip, which is the same
        // rule the inbox collapses by.
        subjectKey: String(row.body ?? ''),
        at: Date.parse(String(row.created_at ?? '')) || now,
      })),
      windowMs,
    )

    let sent = 0
    let failed = 0

    for (const batch of batches) {
      const rows = ready.filter(row =>
        Number(row.user_id) === batch.userId
        && String(row.body ?? '') === batch.subjectKey
        && withinBatch(row, batch, now))

      if (rows.length === 0)
        continue

      const address = String(rows[0]?.recipient ?? '')
      if (!address) {
        failed += 1
        continue
      }

      const ok = await deliver(address, batch.subjectKey, rows.map(row => String(row.subject ?? '')))

      if (!ok) {
        // Left pending on purpose. A failed digest that marked its rows sent
        // would lose every notification in it, and the whole point of holding
        // rather than dropping is that nothing is lost.
        failed += 1
        continue
      }

      await db
        .updateTable('notification_deliveries')
        .set({ status: 'sent', sent_at: new Date().toISOString() })
        .where('id', 'in', rows.map(row => Number(row.id)))
        .execute()

      sent += 1
    }

    return { ok: true, sent, failed, held: pending.length - ready.length }
  },
})

/**
 * The HTML half, or an empty string.
 *
 * Never throws. A template that will not render must not cost somebody the
 * digest: the text part is complete on its own, so a failure here means a
 * plainer email rather than a batch left pending forever.
 */
async function render(name: string, variables: Record<string, any>): Promise<string> {
  try {
    const { template } = await import('@stacksjs/email')
    const { html } = await template(name, { variables: variables as any })

    return String(html ?? '')
  }
  catch (error) {
    console.error(`[digest] could not render ${name}:`, error)

    return ''
  }
}

/** Whether a row falls inside the batch's own span. */
function withinBatch(row: any, batch: { from: number, to: number }, fallback: number): boolean {
  const at = Date.parse(String(row.created_at ?? '')) || fallback

  return at >= batch.from && at <= batch.to
}

/**
 * One digest, as plain text.
 *
 * The subject says how many and about what, because a subject line reading
 * "Notifications" is one nobody opens and one every filter treats the same.
 */
async function deliver(address: string, url: string, titles: readonly string[]): Promise<boolean> {
  const first = titles[0] ?? 'Notifications'
  const subject = titles.length > 1
    ? `${first} (and ${titles.length - 1} more)`
    : first

  try {
    const { mail } = await import('@stacksjs/email')

    // `mail.send` *resolves* with `{ success: false }` on a refused connection
    // rather than throwing. Awaiting it and assuming success is how a digest
    // marks its rows sent after sending nothing, which loses every notification
    // in the batch - the exact opposite of holding rather than dropping.
    // Both halves, always. The text part is what a screen reader, a terminal
    // client and every spam filter reads, and an HTML-only message scores worse
    // and is unreadable in exactly the clients on-call people use.
    // The instance's own name, for the reason `SendNotificationJob` gives: an
    // email signed with this product's name, to somebody who has only heard of
    // their employer's forge, reads as something they did not sign up for.
    const { setting } = await import('../Ops/settings')
    const html = await render('digest', { title: subject, url, lines: titles, appName: await setting('instance_name') })

    const result: any = await mail.send({
      to: address,
      subject,
      ...(html ? { html } : {}),
      text: `${titles.map(title => `- ${title}`).join('\n')}\n\n${url}\n`,
    })

    if (result?.success === false) {
      console.error('[digest] could not send:', result?.message)

      return false
    }

    return true
  }
  catch (error) {
    console.error('[digest] could not send:', error)

    return false
  }
}

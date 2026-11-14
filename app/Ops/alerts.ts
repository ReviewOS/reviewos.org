import { db } from '@stacksjs/database'
import { report } from './reporting'

/**
 * Telling the people who run this instance that something needs them.
 *
 * Everything else that notifies is about a thread somebody subscribed to. This
 * is for the things nobody subscribed to and somebody has to hear anyway: a
 * runner group whose machines die at boot is no repository's event, and the
 * only people who can fix it are the instance's administrators.
 *
 * Three places, in the order they can be relied on:
 *
 * 1. **The log**, always. It is where an operator already on the box looks,
 *    and it needs nothing to be working.
 * 2. **Every administrator's inbox**, with email and push queued behind it by
 *    their own preferences - the same inbox, deliveries and quiet hours as any
 *    other notification, so an alert is not a second system to configure.
 * 3. **The error collector**, when `ERROR_REPORTING_URL` is set
 *    (`app/Ops/reporting.ts`). Problems only: a collector files what it is
 *    sent as an error, and "it recovered" is not one.
 *
 * ## Once is the caller's promise
 *
 * Nothing here deduplicates. The caller decides that something has *started*
 * or *ended* and says so once, from state it keeps somewhere durable - a
 * limiter in this process's memory would send the alert again after every
 * deploy. See `app/Actions/Runner/Autoscale/backoff.ts` for the shape.
 *
 * **Never throws.** An alert is a consequence of something already wrong, and
 * failing to send one must not stop the job that noticed.
 */
export interface OperatorAlert {
  /** The notification type, and the event an administrator's preferences are keyed on. */
  event: OperatorEvent
  kind: 'problem' | 'recovered'
  /** One line that stands on its own: it is the inbox row and the email subject. */
  title: string
  /** What was seen and where to look. Goes to the log and the collector. */
  detail: string
  /** Where the notification points. */
  url: string
  context?: Record<string, unknown>
}

export type OperatorEvent = 'ops:runner-group'

export interface AlertOutcome {
  /** How many administrators got an inbox row. */
  administrators: number
  reported: 'sent' | 'suppressed' | 'off' | 'failed' | 'skipped'
}

export async function alertOperators(alert: OperatorAlert): Promise<AlertOutcome> {
  const line = `[ops] ${alert.title}. ${alert.detail}`
  if (alert.kind === 'problem')
    console.error(line)
  else
    console.log(line)

  let administrators = 0
  try {
    const admins = await db.selectFrom('users').select(['id']).where('is_admin', '=', true).execute()
    for (const admin of admins) {
      const userId = Number(admin.id)
      await db.insertInto('notifications').values({
        user_id: userId,
        type: alert.event,
        data: JSON.stringify({ title: alert.title, url: alert.url, reason: 'administrator', repository: '', number: null, detail: alert.detail }),
      }).execute()
      administrators++

      for (const channel of ['email', 'push'] as const)
        await queueDelivery({ userId, event: alert.event, channel, title: alert.title, url: alert.url, reason: 'you administer this instance', subjects: [] })
    }
  }
  catch (error) {
    console.error('[ops] could not notify the administrators:', error)
  }

  let reported: AlertOutcome['reported'] = 'skipped'
  if (alert.kind === 'problem') {
    try {
      reported = await report({ error: new Error(`${alert.title}. ${alert.detail}`), context: { event: alert.event, ...alert.context } })
    }
    catch {
      reported = 'failed'
    }
  }
  return { administrators, reported }
}

/**
 * Queue one interrupting delivery, without letting a queue that cannot take a
 * job cost the inbox row already written. Imported lazily, as the notification
 * listener does, so this file does not pull the queue in for its callers.
 */
async function queueDelivery(payload: Record<string, unknown>): Promise<void> {
  try {
    const SendNotificationJob = (await import('../Jobs/SendNotificationJob')).default
    await SendNotificationJob.dispatch(payload as any)
  }
  catch (error) {
    console.error('[ops] could not queue a delivery:', error)
  }
}

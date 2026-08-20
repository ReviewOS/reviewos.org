import { Job } from '@stacksjs/queue'
import { inspectAddress, inspectUrl, mayFollowRedirect } from '../Actions/Webhook/ssrf'
import {
  DELIVERY_HEADER,
  EVENT_HEADER,
  MAX_ATTEMPTS,
  retryDelayMs,
  shouldDeactivate,
  shouldRetry,
  signPayload,
  SIGNATURE_HEADER,
} from '../Actions/Webhook/signing'

/** Nobody's endpoint gets to hold a worker open. */
const TIMEOUT_MS = 10_000

/** Enough of the response to debug with, not enough to fill the table. */
const BODY_LIMIT = 4096

/**
 * Deliver one webhook, once, and record exactly what happened.
 *
 * **The most dangerous outbound request this product makes.** The URL is chosen
 * by whoever configured the webhook, the request originates from inside the
 * network, and there is no human watching - which is the whole shape of SSRF.
 * `ssrf.ts` holds the policy and it is applied three times here rather than
 * once: the URL before connecting, the address it resolves to, and every
 * redirect. Checking only the URL is the version of this that gets exploited,
 * because DNS is under the attacker's control and `evil.test` can resolve to
 * `169.254.169.254` a millisecond after it resolved to something public.
 *
 * One attempt per job. Retrying inside the handler would hold a worker for the
 * whole backoff - an hour, at the ceiling - and lose the schedule entirely if
 * the process restarted. Re-queueing means the delay is the queue's problem,
 * which is what a queue is for.
 *
 * Every attempt is logged, including the failures and the refusals. A delivery
 * log that only records successes cannot answer "you never called my endpoint",
 * which is the only question anybody ever asks it.
 */
export default new Job({
  name: 'DeliverWebhookJob',
  description: 'Send one webhook delivery and record the outcome',
  queue: 'webhooks',
  // One try. The retry schedule is `retryDelayMs`, re-queued by this job, so
  // the queue's own retry would double it and use the wrong curve.
  tries: 1,

  async handle(payload: {
    webhookId: number
    event: string
    body: string
    deliveryId?: string
    attempt?: number
  }) {
    const webhookId = Number(payload?.webhookId)
    const attempt = Math.max(1, Number(payload?.attempt ?? 1))

    if (!Number.isFinite(webhookId))
      return { ok: false, reason: 'no webhook id' }

    const webhook = await db
      .selectFrom('webhooks')
      .select(['id', 'url', 'secret', 'content_type', 'active', 'consecutive_failures', 'last_success_at', 'repository_id'])
      .where('id', '=', webhookId)
      .executeTakeFirst()

    if (!webhook)
      return { ok: false, reason: 'webhook no longer exists' }

    // Checked at delivery rather than at enqueue. A webhook switched off while
    // a delivery sat in the queue should not fire, and the gap between the two
    // is exactly when somebody turns one off because it is misbehaving.
    if (!webhook.active)
      return { ok: false, reason: 'webhook is inactive' }

    const body = String(payload?.body ?? '')
    const event = String(payload?.event ?? '')
    const deliveryId = String(payload?.deliveryId ?? crypto.randomUUID())

    const headers: Record<string, string> = {
      'content-type': String(webhook.content_type ?? 'application/json'),
      'user-agent': 'ReviewOS-Hookshot',
      [EVENT_HEADER]: event,
      [DELIVERY_HEADER]: deliveryId,
      // Over the exact bytes sent, not over a re-serialized object. A signature
      // computed from a re-encode is one the receiver cannot reproduce, and the
      // failure is a receiver who concludes the signature is worthless and
      // stops checking it.
      [SIGNATURE_HEADER]: signPayload(body, String(webhook.secret ?? '')),
    }

    const started = Date.now()
    const result = await post(String(webhook.url ?? ''), body, headers)
    const duration = Date.now() - started

    await record({
      webhookId,
      // Null for an instance-level webhook, which has no repository - the same
      // value the webhook row carries.
      repositoryId: Number(webhook.repository_id) || null,
      event,
      body,
      headers,
      attempt,
      duration,
      status: result.status,
      response: result.response,
      error: result.error,
    })

    const delivered = result.status !== null && result.status >= 200 && result.status < 300

    if (delivered) {
      await db
        .updateTable('webhooks')
        .set({ consecutive_failures: 0, last_success_at: new Date().toISOString() })
        .where('id', '=', webhookId)
        .execute()

      return { ok: true, status: result.status, attempt }
    }

    const failures = Number(webhook.consecutive_failures ?? 0) + 1

    await db
      .updateTable('webhooks')
      .set({ consecutive_failures: failures })
      .where('id', '=', webhookId)
      .execute()

    if (shouldRetry({ status: result.status, error: result.error }, attempt)) {
      // The delay comes from `retryDelayMs`, which jitters. Without jitter a
      // receiver that goes down takes every pending delivery with it and they
      // all return at the same instant, which is how a struggling endpoint is
      // held down.
      const { default: self } = await import('./DeliverWebhookJob')

      await (self as any).dispatch(
        { webhookId, event, body, deliveryId, attempt: attempt + 1 },
        { delay: Math.round(retryDelayMs(attempt + 1) / 1000) },
      )

      return { ok: false, status: result.status, attempt, retrying: true }
    }

    // Out of attempts. Whether the *webhook* is switched off is a separate
    // question with a separate rule: one delivery giving up is normal, and a
    // webhook that has not succeeded in days is an endpoint nobody owns any
    // more - continuing to call it is a slow outbound attack on somebody's
    // server.
    const daysSinceLastSuccess = webhook.last_success_at
      ? Math.floor((Date.now() - Date.parse(String(webhook.last_success_at))) / 86_400_000)
      : null

    if (shouldDeactivate({ consecutiveFailures: failures, daysSinceLastSuccess })) {
      await db
        .updateTable('webhooks')
        .set({ active: false })
        .where('id', '=', webhookId)
        .execute()

      return { ok: false, status: result.status, attempt, deactivated: true }
    }

    return { ok: false, status: result.status, attempt, gaveUp: attempt >= MAX_ATTEMPTS }
  },
})

interface PostResult {
  status: number | null
  response: string
  error?: string
}

/**
 * The request, with the SSRF policy applied at every point it can be dodged.
 *
 * Redirects are followed by hand rather than by `fetch`, because a followed
 * redirect is a second request to an address nobody checked - and a receiver
 * that answers `302 -> http://169.254.169.254/` is the textbook way past a
 * URL-only check.
 */
async function post(url: string, body: string, headers: Record<string, string>): Promise<PostResult> {
  let target = url
  let resolved: string | null = null

  for (let hop = 0; hop < 4; hop++) {
    const verdict = hop === 0 ? inspectUrl(target) : mayFollowRedirect(target, resolved)

    if (!verdict.allowed)
      return { status: null, response: '', error: verdict.message ?? verdict.reason ?? 'refused' }

    // The address, not the name. DNS is under the configurer's control, so a
    // hostname that inspected clean can resolve to a link-local address a
    // millisecond later - checking the name alone is the version that gets
    // exploited.
    const parsed = new URL(target)
    const address = await resolveHost(parsed.hostname)
    if (address) {
      // The port travels with it so an operator allowance for `10.0.0.5:9000`
      // is honoured on the resolved address too, and does not silently widen to
      // every port on that host.
      const addressVerdict = inspectAddress(address, parsed.port || (parsed.protocol === 'https:' ? 443 : 80))

      if (!addressVerdict.allowed)
        return { status: null, response: '', error: addressVerdict.message ?? 'resolved to a blocked address' }

      resolved = address
    }

    let answer: Response
    try {
      answer = await fetch(target, {
        method: 'POST',
        headers,
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
    }
    catch (error) {
      // A timeout and a refused connection are both "never reached a server",
      // which `shouldRetry` treats as worth another attempt.
      return { status: null, response: '', error: error instanceof Error ? error.message : String(error) }
    }

    const location = answer.headers.get('location')

    if (answer.status >= 300 && answer.status < 400 && location) {
      target = new URL(location, target).toString()
      continue
    }

    return { status: answer.status, response: (await answer.text()).slice(0, BODY_LIMIT) }
  }

  return { status: null, response: '', error: 'too many redirects' }
}

/** The address a hostname points at, or null when it is already one. */
async function resolveHost(hostname: string): Promise<string | null> {
  try {
    const { lookup } = await import('node:dns/promises')
    const answer = await lookup(hostname)

    return String(answer.address)
  }
  catch {
    // A name that will not resolve is not a policy failure. The fetch below
    // fails on it too, and reports the real reason.
    return null
  }
}

/**
 * Write down what happened, whatever happened.
 *
 * Never throws. A delivery log that can fail the delivery it is logging makes
 * the product less reliable than not having one.
 */
async function record(entry: {
  webhookId: number
  repositoryId: number | null
  event: string
  body: string
  headers: Record<string, string>
  attempt: number
  duration: number
  status: number | null
  response: string
  error?: string
}): Promise<void> {
  try {
    await db.insertInto('webhook_deliveries').values({
      webhook_id: entry.webhookId,
      repository_id: entry.repositoryId,
      event: entry.event,
      payload: entry.body,
      // The signature is not stored. It is reproducible from the payload and
      // the secret, and a log full of valid signatures is a log worth stealing.
      request_headers: JSON.stringify({ ...entry.headers, [SIGNATURE_HEADER]: '[redacted]' }),
      response_status: entry.status,
      response_body: entry.response,
      duration_ms: entry.duration,
      attempt: entry.attempt,
      error: entry.error ?? null,
      delivered_at: new Date().toISOString(),
    }).execute()
  }
  catch (error) {
    console.error('[webhook] could not record the delivery:', error)
  }
}

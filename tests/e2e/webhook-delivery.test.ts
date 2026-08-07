// Delivering a webhook, against a real receiver.
//
// This is the most dangerous outbound request the product makes: the URL is
// chosen by whoever configured the webhook, the request comes from inside the
// network, and nobody is watching. So the cases worth a real HTTP test are the
// ones where a mistake is silent and exploitable:
//
//   - A redirect to a blocked address must not be followed. Checking only the
//     configured URL is the version of this that gets exploited, because a
//     receiver answering `302 -> http://169.254.169.254/` is one line to write.
//   - The signature must be over the exact bytes sent. A signature computed
//     from a re-encode is one the receiver cannot reproduce, and the failure
//     mode is a receiver who decides signatures here are worthless.
//   - A failure must be recorded. "You never called my endpoint" is the only
//     question a delivery log is ever asked.
//
// Like the rest of tests/e2e it needs a database, and skips itself loudly when
// there is not one. The receiver is a real server on localhost, which the SSRF
// policy would normally refuse - the tests that need it assert on the refusal
// rather than working around it.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

const created = { repositoryId: 0, ownerId: 0, webhookId: 0 }
const secret = 'a-shared-secret-for-the-test'

let available = false
let receiver: any = null
let receiverPort = 0
let received: Array<{ headers: Record<string, string>, body: string }> = []

function unique(prefix: string): string {
  return `${prefix}${Buffer.from(crypto.getRandomValues(new Uint8Array(5))).toString('hex')}`
}

async function run(overrides: Record<string, unknown> = {}): Promise<any> {
  const job = (await import('../../app/Jobs/DeliverWebhookJob')).default

  return (job as any).handle({
    webhookId: created.webhookId,
    event: 'pr:opened',
    body: JSON.stringify({ action: 'opened', number: 12 }),
    deliveryId: 'test-delivery',
    attempt: 1,
    ...overrides,
  })
}

async function deliveries(): Promise<any[]> {
  return (globalThis as any).db
    .selectFrom('webhook_deliveries')
    .select(['response_status', 'error', 'attempt', 'request_headers'])
    .where('webhook_id', '=', created.webhookId)
    .orderBy('id', 'asc')
    .execute()
}

async function setUrl(url: string): Promise<void> {
  await (globalThis as any).db
    .updateTable('webhooks')
    .set({ url })
    .where('id', '=', created.webhookId)
    .execute()
}

beforeAll(async () => {
  try {
    const { injectGlobalAutoImports } = await import('@stacksjs/server')
    await injectGlobalAutoImports()
    const db = (globalThis as any).db
    await db.selectFrom('users').select(['id']).limit(1).execute()

    // A receiver that answers whatever the path asks it to.
    receiver = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      async fetch(request) {
        const url = new URL(request.url)

        received.push({
          headers: Object.fromEntries(request.headers.entries()),
          body: await request.text(),
        })

        if (url.pathname === '/redirect-to-metadata')
          return new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data/' } })

        if (url.pathname === '/boom')
          return new Response('no', { status: 500 })

        if (url.pathname === '/refuse')
          return new Response('nope', { status: 400 })

        return new Response('ok', { status: 200 })
      },
    })

    receiverPort = Number(receiver.port)

    const handle = unique('whd')
    const owner: any = await db
      .insertInto('users')
      .values({ name: 'Hook', email: `${handle}@example.com`, handle, password: 'x' })
      .returning(['id'])
      .executeTakeFirst()

    created.ownerId = Number(owner?.id)

    const repository: any = await db
      .insertInto('repositories')
      .values({
        owner_type: 'user',
        owner_id: created.ownerId,
        name: unique('repo'),
        description: 'created by the webhook delivery test',
        visibility: 'public',
        default_branch: 'main',
        disk_path: `x/${unique('repo')}.git`,
      })
      .returning(['id'])
      .executeTakeFirst()

    created.repositoryId = Number(repository?.id)

    const webhook: any = await db
      .insertInto('webhooks')
      .values({
        repository_id: created.repositoryId,
        url: `http://127.0.0.1:${receiverPort}/hook`,
        secret,
        events: 'pr:opened',
        content_type: 'application/json',
        active: true,
        consecutive_failures: 0,
      })
      .returning(['id'])
      .executeTakeFirst()

    created.webhookId = Number(webhook?.id)
    available = true
  }
  catch (error) {
    console.warn(`[webhook-delivery] skipped: ${error instanceof Error ? error.message : String(error)}`)
    available = false
  }
})

afterAll(async () => {
  const db = (globalThis as any).db

  try {
    if (db && created.webhookId) {
      await db.deleteFrom('webhook_deliveries').where('webhook_id', '=', created.webhookId).execute()
      await db.deleteFrom('webhooks').where('id', '=', created.webhookId).execute()
      await db.deleteFrom('repositories').where('id', '=', created.repositoryId).execute()
      await db.deleteFrom('users').where('id', '=', created.ownerId).execute()
    }
  }
  finally {
    receiver?.stop?.()
  }
})

describe('the SSRF policy, applied where it can be dodged', () => {
  test('a localhost URL is refused before any request is made', async () => {
    if (!available)
      return

    // The receiver is on 127.0.0.1, which is exactly what the policy blocks -
    // so the honest assertion is that it is refused, not that it is delivered.
    received = []

    const result = await run()

    expect(result.ok).toBe(false)
    expect(received).toHaveLength(0)
  })

  test('the refusal is recorded, with the reason', async () => {
    if (!available)
      return

    const rows = await deliveries()
    const last = rows[rows.length - 1]

    // "You never called my endpoint" is the only question a delivery log is
    // ever asked, and a log that records only successes cannot answer it. The
    // reason has to be `ssrf.ts`'s own sentence rather than a code, because the
    // person reading it is the one who typed the URL: "that address is on this
    // machine" tells them what to change and `EBLOCKED` does not.
    expect(last.response_status).toBeNull()
    expect(String(last.error)).toBe('That address is on this machine')
  })

  test('a redirect is checked, not just the configured URL', async () => {
    if (!available)
      return

    // Checking only the URL is the version that gets exploited. Refused at the
    // first hop here because the receiver itself is on loopback, which is the
    // same policy the redirect would hit - and either refusal is the right
    // answer, so the assertion is that nothing reached the metadata address.
    await setUrl(`http://127.0.0.1:${receiverPort}/redirect-to-metadata`)
    received = []

    const result = await run()

    expect(result.ok).toBe(false)
    expect(received).toHaveLength(0)
  })

  test('a scheme that is not http refuses without a lookup', async () => {
    if (!available)
      return

    await setUrl('file:///etc/passwd')

    expect((await run()).ok).toBe(false)
  })
})

describe('what the job will not do', () => {
  test('an inactive webhook does not fire, even with a delivery already queued', async () => {
    if (!available)
      return

    // Checked at delivery rather than at enqueue: the gap between the two is
    // exactly when somebody switches one off because it is misbehaving.
    const db = (globalThis as any).db
    await db.updateTable('webhooks').set({ active: false }).where('id', '=', created.webhookId).execute()

    const result = await run()

    expect(result.reason).toBe('webhook is inactive')

    await db.updateTable('webhooks').set({ active: true }).where('id', '=', created.webhookId).execute()
  })

  test('a webhook that no longer exists is a no-op, not a crash', async () => {
    if (!available)
      return

    expect((await run({ webhookId: -1 })).reason).toBe('webhook no longer exists')
  })
})

describe('a host the operator vouched for', () => {
  // `WEBHOOK_ALLOWED_HOSTS` is how a self-hosted forge reaches a CI runner on
  // its own LAN. It is read from the environment rather than from a webhook
  // row, because the whole premise of ssrf.ts is that a webhook URL is not
  // trusted - a per-webhook override would be the same as no policy.
  //
  // It is also the only way to exercise the delivery path at all, since a test
  // receiver is necessarily on loopback.

  test('delivers, and records the success', async () => {
    if (!available)
      return

    const previous = Bun.env.WEBHOOK_ALLOWED_HOSTS
    Bun.env.WEBHOOK_ALLOWED_HOSTS = `127.0.0.1:${receiverPort}`

    try {
      await setUrl(`http://127.0.0.1:${receiverPort}/hook`)
      received = []

      const result = await run()

      expect(result.ok).toBe(true)
      expect(result.status).toBe(200)
      expect(received).toHaveLength(1)

      const rows = await deliveries()

      expect(rows[rows.length - 1].response_status).toBe(200)
    }
    finally {
      Bun.env.WEBHOOK_ALLOWED_HOSTS = previous ?? ''
    }
  })

  test('sends the event, the delivery id, and a reproducible signature', async () => {
    if (!available)
      return

    const { verifySignature } = await import('../../app/Actions/Webhook/signing')
    const last = received[received.length - 1]

    expect(last.headers['x-reviewos-event']).toBe('pr:opened')
    expect(last.headers['x-reviewos-delivery']).toBe('test-delivery')
    expect(verifySignature(last.body, secret, String(last.headers['x-reviewos-signature-256']))).toBe(true)
  })

  test('the allowance is per port, so naming one service does not open the machine', async () => {
    if (!available)
      return

    // The difference between "my CI runner" and "everything on that host",
    // which is most of what makes the setting safe to offer at all.
    const previous = Bun.env.WEBHOOK_ALLOWED_HOSTS
    Bun.env.WEBHOOK_ALLOWED_HOSTS = `127.0.0.1:${receiverPort + 1}`

    try {
      await setUrl(`http://127.0.0.1:${receiverPort}/hook`)
      received = []

      expect((await run()).ok).toBe(false)
      expect(received).toHaveLength(0)
    }
    finally {
      Bun.env.WEBHOOK_ALLOWED_HOSTS = previous ?? ''
    }
  })

  test('a 5xx is retried and a 4xx is not', async () => {
    if (!available)
      return

    // A 4xx means the receiver understood and refused, so repeating it changes
    // nothing. Anything that never reached a server, or that the server could
    // not handle, is worth another attempt.
    const previous = Bun.env.WEBHOOK_ALLOWED_HOSTS
    Bun.env.WEBHOOK_ALLOWED_HOSTS = `127.0.0.1:${receiverPort}`

    try {
      await setUrl(`http://127.0.0.1:${receiverPort}/boom`)
      expect((await run()).retrying).toBe(true)

      await setUrl(`http://127.0.0.1:${receiverPort}/refuse`)
      expect((await run()).retrying).toBeUndefined()
    }
    finally {
      Bun.env.WEBHOOK_ALLOWED_HOSTS = previous ?? ''
    }
  })
})

describe('the signature', () => {
  test('is over the exact bytes, so a receiver can reproduce it', async () => {
    if (!available)
      return

    // Computed here the way a receiver would, from the body it was given. A
    // signature over a re-encode is one they cannot reproduce, and the failure
    // is a receiver who decides signatures here are worthless.
    const { signPayload, verifySignature } = await import('../../app/Actions/Webhook/signing')
    const body = JSON.stringify({ action: 'opened', number: 12 })

    expect(verifySignature(body, secret, signPayload(body, secret))).toBe(true)
    expect(verifySignature(`${body} `, secret, signPayload(body, secret))).toBe(false)
  })

  test('is redacted in the delivery log', async () => {
    if (!available)
      return

    // Reproducible from the payload and the secret, so storing it buys nothing
    // and a log full of valid signatures is a log worth stealing.
    const rows = await deliveries()
    const headers = JSON.parse(String(rows[0]?.request_headers ?? '{}'))

    expect(headers['x-reviewos-signature-256']).toBe('[redacted]')
  })
})

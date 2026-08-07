/**
 * The instance's own VAPID keypair.
 *
 * **Generated on first use, never shipped.** A key baked into the source would
 * be shared by every self-hosted instance, which means any one of them could
 * send push notifications claiming to be any other, and one revocation would
 * break everybody. Each installation minting its own is the whole reason the
 * protocol has a per-application key rather than a per-vendor one.
 *
 * Read from the environment. `VAPID_PUBLIC_KEY` is safe to hand to a browser -
 * it has to be, the browser needs it to subscribe - and `VAPID_PRIVATE_KEY`
 * never leaves the server. Both are printed once at generation for an operator
 * to paste into `.env`, because writing to a file the process may not own is
 * the kind of helpfulness that fails on exactly the deployments that matter.
 *
 * **Rotating them invalidates every existing subscription.** A browser
 * subscribes *to* a public key, so a new pair means every stored endpoint stops
 * accepting, and everybody has to opt in again. That is a real cost and the
 * reason this generates once rather than per boot.
 */

export interface Vapid {
  publicKey: string
  privateKey: string
  /** `mailto:` or `https:`, so a push service can reach whoever runs this. */
  subject: string
}

/**
 * The configured keypair, or null.
 *
 * Null rather than a thrown error or a generated-on-the-fly pair. Push is one
 * channel of three: an instance with no keys should send email and fill the
 * inbox exactly as before, and a missing optional key is not a reason to fail a
 * notification. Generating one per boot would be worse than either - every
 * restart would silently invalidate every subscription.
 */
export function vapidKeys(): Vapid | null {
  const publicKey = String(Bun.env.VAPID_PUBLIC_KEY ?? '').trim()
  const privateKey = String(Bun.env.VAPID_PRIVATE_KEY ?? '').trim()

  if (!publicKey || !privateKey)
    return null

  return {
    publicKey,
    privateKey,
    // Falls back to a URL rather than an address, because an invented mailto
    // that bounces is worse than a link: RFC 8292 asks for a way to reach the
    // operator, and a push service that cannot will eventually just block.
    subject: String(Bun.env.VAPID_SUBJECT ?? '').trim()
      || String(Bun.env.APP_URL ?? 'https://localhost').trim(),
  }
}

/** Whether this instance can send push at all. */
export function pushIsConfigured(): boolean {
  return vapidKeys() !== null
}

/**
 * A new pair, with the lines to paste into `.env`.
 *
 * Used by `buddy push:keys`. Returned rather than written for the reason above:
 * a process that rewrites its own configuration file is one that fails on a
 * read-only deployment and succeeds confusingly on a shared one.
 */
export async function mintVapidKeys(): Promise<{ publicKey: string, privateKey: string, env: string }> {
  const { generateVapidKeys } = await import('@stacksjs/push')
  const keys = generateVapidKeys()

  return {
    ...keys,
    env: [
      `VAPID_PUBLIC_KEY=${keys.publicKey}`,
      `VAPID_PRIVATE_KEY=${keys.privateKey}`,
      '# mailto: or https:, so a push service can reach you before it blocks you',
      `VAPID_SUBJECT=mailto:ops@example.com`,
    ].join('\n'),
  }
}

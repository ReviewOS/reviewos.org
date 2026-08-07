import { writeHeaders } from './csrf'

/**
 * Turning browser notifications on, from the settings page.
 *
 * The only part of this product that talks to a browser capability rather than
 * to the server, which is why it is here rather than in a template: the Push
 * API is `navigator.serviceWorker` and `PushManager`, and there is no state
 * layer to express it through. The template calls these and holds the answer.
 *
 * **The permission prompt is spent, not shown.** A browser asked once and
 * refused cannot be asked again - `Notification.requestPermission()` resolves
 * `denied` immediately, forever, with no interface anywhere to undo it except
 * the browser's own site settings, which almost nobody finds. So it is asked at
 * the moment somebody presses a button that says what it is for, and never on
 * page load. Spending that one prompt on a first visit costs the feature
 * permanently for that reader, and no amount of later product work gets it
 * back.
 *
 * Every function here reports rather than throws. A browser that does not
 * support push, a worker that will not register, a permission that was already
 * refused - all of them are ordinary states of an optional feature, and the
 * settings page has to say which one rather than showing an error.
 */

export interface PushState {
  /** Whether this browser can do push at all. */
  supported: boolean
  /** `default`, `granted`, or `denied`. */
  permission: string
  /** Whether this browser is registered with the server right now. */
  subscribed: boolean
  /** What to tell the reader, when something is in the way. */
  message: string
}

/** Whether the three APIs this needs all exist. */
export function pushSupported(): boolean {
  return typeof navigator !== 'undefined'
    && 'serviceWorker' in navigator
    && typeof PushManager !== 'undefined'
    && typeof Notification !== 'undefined'
}

/**
 * Where this browser stands, without asking for anything.
 *
 * Safe to call on page load, because it prompts for nothing. That is the whole
 * distinction: reading `Notification.permission` is free, and calling
 * `requestPermission` is a one-shot resource.
 */
export async function pushState(): Promise<PushState> {
  if (!pushSupported())
    return { supported: false, permission: 'unsupported', subscribed: false, message: 'This browser cannot show notifications.' }

  const permission = Notification.permission

  if (permission === 'denied') {
    return {
      supported: true,
      permission,
      subscribed: false,
      // Named precisely, because the fix is not in this product. Somebody who
      // is told "notifications are blocked" without being told where to unblock
      // them concludes the feature is broken.
      message: 'This browser is blocking notifications. Allow them in its site settings first.',
    }
  }

  try {
    const registration = await navigator.serviceWorker.getRegistration('/push-worker.js')
    const subscription = registration ? await registration.pushManager.getSubscription() : null

    return { supported: true, permission, subscribed: Boolean(subscription), message: '' }
  }
  catch {
    return { supported: true, permission, subscribed: false, message: '' }
  }
}

/**
 * Ask, register, subscribe, and tell the server.
 *
 * Called from a button press and from nowhere else. The order matters: the
 * worker is registered *before* the prompt, so a reader who says yes is
 * subscribed immediately rather than being asked again after a registration
 * that might fail.
 */
export async function enablePush(publicKey: string): Promise<PushState> {
  if (!pushSupported())
    return { supported: false, permission: 'unsupported', subscribed: false, message: 'This browser cannot show notifications.' }

  if (!publicKey)
    return { supported: true, permission: Notification.permission, subscribed: false, message: 'This instance has no push keys configured.' }

  try {
    // Root scope, matching where the file is served from. A worker registered
    // with a narrower scope receives nothing and reports success, which is the
    // silent failure this whole feature is prone to.
    const registration = await navigator.serviceWorker.register('/push-worker.js', { scope: '/' })
    await navigator.serviceWorker.ready

    const permission = await Notification.requestPermission()

    if (permission !== 'granted') {
      return {
        supported: true,
        permission,
        subscribed: false,
        message: permission === 'denied'
          ? 'This browser is blocking notifications. Allow them in its site settings first.'
          : 'Notifications were not enabled.',
      }
    }

    const subscription = await registration.pushManager.subscribe({
      // Required to be true by every browser, and the reason push cannot be
      // used for silent tracking: every message must show something.
      userVisibleOnly: true,
      applicationServerKey: decodeKey(publicKey),
    })

    const json: any = subscription.toJSON()

    const answer = await fetch('/api/user/notifications/push', {
      method: 'POST',
      headers: writeHeaders('application/json'),
      body: JSON.stringify({
        endpoint: json.endpoint,
        p256dh: json.keys?.p256dh,
        auth: json.keys?.auth,
      }),
    })

    if (!answer.ok) {
      // Rolled back on the browser side. A subscription the server does not
      // know about is one that can never ring, and leaving it would make the
      // page say "on" forever while nothing arrives.
      await subscription.unsubscribe()

      return { supported: true, permission, subscribed: false, message: 'The server would not register this browser.' }
    }

    return { supported: true, permission, subscribed: true, message: '' }
  }
  catch (error) {
    return {
      supported: true,
      permission: Notification.permission,
      subscribed: false,
      message: error instanceof Error ? error.message : 'Could not enable notifications.',
    }
  }
}

/**
 * Stop this browser, on both sides.
 *
 * The server row goes first. If the browser unsubscribed first and the request
 * then failed, the row would stay and the endpoint would be dead - every future
 * notification spending a request on it until a push service finally answers
 * 410. Doing it in this order means the worst case is a browser that is
 * unregistered on the server and still holds a subscription, which rings
 * nothing and is cleaned up the next time it subscribes.
 */
export async function disablePush(): Promise<PushState> {
  if (!pushSupported())
    return { supported: false, permission: 'unsupported', subscribed: false, message: '' }

  try {
    const registration = await navigator.serviceWorker.getRegistration('/push-worker.js')
    const subscription = registration ? await registration.pushManager.getSubscription() : null

    if (subscription) {
      await fetch('/api/user/notifications/push', {
        method: 'POST',
        headers: writeHeaders('application/json'),
        body: JSON.stringify({ operation: 'delete', endpoint: subscription.endpoint }),
      })

      await subscription.unsubscribe()
    }

    return { supported: true, permission: Notification.permission, subscribed: false, message: '' }
  }
  catch (error) {
    return {
      supported: true,
      permission: Notification.permission,
      subscribed: true,
      message: error instanceof Error ? error.message : 'Could not turn notifications off.',
    }
  }
}

/** Ring this browser now, so a reader can see whether any of it works. */
export async function testPush(): Promise<string> {
  try {
    const answer = await fetch('/api/user/notifications/push/test', {
      method: 'POST',
      headers: writeHeaders('application/json'),
      body: '{}',
    })

    const body: any = await answer.json().catch(() => ({}))

    if (!answer.ok)
      return String(body.error ?? 'Could not send a test notification.')

    return body.sent > 0
      ? `Sent to ${body.sent} browser${body.sent === 1 ? '' : 's'}.`
      : 'Nothing was sent. No browser is subscribed.'
  }
  catch {
    return 'Could not reach the server.'
  }
}

/**
 * The VAPID public key as `applicationServerKey` wants it.
 *
 * base64url in, raw bytes out. The browser rejects the string form with a type
 * error that names neither the key nor the encoding, which is why this is a
 * named function rather than three lines inline.
 */
function decodeKey(base64url: string): ArrayBuffer {
  const padded = base64url.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(padded + '='.repeat((4 - padded.length % 4) % 4))
  const bytes = new Uint8Array(binary.length)

  for (let index = 0; index < binary.length; index++)
    bytes[index] = binary.charCodeAt(index)

  // The underlying buffer, not the view. `applicationServerKey` is typed
  // `BufferSource` and a `Uint8Array` over a shared buffer does not satisfy it,
  // which TypeScript catches and the browser would not: it accepts either, so
  // this would have shipped as a type error nobody could reproduce at runtime.
  return bytes.buffer as ArrayBuffer
}

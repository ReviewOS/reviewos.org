/*
 * The service worker that shows a push notification.
 *
 * Served from the site root, deliberately. A service worker's scope is its own
 * directory, so one at `/js/push-worker.js` could only ever control `/js/*` and
 * would receive nothing - which fails by silence, with a successful
 * registration and no notifications ever arriving.
 *
 * This file is plain JavaScript rather than stx, and that is not an oversight:
 * a service worker runs in its own global scope with no DOM, outside the page's
 * module graph and often when no page is open at all. Nothing in the framework
 * can reach it and it can reach nothing in the framework.
 *
 * It does two things and refuses to grow a third. Everything a service worker
 * is otherwise used for - caching, offline, background sync - would make this
 * file responsible for what the product serves, and a caching bug there is one
 * that survives a deploy and is invisible to whoever shipped it.
 */

/**
 * Show what arrived.
 *
 * `waitUntil` is required rather than tidy: without it the browser may kill
 * this worker before `showNotification` resolves, and the notification is
 * silently dropped. That happens on exactly the devices push exists for - a
 * phone conserving battery - and never on the laptop where it was tested.
 */
self.addEventListener('push', (event) => {
  let payload = {}

  try {
    payload = event.data ? event.data.json() : {}
  }
  catch (error) {
    // Malformed is still worth showing. A notification saying something
    // happened beats none at all, and the alternative is silence that reads
    // exactly like push being broken.
    payload = { title: 'ReviewOS', body: '' }
  }

  const title = payload.title || 'ReviewOS'

  event.waitUntil(self.registration.showNotification(title, {
    body: payload.body || '',
    // The tag is what collapses three notifications about one pull request
    // into one. Without it a device that was asleep wakes to a stack of stale
    // ones and the reader has to dismiss each.
    tag: payload.tag || undefined,
    // Deliberately false. `renotify` would re-alert on every replacement, which
    // turns collapsing - a courtesy - into being buzzed once per comment.
    renotify: false,
    // Carried through to the click handler. A notification whose destination is
    // not in the payload has to be guessed at, and guessing sends people to a
    // list instead of the thing that happened.
    data: { url: payload.url || '/' },
    icon: '/images/icon-192.png',
    badge: '/images/badge-72.png',
  }))
})

/**
 * Open what it is about, in a tab that is already there when possible.
 *
 * The roadmap's line, and it earns its place: somebody who gets four
 * notifications about one pull request should end up with one tab, not four
 * copies of the same screen with different scroll positions. `focus` on an
 * existing client is what makes a notification feel like it belongs to the
 * application rather than to the browser.
 *
 * Matching is on the path, so any tab already on that pull request wins even if
 * the reader is on a different sub-tab of it - which is what somebody meant by
 * "I already have this open".
 */
self.addEventListener('notificationclick', (event) => {
  event.notification.close()

  const target = (event.notification.data && event.notification.data.url) || '/'

  event.waitUntil((async () => {
    // `includeUncontrolled` matters: tabs opened before this worker took
    // control are not controlled by it, and those are most of them on the first
    // visit after an update. Without it the first click after a deploy always
    // opens a duplicate.
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })

    for (const client of clients) {
      if (new URL(client.url).pathname === new URL(target, self.location.origin).pathname) {
        await client.focus()
        return
      }
    }

    // Nothing open on it. A tab already on the site is navigated rather than
    // added to, because opening a second window on a product somebody already
    // has open is how tab counts get to forty.
    for (const client of clients) {
      if ('navigate' in client) {
        await client.navigate(target)
        await client.focus()
        return
      }
    }

    await self.clients.openWindow(target)
  })())
})

import { route } from '@stacksjs/router'

/**
 * Unsubscribing, at the root and with no session.
 *
 * Mounted with no prefix because the URL goes into an email and into a
 * `List-Unsubscribe` header, and both are read by machines that will not follow
 * a redirect from `/api` to anywhere. It is also the URL somebody sees at the
 * bottom of a notification, and `/unsubscribe/…` is one they can recognise as
 * doing what it says.
 *
 * **The same path serves GET and POST, deliberately.** RFC 8058's one-click
 * flow posts to the address in `List-Unsubscribe`, so that address has to accept
 * a POST; a human opening the same link gets the page with the button on it.
 * Two different URLs would mean Gmail's native button and the footer link could
 * drift apart, and the button is the one most people press.
 *
 * GET renders `resources/views/unsubscribe/[token].stx` and changes nothing.
 * Mail security scanners fetch every URL in a message before a human sees it,
 * so a link that unsubscribed on being opened would unsubscribe people who
 * never read the email - and they would never learn why the notifications
 * stopped.
 *
 * **`skipCsrf` is required here, and is not a weakening.** Gmail's one-click
 * post is a cross-origin request with no cookie and no way to carry a token, so
 * the default check refuses it - which would silently break the button most
 * people press, in production, with nothing failing anywhere a developer looks.
 *
 * CSRF protection exists to stop a third party spending a victim's *ambient*
 * credential. There is no ambient credential on this route: it takes no
 * session, and the signed token in the path is the whole authorization. An
 * attacker who has the token can already unsubscribe by opening the link, so
 * there is nothing a forged post could add - and the token's signature covers
 * both the address and the thread, so it cannot be widened.
 */
route.post('/unsubscribe/{token}', 'Actions/Notification/UnsubscribeAction').skipCsrf()

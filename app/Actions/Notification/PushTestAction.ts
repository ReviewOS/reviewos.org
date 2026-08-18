import { Action } from '@stacksjs/actions'
import { currentUser } from '../Identity/lookup'
import { pushToUser } from './push'
import { pushIsConfigured } from './vapid'

/**
 * Send one notification to this person's browsers, now.
 *
 * **The failure mode is why this exists.** Web push breaks in ways that are
 * invisible from both ends: a permission the browser silently downgraded, a
 * VAPID key that does not match what the browser subscribed against, a service
 * worker that never activated, a subscription the push service expired. Every
 * one of those produces exactly the same symptom - notifications simply do not
 * arrive - and nothing in the interface distinguishes them from "nothing has
 * happened yet". A button that rings the browser in front of you is the only
 * way to tell.
 *
 * It goes through `pushToUser`, the same function real notifications use, so
 * what is tested is what runs. A test path with its own payload would prove the
 * test path works, which is the one guarantee nobody needs.
 *
 * **Quiet hours are deliberately not applied.** Somebody pressing a test button
 * is asking for a notification right now, and holding it until 09:00 would look
 * exactly like the failure they are trying to diagnose. This is the one place
 * the schedule is skipped, and it is skipped because the person asked.
 */
export default new Action({
  name: 'PushTest',
  description: 'Send a test push notification to this user\'s browsers',
  method: 'POST',

  async handle(request: RequestInstance) {
    const user = await currentUser(request)
    if (!user)
      return response.json({ error: 'Unauthenticated' }, 401)

    // Said plainly rather than reported as a failed send. An operator who never
    // set VAPID keys needs to be told that, not shown a delivery that did not
    // work for reasons unstated.
    if (!pushIsConfigured()) {
      return response.json({
        error: 'This instance has no VAPID keys. Run `buddy push:keys` and put them in the environment.',
      }, 409)
    }

    const outcome = await pushToUser(user.id, {
      title: 'Push is working',
      body: 'This is what a notification from ReviewOS looks like.',
      url: '/settings/notifications',
      // Its own tag, so pressing the button twice replaces the first rather
      // than stacking - which would make the button itself demonstrate the
      // behaviour it is meant to be checking.
      tag: 'reviewos:push-test',
      urgency: 'high',
    })

    if (outcome.sent === 0 && outcome.pruned === 0 && outcome.failed === 0) {
      return response.json({
        error: 'No browser is subscribed. Turn push on in this browser first.',
      }, 409)
    }

    return response.json({
      sent: outcome.sent,
      // Reported rather than hidden. Somebody who pressed test and got "1 sent,
      // 2 removed" has just learned that two old browsers were cleaned up,
      // which is information rather than an error.
      removed: outcome.pruned,
      failed: outcome.failed,
    })
  },
})

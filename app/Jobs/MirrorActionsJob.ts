import { mirrorUsedActions } from '../Actions/Actions/mirror'
import { defaultPolicy } from '../Actions/Runner/actionRef'

/**
 * Keep the mirrored actions current.
 *
 * What is mirrored is what the instance's active workflows actually use, read
 * out of the versions already parsed rather than from a list somebody
 * maintains: a list drifts the moment a workflow changes, and the failure of a
 * stale one is a build that breaks because the single action nobody added is
 * the one it needed.
 *
 * Hourly, and cheap when nothing has changed - `git remote update` on an
 * unchanged repository is one round trip that transfers nothing. The reason to
 * run it at all when everything is fine is that the day it matters is the day
 * the upstream host is down, and a mirror last updated a week ago is missing
 * exactly the tag somebody pushed yesterday.
 *
 * **Off unless a policy allows remote actions.** The default policy allows
 * none, so on a fresh instance this sweeps nothing and costs nothing, which is
 * the correct behaviour for an instance that never fetches actions.
 */
export default {
  handle: async (): Promise<{ mirrored: number, updated: number, failed: number }> => {
    const policy = defaultPolicy()

    // Nothing allowed, nothing to mirror. Reading every workflow's steps to
    // discover that would be a query per hour for no reason.
    if (policy.allowedHosts.length === 0)
      return { mirrored: 0, updated: 0, failed: 0 }

    const result = await mirrorUsedActions(policy)

    return { mirrored: result.mirrored, updated: result.updated, failed: result.failed.length }
  },
}

import { Job } from '@stacksjs/queue'
import { cachePolicy, collectCaches } from '../Actions/Workflow/cacheCollect'
import process from 'node:process'

/**
 * Dependency snapshots, past the policy.
 *
 * A cache with no collector is a disk that fills, and the day it fills is the
 * day every job on the instance fails at once for a reason nobody connects to
 * caching. This is the half that makes the other half safe to turn on.
 *
 * **Daily, and never a surprise.** The numbers it applies are configuration,
 * and `buddy ci:caches` prints what the next sweep would remove without
 * removing it - through the same function, so the preview and the act cannot
 * disagree. A retention rule that lives only inside a cron job is one nobody
 * can quote, and a cache that vanishes without explanation is worse than one
 * that vanishes on a schedule somebody could read.
 *
 * Nightly rather than hourly because nothing depends on the exact moment: an
 * entry a day past its idle window costs a few gigabytes, not a wrong answer.
 */
export default new Job({
  name: 'CollectCachesJob',
  description: 'Remove dependency snapshots past the size and age policy',
  queue: 'default',
  tries: 1,

  async handle() {
    const policy = cachePolicy(process.env as Record<string, string | undefined>)
    const swept = await collectCaches()

    // The policy is reported beside what it did, so a log line answers "why is
    // this gone" without anybody having to find the configuration.
    return { ok: true, policy, removed: swept.removed, freed: swept.freed, repositories: swept.repositories }
  },
})

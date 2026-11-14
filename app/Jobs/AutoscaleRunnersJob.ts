import { Job } from '@stacksjs/queue'
import { autoscalingGroups } from '../../cloud/autoscaling'
import { awsWorkerGroupApi } from '@stacksjs/ts-cloud/drivers'
import { tickGroup } from '../Actions/Runner/Autoscale/tick'

/**
 * Grow each runner group in `cloud/autoscaling.ts` to meet the jobs waiting
 * for it, once a minute.
 *
 * Only ever grows: instances shrink a group themselves when they have been
 * idle, because only they know whether they are mid-job (see
 * ts-cloud's `planWorkerGroup`). An instance with no AWS credentials
 * configured does nothing, quietly - autoscaling is something an operator
 * turns on, not something a fresh install should start failing at.
 *
 * A group whose launches keep ending without a runner is held to one probe at
 * a time, with growing gaps, until one registers - and the instance's
 * administrators are told when that starts and when it ends, rather than the
 * log being told every minute (`Actions/Runner/Autoscale/backoff.ts`).
 *
 * One group's failure does not stop the next: a throttled API in one region is
 * no reason for another region's jobs to wait.
 */
const warnedNoCredentials = new Set<string>()

export default new Job({
  name: 'AutoscaleRunnersJob',
  description: 'Grow autoscaled runner groups to meet waiting jobs',
  queue: 'default',
  tries: 1,
  async handle() {
    for (const group of Object.values(autoscalingGroups)) {
      const api = awsWorkerGroupApi(group.region)
      if (!api) {
        // Once per process: quiet on a laptop with no keys, but a production
        // scheduler that cannot see its credentials should say so rather than
        // leave a queue waiting behind a job that silently does nothing.
        if (!warnedNoCredentials.has(group.name)) {
          warnedNoCredentials.add(group.name)
          console.warn(`[autoscale] ${group.name}: no AWS credentials in this process, so this group is not being scaled`)
        }
        continue
      }
      try {
        for (const line of await tickGroup(api, group))
          console.log(`[autoscale] ${line}`)
      }
      catch (error) {
        console.error(`[autoscale] ${group.name}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  },
})

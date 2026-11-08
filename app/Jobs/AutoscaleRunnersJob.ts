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
 * One group's failure does not stop the next: a throttled API in one region is
 * no reason for another region's jobs to wait.
 */
export default new Job({
  name: 'AutoscaleRunnersJob',
  description: 'Grow autoscaled runner groups to meet waiting jobs',
  queue: 'default',
  tries: 1,
  async handle() {
    for (const group of Object.values(autoscalingGroups)) {
      const api = awsWorkerGroupApi(group.region)
      if (!api)
        continue
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

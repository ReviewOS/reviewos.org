import type { AwsWorkerGroupConfig } from '@stacksjs/ts-cloud/drivers'

/**
 * A runner group declared in `cloud/autoscaling.ts`: an AWS worker group (from
 * ts-cloud, which owns everything cloud) plus what makes its workers ReviewOS
 * runners - the jobs they are for and how the runner is set up.
 */
export interface RunnerGroup extends AwsWorkerGroupConfig {
  /** `owner/name` on this instance. The jobs the group is for. */
  repositories: string[]
  /** What its runners answer to. */
  labels: string[]
  /** A runner with nothing to do for this long exits, and its instance with it. */
  idleTimeoutSeconds: number
  pantryVersion: string
  packages: string[]
}

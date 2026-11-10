import type { RunnerGroup } from '../app/Actions/Runner/Autoscale/types'

/**
 * Runner groups that grow with the queue and shrink to nothing.
 *
 * A box in `cloud/boxes.ts` is one machine that is always there. A group here is
 * a ts-cloud AWS worker group - an EC2 Auto Scaling group whose instances run
 * a ReviewOS runner. ts-cloud owns the cloud side: `buddy runner:autoscale:apply`
 * converges its security group, instance role, launch template and the group
 * itself, and the
 * scheduler's `AutoscaleRunnersJob` raises its desired capacity once a minute by
 * the jobs that are waiting for it. Every instance registers into the group's
 * pool, takes work until it has been idle for `idleTimeoutSeconds`, then
 * terminates itself and lowers the desired capacity on the way out - so nothing
 * outside the machine ever decides to kill one mid-job.
 *
 * An Auto Scaling group with a mixed instances policy, not Spot Fleet: Spot
 * Fleet is AWS's legacy API with no planned investment, and EC2 Fleet's
 * `instant` mode would leave capacity, replacement and rebalancing to this code.
 *
 * Credentials are not here. The apply command and the scheduled job read AWS
 * credentials the usual way (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY, a
 * profile, or an instance role), and the pool's registration token comes from
 * `REVIEWOS_AUTOSCALE_REGISTRATION_TOKEN` when the launch template is written.
 */
export const autoscalingGroups: Record<string, RunnerGroup> = {
  'hq-aws': {
    name: 'reviewos-runner-hq',
    region: 'us-east-1',
    // The jobs this group exists for, and the labels its machines answer to.
    // A job is counted as waiting for the group when it belongs to one of
    // these repositories and every label it asks for is one of these.
    repositories: ['stacks/hq.training'],
    labels: ['ubuntu-latest', 'self-hosted', 'aws'],
    // x86 only: HQ's browser tests need Pantry's google.com/chrome, which has
    // no verified Linux arm64 build. Eight vCPUs, at least 16 GB. Listed so
    // `price-capacity-optimized` has pools to choose from when one runs dry.
    instanceTypes: ['c7a.2xlarge', 'c6a.2xlarge', 'm7a.2xlarge', 'm6a.2xlarge', 'c5a.2xlarge', 'm5a.2xlarge'],
    market: { spot: true, onDemandBaseCapacity: 0, onDemandPercentageAboveBase: 0 },
    // When Spot refuses a launch or takes a machine back, the next launches are
    // on-demand until Spot has been quiet this long (AutoscaleRunnersJob).
    // HQ's deploys wait on these machines, so a dry spell costs more than the
    // on-demand difference for half an hour.
    spotFallbackSeconds: 1800,
    min: 0,
    max: 6,
    idleTimeoutSeconds: 300,
    // Booted and never registered after this long means cloud-init failed;
    // the instance is terminated rather than billed while it does nothing.
    registrationGraceSeconds: 900,
    // The Stacks account has no default VPC in us-east-1, and the VPC it does
    // have holds production. The group gets a network of its own instead.
    network: 'dedicated',
    networkCidr: '10.88.0.0/16',
    diskGb: 80,
    pantryVersion: '0.11.184',
    packages: ['bun.sh@1.4.4', 'git-scm.org@2.53.0', 'google.com/chrome@155.0.8059.84.1'],
  },
}

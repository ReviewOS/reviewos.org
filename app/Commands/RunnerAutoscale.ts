import type { CLI } from '@stacksjs/types'
import process from 'node:process'
import { autoscalingGroups } from '../../cloud/autoscaling'

/**
 * Runner groups that grow with the queue: `cloud/autoscaling.ts`.
 *
 * `runner:autoscale:apply` converges a group's AWS resources - security group,
 * instance role, launch template, Auto Scaling group - and is what an operator
 * runs after changing the declaration. `runner:autoscale:tick` makes one
 * scaling decision; the scheduler runs it every minute as AutoscaleRunnersJob,
 * and running it by hand with `--dry-run` shows what it would do and why.
 */
export default function (cli: CLI) {
  const choose = (name: string | undefined) => {
    const key = name ?? (Object.keys(autoscalingGroups).length === 1 ? Object.keys(autoscalingGroups)[0] : undefined)
    const group = key ? autoscalingGroups[key] : undefined
    if (!group) {
      console.error(`Which group? Declared: ${Object.keys(autoscalingGroups).join(', ') || 'none'}`)
      process.exit(1)
    }
    return group
  }

  cli
    .command('runner:autoscale:apply [group]', 'Converge a runner group\'s AWS resources from cloud/autoscaling.ts')
    .option('--dry-run', 'Show what would change without changing it', { default: false })
    .option('--profile <name>', 'AWS profile to use instead of the environment')
    .option('--instance <url>', 'This instance\'s public URL, which runners register with', { default: 'https://reviewos.org' })
    .action(async (name: string | undefined, options: { dryRun?: boolean, profile?: string, instance?: string }) => {
      const group = choose(name)
      const token = String(process.env.REVIEWOS_AUTOSCALE_REGISTRATION_TOKEN ?? '').trim()
      if (!token) {
        console.error('REVIEWOS_AUTOSCALE_REGISTRATION_TOKEN is not set: a registration token for the group\'s pool (fleet operation create-token).')
        process.exit(1)
      }
      try {
        const { awsWorkerGroupApi, convergeAwsWorkerGroup } = await import('@stacksjs/ts-cloud/drivers')
        const { buildUserData } = await import('../Actions/Runner/Autoscale/userdata')
        const api = awsWorkerGroupApi(group.region, { profile: options.profile })
        if (!api) {
          console.error('No AWS credentials: set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY, or pass --profile.')
          process.exit(1)
        }
        const userData = buildUserData(group, { instance: String(options.instance), registrationToken: token })
        const report = await convergeAwsWorkerGroup(api, group, { userData, dryRun: Boolean(options.dryRun) })
        console.log(`${group.name} (${group.region})${options.dryRun ? ', dry run' : ''}`)
        for (const line of report) console.log(`  ${line}`)
        process.exit(0)
      }
      catch (error) {
        console.error(`Could not apply ${group.name}: ${error instanceof Error ? error.message : String(error)}`)
        process.exit(1)
      }
    })

  cli
    .command('runner:autoscale:tick [group]', 'Make one scaling decision for a runner group')
    .option('--dry-run', 'Say what it would do without doing it', { default: false })
    .option('--profile <name>', 'AWS profile to use instead of the environment')
    .action(async (name: string | undefined, options: { dryRun?: boolean, profile?: string }) => {
      const group = choose(name)
      try {
        const { awsWorkerGroupApi } = await import('@stacksjs/ts-cloud/drivers')
        const { tickGroup } = await import('../Actions/Runner/Autoscale/tick')
        const api = awsWorkerGroupApi(group.region, { profile: options.profile })
        if (!api) {
          console.error('No AWS credentials: set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY, or pass --profile.')
          process.exit(1)
        }
        const lines = await tickGroup(api, group, { dryRun: Boolean(options.dryRun) })
        for (const line of lines.length > 0 ? lines : [`${group.name}: nothing to do`]) console.log(line)
        process.exit(0)
      }
      catch (error) {
        console.error(`Could not scale ${group.name}: ${error instanceof Error ? error.message : String(error)}`)
        process.exit(1)
      }
    })
}

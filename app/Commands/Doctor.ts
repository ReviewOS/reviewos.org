import type { CLI } from '@stacksjs/types'
import process from 'node:process'
import { describe, inspect } from '../Ops/config'
import { checkHealth } from '../Ops/health'
import { checkRepositories } from '../Ops/repositories'

/**
 * Is this instance configured and working.
 *
 * The command somebody runs after a deploy that did not go well, and the one a
 * container's start script runs before serving. It reports the same two things
 * the boot check and the health endpoint do, so there is nothing to learn twice:
 * the configuration, and the subsystems.
 *
 * Exits non-zero when something is fatal, so `reviewos:check && reviewos:serve`
 * does the right thing in a shell without anybody parsing output.
 */
export default function (cli: CLI) {
  cli
    .command('instance:check', 'Check this instance\'s configuration and subsystems')
    .option('--config-only', 'Skip the subsystem checks, which need a database', { default: false })
    .action(async (options: { configOnly?: boolean }) => {
      const verdict = inspect(process.env)

      console.log(describe(verdict))

      if (options.configOnly) {
        process.exit(verdict.ok ? 0 : 1)
        return
      }

      /*
       * The subsystems, only when the configuration allows reaching them.
       * Running them against a configuration already known to be broken
       * produces a second, noisier failure about the same cause.
       */
      if (!verdict.ok) {
        console.error('')
        console.error('Skipping the subsystem checks: fix the configuration first.')
        process.exit(1)
        return
      }

      console.log('')

      const report = await checkHealth()

      for (const check of report.checks) {
        const mark = check.status === 'ok' ? 'ok      ' : check.status === 'degraded' ? 'slow    ' : 'FAILED  '
        console.log(`${mark}${check.name} (${check.ms}ms)${check.detail ? ` - ${check.detail}` : ''}`)
      }

      process.exit(report.ok ? 0 : 1)
    })

  cli
    .command('instance:repos', 'Check that the repository rows and the directories on disk agree')
    .option('--fix-nothing', 'Report only. This command never changes anything; the flag exists to say so.', { default: true })
    .action(async () => {
      const report = await checkRepositories()

      for (const problem of report.problems)
        console.log(`${problem.kind === 'missing-directory' ? 'no directory' : problem.kind === 'unreadable' ? 'unreadable  ' : 'orphan dir  '}  ${problem.what}`)

      console.log('')
      console.log(`${report.checked} repositories checked, ${report.problems.length} problems.`)

      /*
       * Reported, never repaired. Both kinds of mismatch have two plausible
       * fixes - restore the other half, or delete this one - and which is right
       * depends on which snapshot was the good one. A command that guessed
       * would eventually delete the only copy of something.
       */
      if (report.problems.length > 0) {
        console.log('')
        console.log('Nothing was changed. A row with no directory and a directory with no row are')
        console.log('both ordinary after a restore from mismatched snapshots, and which half to')
        console.log('trust is not something this can know.')
      }

      process.exit(report.problems.length === 0 ? 0 : 1)
    })
}

import type { CLI } from '@stacksjs/types'
import { readFileSync } from 'node:fs'
import process from 'node:process'
import { applyMirrors, planMirrors, readDeclaration } from '../Actions/Mirror/declare'

/**
 * The mirrors, from a file.
 *
 * Every mirror on the deployed instance was added by hand, which is how
 * `stacksjs/.github` came to be the one repository nobody thought to add - and
 * why the organization page it holds rendered as an organization that had
 * never written one. A command somebody has to remember to run is the same
 * failure one turn later, so the intended set is a file and this converges to
 * it on every deploy.
 *
 * `--plan` prints what would change and touches nothing. Additive either way:
 * a mirror on the instance and not in the file is reported and left alone.
 * See `app/Actions/Mirror/declare.ts` for why removal is not on offer.
 */
export default function (cli: CLI) {
  cli
    .command('mirror:apply <file>', 'Converge this instance\'s mirrors to a declared file')
    .option('--plan', 'Print what would change and do nothing', { default: false })
    .action(async (file: string, options: any) => {
      try {
        const { mirrors, error } = readDeclaration(readFileSync(String(file), 'utf8'))

        if (error) {
          console.error(`Could not read ${file}: ${error}`)
          process.exit(1)
        }

        const plan = options.plan ? await planMirrors(mirrors) : await applyMirrors(mirrors)

        if (plan.changes.length === 0)
          console.log(options.plan ? 'Nothing to do: every declared mirror is already here.' : 'Every declared mirror was already here.')

        for (const change of plan.changes)
          console.log(`${options.plan ? 'would' : 'did'}: ${change.detail}`)

        /*
         * A line that names an owner this instance does not have is early
         * rather than wrong - somebody has not created the organization yet -
         * and this runs in a deploy's pre-start, where a fatal error is a
         * release that will not start. Said out loud, and not fatal.
         */
        for (const skipped of plan.skipped)
          console.log(`skipped ${skipped.local}: ${skipped.detail}`)

        /*
         * Counted here and listed only under `--plan`.
         *
         * This instance carries a hundred and fourteen mirrors that predate the
         * file, and printing all of them on every deploy would bury the one
         * line that says what actually changed. An operator making the file
         * complete wants the list; a deploy wants the number.
         */
        if (plan.drift.length > 0) {
          console.log('')
          console.log(`${plan.drift.length} mirror(s) on this instance are not in ${file}, left alone.`)

          if (options.plan) {
            for (const local of plan.drift)
              console.log(`  ${local}`)
          }
        }

        process.exit(0)
      }
      catch (error) {
        // `console.error` rather than the logger, which writes asynchronously:
        // `process.exit` below can beat it to the terminal and turn a failure
        // into a silent exit code 1.
        console.error(`Could not apply ${file}:`)
        console.error(error instanceof Error ? (error.stack ?? error.message) : String(error))
        process.exit(1)
      }
    })
}

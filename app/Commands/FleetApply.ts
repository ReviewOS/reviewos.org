import type { CLI } from '@stacksjs/types'
import { readFileSync } from 'node:fs'
import process from 'node:process'
import { applyFleet, planFleet, readDeclaration } from '../Actions/Runner/declare'

/**
 * The fleet, from a file.
 *
 * A fleet that cannot be declared is a fleet that drifts: pools get created
 * during an incident, a queue is paused on a Friday and stays paused, and six
 * months later nobody can say what the intended shape was. This makes the
 * intended shape a file in a repository, with the ordinary consequence - it is
 * reviewed, it has a history, and applying it twice does nothing the second
 * time.
 *
 * `--plan` prints what would change and touches nothing, which is the half an
 * operator runs on the morning of a change. A tool whose preview could alter
 * something is a tool nobody runs on the day it matters.
 */
export default function (cli: CLI) {
  cli
    .command('fleet:apply <file>', 'Converge the runner fleet to a declared file')
    .option('--plan', 'Print what would change and do nothing', { default: false })
    .action(async (file: string, options: any) => {
      try {
        const { fleet, error } = readDeclaration(readFileSync(String(file), 'utf8'))

        if (error) {
          console.error(`Could not read ${file}: ${error}`)
          process.exit(1)
        }

        const plan = options.plan ? await planFleet(fleet) : await applyFleet(fleet)

        if (plan.changes.length === 0)
          console.log(options.plan ? 'Nothing to do: the fleet already matches this file.' : 'The fleet already matched this file.')

        for (const change of plan.changes)
          console.log(`${options.plan ? 'would' : 'did'}: ${change.detail}`)

        if (plan.drift.length > 0) {
          /*
           * Reported and never removed. A declaration that deleted whatever it
           * did not mention would, on the day somebody applied a partial file,
           * drain the fleet - and the failure mode of a convergence tool has to
           * be "nothing happened" rather than "everything went away".
           */
          console.log('')
          console.log('On this instance and not in the file, left alone:')

          for (const change of plan.drift)
            console.log(`  ${change.what} ${change.subject}: ${change.detail}`)
        }

        process.exit(0)
      }
      catch (error) {
        console.error(`Could not apply ${file}: ${error instanceof Error ? error.message : String(error)}`)
        process.exit(1)
      }
    })
}

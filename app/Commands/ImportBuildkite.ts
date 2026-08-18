import type { CLI } from '@stacksjs/types'
import { readFileSync, writeFileSync } from 'node:fs'
import process from 'node:process'
import { describeTranslation, translatePipeline } from '../Actions/Import/buildkite'

/**
 * Translate a Buildkite `pipeline.yml` into a workflow.
 *
 * A command rather than an endpoint because it touches no repository: it reads
 * a file somebody has in front of them and writes another, which is the shape
 * of a migration tool. Nothing here is stored, so running it twice costs
 * nothing and running it on a pipeline that is not yours is somebody's own
 * business.
 *
 * **The report goes to stderr and the workflow to stdout**, so
 * `buddy import:buildkite pipeline.yml > .reviewos/workflows/ci.yml` produces a
 * file and still shows what changed meaning. A translation whose caveats went
 * into the file as comments would be caveats nobody reads twice.
 */
export default function (cli: CLI) {
  cli
    .command('import:buildkite <file>', 'Translate a Buildkite pipeline into a workflow, with a report')
    .option('--out <path>', 'Write the workflow here instead of stdout', { default: '' })
    .option('--name <name>', 'What to call the workflow', { default: '' })
    .action(async (file: string, options: any) => {
      try {
        const source = readFileSync(file, 'utf8')
        const { workflow, report } = translatePipeline(source, { name: String(options.name ?? '') })

        const lines = describeTranslation(report)

        console.error(`${report.steps.length} steps read from ${file}`)

        for (const line of lines)
          console.error(line)

        if (report.losses.length > 0) {
          /*
           * Said again at the end, because the per-step list is long and the
           * things with no equivalent are the ones somebody has to decide
           * about. A report whose important half scrolled past is a report.
           */
          console.error('')
          console.error('No equivalent here, decide what to do about each:')

          for (const loss of report.losses)
            console.error(`  ${loss}`)
        }

        if (options.out) {
          writeFileSync(String(options.out), workflow)
          console.error('')
          console.error(`Written to ${options.out}`)
        }
        else {
          console.log(workflow)
        }

        process.exit(0)
      }
      catch (error) {
        console.error(`Could not translate ${file}: ${error instanceof Error ? error.message : String(error)}`)
        process.exit(1)
      }
    })
}

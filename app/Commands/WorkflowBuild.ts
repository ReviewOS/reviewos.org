import type { CLI } from '@stacksjs/types'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import process from 'node:process'
import { checkDeterminism } from '../Actions/Workflow/determinism'
import { parseWorkflow } from '../Actions/Workflow/parse'
import { toYaml } from '../Actions/Workflow/sdk'

/**
 * Build a workflow written as a program.
 *
 * The second front door: a `.ts` file that exports a workflow, turned into the
 * YAML this instance already reads. Emitting YAML rather than rows is what
 * keeps this a front door rather than a second product - the parser, the
 * conformance table and every refusal are shared, and the output is a file a
 * person can read in a review.
 *
 * Three checks before anything is written, in the order that fails fastest:
 * what the program is allowed to read, whether two builds of it agree, and
 * whether the workflow it produced is one this instance would register.
 */
export default function (cli: CLI) {
  cli
    .command('workflow:build <file>', 'Build a workflow written as a TypeScript program')
    .option('--out <path>', 'Write it here instead of stdout', { default: '' })
    .action(async (file: string, options: any) => {
      const path = resolve(String(file))

      try {
        const source = readFileSync(path, 'utf8')
        const problems = checkDeterminism(source)

        if (problems.length > 0) {
          console.error(`${path} reads something that is not the same twice:`)

          for (const problem of problems)
            console.error(`  line ${problem.line}: \`${problem.found}\` - ${problem.reason}`)

          /*
           * Refused rather than warned. A workflow whose graph depends on the
           * machine that built it is one nobody can reproduce, and the whole
           * value of this front door is that its output is reviewable.
           */
          process.exit(1)
        }

        /*
         * Built twice, and the second import is cache-busted so it is a real
         * second build rather than the module registry handing back the first
         * one's exports. This is the layer the types and the check above cannot
         * replace: a program that reads something nobody thought of still
         * produces two different documents, and two builds is what notices.
         */
        const build = async (): Promise<string> => {
          const module = await import(`${path}?rebuild=${crypto.randomUUID()}`)
          const workflow = module.default ?? module.workflow

          if (!workflow || typeof workflow !== 'object')
            throw new Error('the file must export a workflow as its default export')

          return toYaml(workflow)
        }

        const first = await build()
        const second = await build()

        if (first !== second) {
          const lines = first.split('\n')
          const others = second.split('\n')
          const at = lines.findIndex((line, index) => line !== others[index]) + 1

          console.error(`Two builds of this program produced different workflows, first differing at line ${at}. Something in it is not the same twice.`)
          process.exit(1)
        }

        const parsed = parseWorkflow(first, 'workflow.yml')

        if (!parsed.ok || parsed.errors.length > 0) {
          console.error('The workflow this program produced is not one this instance would register:')

          for (const error of parsed.errors)
            console.error(`  ${String((error as { message?: unknown }).message ?? error)}`)

          process.exit(1)
        }

        for (const warning of parsed.warnings)
          console.error(`note: \`${String(warning.key)}\` ${String(warning.message)}`)

        if (options.out) {
          writeFileSync(String(options.out), first)
          console.error(`Written to ${options.out}`)
        }
        else {
          console.log(first)
        }

        process.exit(0)
      }
      catch (error) {
        console.error(`Could not build ${path}: ${error instanceof Error ? error.message : String(error)}`)
        process.exit(1)
      }
    })
}

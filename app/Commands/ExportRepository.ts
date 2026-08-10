import type { CLI } from '@stacksjs/types'
import { join } from 'node:path'
import process from 'node:process'
import { writeExport } from '../Actions/Import/export'

/**
 * Write a repository and everything about it to a directory somebody can read.
 *
 * The half of migration that makes the other half trustworthy. A forge that is
 * hard to leave is a forge people are right to distrust - and the trust is not
 * earned by having an export, it is earned by having one that works without
 * this codebase.
 *
 * What comes out:
 *
 * - `git/` - a real bare repository. `git clone` against it works, so the most
 *   important half needs no tooling at all to read.
 * - `manifest.json` - what this is, in what format version, and how much of it.
 * - `issues.json`, `pull-requests.json` - the conversations, keyed by number
 *   and naming people by handle.
 *
 * A directory rather than an archive, deliberately. Tarring it is one command
 * somebody already knows, and a directory can be inspected, diffed and
 * partially copied - which is what people actually do with an export before
 * they trust it.
 */
export default function (cli: CLI) {
  cli
    .command('export:repository <owner/name>', 'Write a repository and its metadata to a directory')
    .option('--to <path>', 'Where to write it', { default: '' })
    .action(async (target: string, options: any) => {
      try {
        const [ownerHandle, name] = String(target).split('/')

        if (!ownerHandle || !name)
          throw new Error('Name the repository as owner/name')

        const destination = String(options.to ?? '') || join(process.cwd(), `${ownerHandle}-${name}-export`)
        const written = await writeExport(ownerHandle, name, destination)

        console.log(`Exported ${target} to ${destination}`)
        console.log(`  ${written.counts.issues} issues, ${written.counts.pull_requests} pull requests, `
          + `${written.counts.comments} comments, ${written.counts.review_threads} review threads`)
        console.log('')
        console.log(`  git clone ${join(destination, 'git')}`)

        process.exit(0)
      }
      catch (error) {
        console.error('Could not export the repository:')
        console.error(error instanceof Error ? (error.stack ?? error.message) : String(error))
        process.exit(1)
      }
    })
}


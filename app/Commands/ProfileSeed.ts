import type { CLI } from '@stacksjs/types'
import { readFileSync } from 'node:fs'
import process from 'node:process'
import { seedProfile } from '../Actions/Profile/seed'

/**
 * Write an owner's profile page, if nobody has written one.
 *
 * The instance this project runs had a blank page at `/reviewos` because the
 * repository behind it did not exist, and creating it was a thing somebody had
 * to remember - the same shape as the mirror nobody added. So the content is a
 * file in this repository and the deploy runs this.
 *
 * Idempotent, and specifically **it never overwrites**: once the repository has
 * a commit in it this does nothing, forever. A deploy step that rewrote the
 * page on every release would quietly undo an edit somebody made through the
 * interface, which is worse than the blank page it was fixing.
 */
export default function (cli: CLI) {
  cli
    .command('profile:seed', 'Write an owner\'s profile page from a file, if it has none')
    .option('--owner <handle>', 'The organization or user whose page this is')
    .option('--file <path>', 'The markdown to commit as README.md')
    .option('--name <name>', 'The repository to write it in', { default: '.profile' })
    .action(async (options: { owner?: string, file?: string, name?: string }) => {
      try {
        const owner = String(options.owner ?? '').trim()
        const file = String(options.file ?? '').trim()

        if (!owner || !file) {
          console.error('Both --owner and --file are required, for example: profile:seed --owner reviewos --file profile/README.md')
          process.exit(1)
        }

        const outcome = await seedProfile({
          owner,
          name: options.name,
          content: readFileSync(file, 'utf8'),
        })

        if (outcome.done === 'seeded')
          console.log(`Wrote ${outcome.repository} at ${outcome.commit.slice(0, 8)} from ${file}`)

        if (outcome.done === 'already-written')
          console.log(`${outcome.repository} already has a page in it; left alone.`)

        /*
         * Neither of the two below is a failed deploy.
         *
         * An owner this instance does not have is a line of configuration that
         * is early rather than wrong, and a page that could not be written is
         * a blank profile - which is what it was already. This runs before the
         * process starts, and neither is worth refusing to serve the site over.
         */
        if (outcome.done === 'no-owner')
          console.log(`No organization or user called ${owner} on this instance; nothing to write.`)

        if (outcome.done === 'failed')
          console.error(`Could not write ${outcome.repository}: ${outcome.reason}`)

        process.exit(0)
      }
      catch (error) {
        // `console.error` rather than the logger, which writes asynchronously:
        // `process.exit` can beat it to the terminal and turn a failure into a
        // silent exit code.
        console.error('Could not write the profile page:')
        console.error(error instanceof Error ? (error.stack ?? error.message) : String(error))
        process.exit(1)
      }
    })
}

import type { CLI } from '@stacksjs/types'
import process from 'node:process'
import { capture, defaultBase, instanceIsUp } from '../Actions/Screenshot/capture'
import { SCREENSHOT_DIRECTORY, SHOTS } from '../Actions/Screenshot/shots'

/**
 * Photograph the interface, from the list in `app/Actions/Screenshot/shots.ts`.
 *
 * The point is repeatability rather than convenience. Screenshots on a
 * marketing page are the one asset that cannot fail a test: the interface
 * moves, the pictures do not, and nobody notices until somebody arrives from a
 * link and finds the product does not look like its own website. A command that
 * regenerates them is what makes that a five-second fix instead of an
 * afternoon with a cropping tool.
 *
 * Needs an instance running with data worth photographing - `./buddy dev`, and
 * a repository that is not empty. It says so rather than producing five
 * pictures of an error page.
 */
export default function (cli: CLI) {
  cli
    .command('screenshot', 'Photograph the interface for the marketing page and the docs')
    .option('--url <url>', 'The instance to photograph', { default: '' })
    .option('--only <name>', 'Just this one, by name', { default: '' })
    .action(async (options: any) => {
      const base = String(options.url || defaultBase())
      const only = String(options.only ?? '')
      const wanted = only ? SHOTS.filter(shot => shot.name === only) : SHOTS

      if (wanted.length === 0) {
        console.error(`No shot called ${only}. Known: ${SHOTS.map(shot => shot.name).join(', ')}`)
        process.exit(1)
      }

      if (!(await instanceIsUp(base))) {
        console.error(`Nothing is answering at ${base}.`)
        console.error('Start one with `./buddy dev`, or point this at another with --url.')
        process.exit(1)
      }

      console.error(`Photographing ${base}`)
      console.error('')

      let failed = 0

      for (const shot of wanted) {
        const result = await capture(shot, base)

        if (result.ok) {
          console.error(`  ${shot.name.padEnd(22)} ${String(result.width)}x${String(result.height)}  ${Math.round((result.bytes ?? 0) / 1024)}KB  ${(result.ms / 1000).toFixed(1)}s`)
        }
        else {
          failed += 1
          console.error(`  ${shot.name.padEnd(22)} FAILED: ${result.reason}`)
        }
      }

      console.error('')
      console.error(`Written to ${SCREENSHOT_DIRECTORY}/`)

      if (failed > 0) {
        // Non-zero, so a pipeline that regenerates these notices. The pictures
        // that did work are still written: a partial refresh is useful, a
        // silent one is not.
        console.error(`${failed} could not be taken; the existing files for those were left alone.`)
        process.exit(1)
      }

      process.exit(0)
    })
}

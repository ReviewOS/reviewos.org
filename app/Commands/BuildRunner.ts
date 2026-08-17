import type { CLI } from '@stacksjs/types'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import process from 'node:process'

/**
 * Compile the runner into a program you can copy to a machine.
 *
 * A fleet is machines that are not this one, and "install the whole
 * application, its dependencies and a database driver" is not something to ask
 * of a build agent. This produces one file with no runtime to install: copy it,
 * give it a URL and a credential, and it takes work.
 *
 * **It is the same executor `./buddy runner:local` uses**, which is the point.
 * A second implementation for remote machines would be a second set of bugs,
 * and the one that runs on the fleet would be the one nobody tests. It compiles
 * at all because nothing under `app/Actions/Runner/` touches the framework or
 * the database - a runner that needed a database connection could only run next
 * to the control plane.
 */

interface BuildOptions {
  target?: string
  out?: string
}

/** What Bun calls each platform, against what an operator calls it. */
const TARGETS: Record<string, string> = {
  'linux-x64': 'bun-linux-x64',
  'linux-arm64': 'bun-linux-arm64',
  'macos-x64': 'bun-darwin-x64',
  'macos-arm64': 'bun-darwin-arm64',
  'windows-x64': 'bun-windows-x64',
  // What this machine is, for somebody who just wants to try it.
  'host': '',
}

export default function (cli: CLI) {
  cli
    .command('build:runner', 'Compile the runner into a single binary for a fleet machine')
    .option('--target <target>', `One of: ${Object.keys(TARGETS).join(', ')}`, { default: 'host' })
    .option('--out <directory>', 'Where to write it', { default: 'dist/runner' })
    .action(async (options: BuildOptions) => {
      const name = String(options.target ?? 'host')
      const target = TARGETS[name]

      if (target === undefined) {
        console.error(`\`${name}\` is not a target. The targets are: ${Object.keys(TARGETS).join(', ')}.`)
        process.exitCode = 1
        return
      }

      const directory = resolve(String(options.out ?? 'dist/runner'))

      mkdirSync(directory, { recursive: true })

      const outfile = resolve(directory, name === 'windows-x64' ? 'reviewos-runner.exe' : 'reviewos-runner')

      const child = Bun.spawn([
        'bun',
        'build',
        'app/Actions/Runner/standalone.ts',
        '--compile',
        ...(target ? ['--target', target] : []),
        '--outfile',
        outfile,
      ], { stdout: 'inherit', stderr: 'inherit' })

      const code = await child.exited

      if (code !== 0) {
        process.exitCode = code
        return
      }

      const size = Bun.file(outfile).size

      console.log('')
      console.log(`Wrote ${outfile} (${(size / 1024 / 1024).toFixed(0)} MB, ${name}).`)
      console.log('')
      console.log('On the machine that will run jobs:')
      console.log('')
      console.log('  ./reviewos-runner --url https://reviewos.example --token <credential>')
      console.log('')
      console.log('Make the credential on the instance with `buddy runner:local --register --name <machine>`.')
      console.log('Steps run as the user who starts it, with no isolation.')
    })
}

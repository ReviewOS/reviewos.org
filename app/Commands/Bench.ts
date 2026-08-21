import type { CLI } from '@stacksjs/types'
import process from 'node:process'
import { CORPUS, changedLines, cloneCommands, corpusEntry } from '../Actions/Bench/corpus'
import { runGit } from '../Actions/Git/git'

/**
 * Measure the diff engine against the fixed corpus.
 *
 * The one rule this exists to enforce: **a number is reported with the cache
 * state it was taken in.** Git's object cache is worth about a hundredfold on
 * these ranges - far more than any change to this codebase is likely to be - so
 * a cold run and a warm run of identical code disagree by more than a
 * regression would. A benchmark that does not say which it was is a benchmark
 * that can prove anything, and one that did exactly that sent three days of
 * diagnosis after a bottleneck that was never there.
 *
 * So each range is timed twice: once as it lies, then again immediately, and
 * both numbers are printed. The second is the one to compare across commits;
 * the first is the one a reader waiting on a cold instance actually feels.
 */
export default function (cli: CLI) {
  cli
    .command('bench', 'Time the diff engine against the fixed corpus')
    .option('--repository <path>', 'A clone of the corpus repository', { default: 'storage/repos/reviewos/linux.git' })
    .option('--only <name>', 'Just this entry', { default: '' })
    .option('--verify', 'Check the manifest counts against git rather than timing', { default: false })
    .action(async (options: any) => {
      const path = String(options.repository)
      const only = String(options.only ?? '')
      const chosen = only ? corpusEntry(only) : null
      const entries = only ? (chosen ? [chosen] : []) : [...CORPUS]

      if (entries.length === 0) {
        console.error(`No corpus entry called ${only}. Known: ${CORPUS.map(one => one.name).join(', ')}`)
        process.exit(1)
      }

      const present = await runGit(path, ['rev-parse', '--is-bare-repository'], { timeoutMs: 5000 })

      if (!present.ok) {
        console.error(`No repository at ${path}.`)
        console.error('Clone one, from either source:')

        for (const command of cloneCommands(path))
          console.error(`  ${command}`)
        process.exit(1)
      }

      if (options.verify) {
        let wrong = 0

        for (const entry of entries) {
          const result = await runGit(path, ['diff', '--shortstat', '--no-renames', `${entry.base}..${entry.head}`], {
            timeoutMs: 300_000,
            priority: 'background',
          })

          const found = /(\d+) files? changed(?:, (\d+) insertions?...)?(?:, (\d+) deletions?...)?/.exec(result.stdout)
          const files = Number(found?.[1] ?? 0)
          const additions = Number(found?.[2] ?? 0)
          const deletions = Number(found?.[3] ?? 0)
          const agrees = files === entry.files && additions === entry.additions && deletions === entry.deletions

          if (!agrees)
            wrong += 1

          console.error(`  ${entry.name.padEnd(8)} ${agrees ? 'ok' : `MANIFEST SAYS ${entry.files}/${entry.additions}/${entry.deletions}, GIT SAYS ${files}/${additions}/${deletions}`}`)
        }

        // Non-zero, because a manifest that has drifted is worse than none: the
        // numbers beside a sha are what a reader trusts without checking.
        process.exit(wrong > 0 ? 1 : 0)
      }

      console.error(`Corpus: ${path}`)
      console.error('')
      console.error('  entry     lines      cold      warm')

      for (const entry of entries) {
        const time = async (): Promise<number> => {
          const started = Bun.nanoseconds()

          await runGit(path, ['diff', '--no-renames', `${entry.base}..${entry.head}`], {
            timeoutMs: 600_000,
            maxBytes: 2 * 1024 * 1024 * 1024,
            priority: 'background',
          })

          return (Bun.nanoseconds() - started) / 1_000_000
        }

        const cold = await time()
        const warm = await time()

        console.error(`  ${entry.name.padEnd(8)} ${String(changedLines(entry)).padStart(9)} ${`${cold.toFixed(0)}ms`.padStart(9)} ${`${warm.toFixed(0)}ms`.padStart(9)}`)
      }

      console.error('')
      console.error('Compare warm against warm across commits: the cold column moves with the page')
      console.error('cache and will happily show a regression that is not there.')
      process.exit(0)
    })
}

import type { CLI } from '@stacksjs/types'
import process from 'node:process'
import { db } from '@stacksjs/database'

/**
 * Measure what every repository is written in, and who wrote it.
 *
 * The measures are queued from a push (`ProcessPushJob`) and from a mirror sync
 * (`MirrorSyncJob`), which covers a repository that changes. It does not cover
 * the two cases that matter on an instance somebody has just fixed: a
 * repository imported before the measures existed, and - the reason this
 * command was written - a repository whose measurement was queued into a worker
 * that could not run it.
 *
 * On the deployed instance both were true at once. Every language row was
 * missing, so `/explore` rendered two dozen cards with nothing on them but a
 * date, and no push was coming to fix it: these are mirrors, and a mirror only
 * changes when the sweep fetches it. Waiting for that would have measured them
 * eventually and told nobody when.
 *
 * **Runs the measurements rather than enqueuing them.** A backfill is something
 * an operator runs while watching, usually right after fixing whatever stopped
 * the queue, and a command that queues work and exits leaves them looking at
 * the same empty page wondering whether it worked. It also means this is
 * useful on an instance whose worker is still broken, which is exactly the
 * instance that needs it.
 *
 * Safe on a live instance, and safe to interrupt. Each repository's rows are
 * replaced in place, so a run that stops halfway leaves the ones it reached
 * measured and the rest as they were - and running it again is a no-op for
 * everything that has not changed since.
 */
export default function (cli: CLI) {
  cli
    .command('repo:measure', 'Measure the languages and contributors of every repository')
    .option('--repository <id>', 'Only this repository, by id', { default: 0 })
    .option('--languages', 'Only the language breakdown', { default: false })
    .option('--contributors', 'Only the contributor counts', { default: false })
    .action(async (options: any) => {
      const only = Number(options.repository ?? 0)

      // Neither flag means both, which is what a backfill wants. Naming one
      // narrows it; naming both is the same as naming neither.
      const wantLanguages = !options.contributors || Boolean(options.languages)
      const wantContributors = !options.languages || Boolean(options.contributors)

      const query = db.selectFrom('repositories').select(['id', 'name'])

      const repositories = only > 0
        ? await query.where('id', '=', only).execute()
        : await query.orderBy('id', 'asc').execute()

      if (repositories.length === 0) {
        console.error(only > 0 ? `No repository with id ${only}.` : 'No repositories to measure.')
        process.exit(only > 0 ? 1 : 0)
      }

      /*
       * The two handlers, typed by what they are rather than by what a job may
       * be. `Job.handle` is `string | JobHandler | undefined` because a job is
       * allowed to delegate to a named action instead of carrying a function;
       * these two carry functions, and their payload and result are written a
       * few lines into each file.
       */
      const measureLanguages = (await import('../Jobs/MeasureLanguagesJob')).default
        .handle as (payload: { repositoryId: number }) => Promise<{ languages: number }>

      const measureContributors = (await import('../Jobs/MeasureContributorsJob')).default
        .handle as (payload: { repositoryId: number }) => Promise<{ contributors: number }>

      const started = Date.now()
      let measured = 0
      let empty = 0

      for (const repository of repositories) {
        const id = Number(repository.id)
        const parts: string[] = []

        /*
         * One repository's failure is not the run's.
         *
         * The commonest reason a measurement comes back empty is an empty
         * repository - a mirror registered but never fetched - which is a fact
         * about that repository rather than a problem with this command. The
         * next commonest is a repository whose directory is missing on this
         * node, and stopping on the first of those would mean an operator
         * backfilling an instance one `--repository` at a time.
         */
        try {
          if (wantLanguages) {
            const { languages } = await measureLanguages({ repositoryId: id })
            parts.push(`${languages} language${languages === 1 ? '' : 's'}`)
          }

          if (wantContributors) {
            const { contributors } = await measureContributors({ repositoryId: id })
            parts.push(`${contributors} contributor${contributors === 1 ? '' : 's'}`)
          }
        }
        catch (error) {
          console.error(`  ${repository.name}: ${error instanceof Error ? error.message : String(error)}`)
          continue
        }

        // Counted separately, because "measured 24" over an instance whose
        // repositories are all empty is a run that did nothing, said well.
        if (parts.every(part => part.startsWith('0 ')))
          empty += 1
        else
          measured += 1

        console.log(`  ${repository.name}: ${parts.join(', ')}`)
      }

      const seconds = Math.round((Date.now() - started) / 1000)

      console.log(
        `\nMeasured ${measured} repositor${measured === 1 ? 'y' : 'ies'} in ${seconds}s`
        + (empty > 0 ? `, ${empty} had nothing to measure` : ''),
      )

      process.exit(0)
    })
}

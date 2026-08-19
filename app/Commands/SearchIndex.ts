import type { CLI } from '@stacksjs/types'
import process from 'node:process'
import { db } from '@stacksjs/database'
import { buildShard, indexedRepositories, removeShard, shardPath, writeShard } from '../Actions/CodeIndex/build'
import { ownerHandleFor } from '../Actions/Repo/owner'

/**
 * Build the code-search index for every repository, or one of them.
 *
 * A push queues this per repository; this is the command for the two cases a
 * queue does not cover - an instance that had repositories before the index
 * existed, and an operator who wants it rebuilt now rather than on next push.
 *
 * Safe to run on a live instance. A shard is written to a temporary file and
 * renamed, so a search running at the same time reads the old one whole or the
 * new one whole; and because the index only ever narrows what is grepped, even
 * a half-finished run leaves every search correct.
 */
export default function (cli: CLI) {
  cli
    .command('search:index', 'Build the trigram index used by instance-wide code search')
    .option('--repository <id>', 'Only this repository, by id', { default: 0 })
    .option('--prune', 'Also remove shards for repositories that are gone', { default: false })
    .action(async (options: any) => {
      const only = Number(options.repository ?? 0)

      const query = db
        .selectFrom('repositories')
        .select(['id', 'name', 'owner_type', 'owner_id', 'default_branch'])

      const repositories = only > 0
        ? await query.where('id', '=', only).execute()
        : await query.execute()

      if (repositories.length === 0) {
        console.error(only > 0 ? `No repository with id ${only}.` : 'No repositories to index.')
        process.exit(only > 0 ? 1 : 0)
      }

      const { repositoryPath } = await import('../Actions/Git/storage')

      let indexed = 0
      let files = 0
      let failed = 0

      const started = Date.now()

      for (const repository of repositories) {
        const handle = await ownerHandleFor(repository)
        const resolved = handle ? repositoryPath(handle, String(repository.name)) : { ok: false as const }

        if (!handle || !resolved.ok) {
          failed += 1
          console.error(`  skipped ${repository.name}: no path on disk`)
          continue
        }

        const shard = await buildShard(resolved.path!, String(repository.default_branch ?? 'main'))

        if (!shard) {
          failed += 1
          console.error(`  skipped ${handle}/${repository.name}: could not read the tree`)
          continue
        }

        await writeShard(Number(repository.id), shard)

        indexed += 1
        files += shard.paths.length

        console.error(`  ${handle}/${repository.name}: ${shard.paths.length} files, ${shard.skipped} skipped`)
      }

      if (options.prune) {
        const live = new Set(repositories.map((repository: { id: unknown }) => Number(repository.id)))

        for (const id of await indexedRepositories()) {
          // Only when indexing everything: with `--repository` the other shards
          // are not stale, they are simply not this run's business.
          if (only > 0 || live.has(id))
            continue

          await removeShard(id)
          console.error(`  removed the shard for repository ${id}, which is gone`)
        }
      }

      console.error('')
      console.error(`${indexed} repositories, ${files} files, in ${((Date.now() - started) / 1000).toFixed(1)}s.`)

      if (failed > 0)
        console.error(`${failed} could not be indexed; they are searched in full instead of being narrowed.`)

      console.error(`Shards are under ${shardPath(0).replace(/0\.idx$/, '')}`)
      process.exit(0)
    })
}

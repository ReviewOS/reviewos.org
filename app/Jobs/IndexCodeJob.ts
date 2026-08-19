import { Job } from '@stacksjs/queue'
import { db } from '@stacksjs/database'
import { buildShard, writeShard } from '../Actions/CodeIndex/build'

/**
 * Build one repository's code-search shard.
 *
 * On the `search` queue beside `MeasureLanguages`, and never on the request
 * path, for the same reason: it reads the whole tree. A push that failed
 * because somebody committed a large repository would be a push that should
 * have succeeded.
 *
 * The index is a filter and not the answer - see `app/Actions/CodeIndex` - so a
 * shard that fails to build, or that is behind, costs speed rather than
 * correctness. That is what makes it safe to run this on a queue and let a
 * search run against whatever is on disk in the meantime: a stale shard is
 * corrected by the paths that changed since it was built, and a missing one
 * means that repository is searched in full.
 */
export default new Job({
  name: 'IndexCode',
  description: 'Build a repository\'s trigram index for instance-wide code search',
  queue: 'search',
  tries: 2,

  async handle(payload: { repositoryId?: number } = {}): Promise<{ files: number }> {
    const repositoryId = Number(payload?.repositoryId ?? 0)

    if (!Number.isInteger(repositoryId) || repositoryId <= 0)
      return { files: 0 }

    const repository = await db
      .selectFrom('repositories')
      .select(['name', 'owner_type', 'owner_id', 'default_branch'])
      .where('id', '=', repositoryId)
      .executeTakeFirst()

    if (!repository)
      return { files: 0 }

    const { repositoryPath } = await import('../Actions/Git/storage')
    const { ownerHandleFor } = await import('../Actions/Repo/owner')
    const handle = await ownerHandleFor(repository)

    if (!handle)
      return { files: 0 }

    const resolved = repositoryPath(handle, String(repository.name))

    if (!resolved.ok)
      return { files: 0 }

    const shard = await buildShard(resolved.path!, String(repository.default_branch ?? 'main'))

    if (!shard)
      return { files: 0 }

    await writeShard(repositoryId, shard)

    return { files: shard.paths.length }
  },
})

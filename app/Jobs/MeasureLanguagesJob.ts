import { Job } from '@stacksjs/queue'
import { breakdown, parseTree } from '../Actions/Explore/languages'
import { runGit } from '../Actions/Git/git'

/**
 * Work out what a repository is written in, and store the breakdown.
 *
 * On the `search` queue and never on the request path, for the same reason the
 * reindex is: it reads the whole tree, and a push that failed because somebody
 * committed a large repository would be a push that should have succeeded.
 *
 * `git ls-tree -r --long` gives every blob and its size in one call, which is
 * the cheap way to do this - the expensive way is walking the tree in
 * TypeScript and asking git for each object, and on a repository with forty
 * thousand files that is forty thousand processes.
 *
 * Rows are replaced rather than merged. A language that has left the repository
 * must leave the breakdown, and merging keeps it there forever - which is how a
 * repository rewritten in Rust goes on being listed under Ruby.
 */
export default new Job({
  name: 'MeasureLanguagesJob',
  description: 'Measure a repository\'s language breakdown from its tree',
  queue: 'search',
  tries: 2,

  async handle(payload: { repositoryId?: number } = {}): Promise<{ languages: number }> {
    const repositoryId = Number(payload?.repositoryId ?? 0)

    if (!Number.isInteger(repositoryId) || repositoryId <= 0)
      return { languages: 0 }

    const repository = await db
      .selectFrom('repositories')
      .select(['name', 'owner_type', 'owner_id', 'default_branch'])
      .where('id', '=', repositoryId)
      .executeTakeFirst()

    if (!repository)
      return { languages: 0 }

    const { repositoryPath } = await import('../Actions/Git/storage')
    const handle = await ownerHandle(repository)
    const resolved = repositoryPath(handle, String(repository.name))

    if (!resolved.ok)
      return { languages: 0 }

    const ref = String(repository.default_branch ?? 'main')

    /*
     * A generous timeout and a bounded output.
     *
     * The tree of a very large repository is megabytes of text, and this job is
     * allowed to be slow - but not unbounded, because a repository with a
     * million files would hold a worker for as long as git takes to print them.
     * The 10 MiB `maxBytes` default makes the bound real: past it the listing
     * is cut and the breakdown is computed over what fit, which for a
     * percentage breakdown of the first hundred thousand files is the same
     * answer anybody needed.
     */
    const listed = await runGit(resolved.path!, ['ls-tree', '-r', '--long', ref], { timeoutMs: 120_000, priority: 'background' })

    if (!listed.ok) {
      // An empty repository has no tree and no languages, which is a fact
      // rather than a failure - and the commonest reason this is reached.
      return { languages: 0 }
    }

    const languages = breakdown(parseTree(listed.stdout))

    /*
     * Replaced in one go.
     *
     * Not wrapped in a transaction, deliberately: the window where a breakdown
     * is briefly empty is a card without a language on it for a moment, and the
     * alternative on this codebase's query builder is a transaction around a
     * loop of inserts on a job that runs after every push. The cost of the
     * simpler thing is a cosmetic flicker nobody will see.
     */
    await db.deleteFrom('repository_languages').where('repository_id', '=', repositoryId).execute()

    for (const entry of languages) {
      await db.insertInto('repository_languages').values({
        repository_id: repositoryId,
        language: entry.language,
        bytes: entry.bytes,
        percent: entry.percent,
      }).execute()
    }

    return { languages: languages.length }
  },
})

/** The handle of whoever owns a repository row, user or organization. */
async function ownerHandle(repository: { owner_type: unknown, owner_id: unknown }): Promise<string> {
  const table = String(repository.owner_type) === 'organization' ? 'organizations' : 'users'

  const row = await db
    .selectFrom(table)
    .select(['handle'])
    .where('id', '=', Number(repository.owner_id))
    .executeTakeFirst()

  return String(row?.handle ?? '')
}

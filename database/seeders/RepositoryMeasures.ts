import { db, Seeder } from '@stacksjs/database'

/**
 * Measure what the seeded repositories are written in, and who wrote them.
 *
 * `repository_languages` and `repository_contributors` are both derived: they
 * are not written when a repository is created but when something has looked
 * at its tree. `ProcessPushJob` is what normally triggers that, and the
 * seeders build their bare repositories by calling `initBare` and
 * `createCommit` directly, so no push ever happens and nothing ever measures
 * them. A freshly seeded instance therefore had no language on any repository
 * and no contributor on any of them either.
 *
 * Which made a fix in the roadmap unobservable. `02-git-hosting.md` records
 * that `featured.ts` called `innerJoin` with three arguments where the query
 * builder needs four, that the throw was swallowed, and that **no repository on
 * the explore or featured lists had ever shown a language**. That query is
 * fixed; the table it reads was still empty, so the symptom was unchanged and
 * the next person to look would have gone hunting for a second query bug. The
 * same shape as `CheckRun`'s invented shas, one table along.
 *
 * ## Why it runs the jobs rather than writing rows
 *
 * The breakdown is `git ls-tree -r --long` parsed by
 * `app/Actions/Explore/languages.ts`, and the contributor list is a walk of the
 * log. Writing plausible rows here would mean inventing percentages that do not
 * add up to what is actually in the tree, and then the explore filter would
 * list a repository under a language whose files are not in it. Running the
 * real measurement over the real tree cannot disagree with itself.
 *
 * `app/Commands/MeasureRepositories.ts` already does exactly this for an
 * instance whose repositories predate the measures, and it calls the handlers
 * inline rather than queueing them, because a command that queues work and
 * exits leaves somebody watching an empty table. A seeder has the same problem,
 * so it takes the same route.
 */
export default class RepositoryMeasures extends Seeder {
  /**
   * Last, after everything that creates a repository.
   *
   * `RepositoryGit` is 12 and `StackedChange` is 13, and the stack
   * demonstration is a repository too - measuring at 12 would leave the one
   * repository built to show off the product as the only unmeasured one.
   */
  static order = 15
  static tags = ['repositories', 'git']

  async run(): Promise<void> {
    const repositories = await db
      .selectFrom('repositories')
      .select(['id', 'name'])
      .orderBy('id')
      .execute()

    if (repositories.length === 0)
      return

    /*
     * The two handlers, typed by what they are rather than by what a job may
     * be: `Job.handle` is `string | JobHandler | undefined`, because a job can
     * name a command instead of carrying a function. Same cast as the command.
     */
    const measureLanguages = (await import('../../app/Jobs/MeasureLanguagesJob')).default
      .handle as (payload: { repositoryId: number }) => Promise<{ languages: number }>

    const measureContributors = (await import('../../app/Jobs/MeasureContributorsJob')).default
      .handle as (payload: { repositoryId: number }) => Promise<{ contributors: number }>

    const { repositoryPath } = await import('../../app/Actions/Git/storage')

    const owners = await this.owners()

    let measured = 0
    let languages = 0
    let contributors = 0

    for (const repository of repositories) {
      const id = Number(repository.id)

      // Already measured. The jobs replace rather than merge, so running them
      // again would be correct rather than harmful - but a seeder that redoes
      // its work on every `buddy setup` is a seeder that makes setup slower for
      // no change, and this one shells out to git twice per repository.
      const existing = await db
        .selectFrom('repository_languages')
        .select(['id'])
        .where('repository_id', '=', id)
        .executeTakeFirst()

      if (existing)
        continue

      /*
       * Skipped unless the bare repository is really there.
       *
       * Both jobs return zero for a repository with no tree, so this is not
       * about correctness - it is about not reporting work that did not happen.
       * The test suite leaves repository rows behind whose directories it has
       * already removed, and without this the seeder announced measuring
       * fifteen repositories when nine of them had nothing to read.
       */
      const owner = owners.get(id) ?? null
      const resolved = owner ? repositoryPath(owner, String(repository.name)) : null

      if (!resolved?.ok || !resolved.path)
        continue

      if (!(await Bun.file(`${resolved.path}/HEAD`).exists()))
        continue

      const measuredLanguages = await measureLanguages({ repositoryId: id })
      const measuredContributors = await measureContributors({ repositoryId: id })

      if (measuredLanguages.languages === 0 && measuredContributors.contributors === 0)
        continue

      measured += 1
      languages += measuredLanguages.languages
      contributors += measuredContributors.contributors
    }

    if (measured > 0)
      console.error(`[seed] measured ${measured} repositories: ${languages} language rows and ${contributors} contributor rows`)
  }

  /**
   * Each repository's owner handle, keyed by repository **id**.
   *
   * The path on disk is `{owner}/{repository}.git`, so the handle is needed to
   * resolve it, and the owner is polymorphic - `owner_type` says which table
   * `owner_id` indexes. Read in two queries rather than one per repository.
   *
   * By id and not by name, which is how this was first written. A repository
   * name is unique per owner, not per instance: the seed alone holds two called
   * `pixel` and two called `port`, so a name-keyed map hands one owner's
   * repository the other owner's handle and resolves a path that is either
   * missing or somebody else's. `app/Actions/Repo/forView.ts` records two views
   * that shipped with exactly this bug.
   */
  private async owners(): Promise<Map<number, string>> {
    const handles = { user: new Map<number, string>(), organization: new Map<number, string>() }

    for (const [kind, table] of [['user', 'users'], ['organization', 'organizations']] as const) {
      for (const row of await db.selectFrom(table).select(['id', 'handle']).limit(500).execute())
        handles[kind].set(Number(row.id), String(row.handle))
    }

    const byId = new Map<number, string>()

    const repositories = await db
      .selectFrom('repositories')
      .select(['id', 'owner_type', 'owner_id'])
      .orderBy('id')
      .execute()

    for (const repository of repositories) {
      const kind = String(repository.owner_type) === 'organization' ? 'organization' : 'user'
      const owner = handles[kind].get(Number(repository.owner_id))

      if (owner)
        byId.set(Number(repository.id), owner)
    }

    return byId
  }
}

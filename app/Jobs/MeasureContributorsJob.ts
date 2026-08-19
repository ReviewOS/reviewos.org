import { Job } from '@stacksjs/queue'
import { mergeTallies, parseShortlog } from '../Actions/Repo/contributors'
import { runGit } from '../Actions/Git/git'

/**
 * Work out who wrote a repository, and store the tally.
 *
 * On the `search` queue and never on the request path, for the reason the
 * language measure is: it walks the whole history. A `git shortlog` over two
 * hundred thousand commits is seconds of CPU, and a page that spends that on
 * every load is a page that falls over the first time somebody links to it.
 * Every forge with a contributors list precomputes it; this is that.
 *
 * `shortlog -sne` rather than `log` and counting in TypeScript: git does the
 * grouping in C and prints one line per author, so the output is bounded by the
 * number of *people* rather than by the number of commits. On a repository
 * where the log would be forty megabytes the shortlog is a few kilobytes.
 *
 * Rows are replaced wholesale, like the language breakdown's, because a history
 * rewrite can remove somebody - and merging would leave them in the list
 * forever.
 */
export default new Job({
  name: 'MeasureContributors',
  description: 'Measure a repository\'s contributors from its history',
  queue: 'search',
  tries: 2,

  async handle(payload: { repositoryId?: number } = {}): Promise<{ contributors: number }> {
    const repositoryId = Number(payload?.repositoryId ?? 0)

    if (!Number.isInteger(repositoryId) || repositoryId <= 0)
      return { contributors: 0 }

    const repository = await db
      .selectFrom('repositories')
      .select(['name', 'owner_type', 'owner_id', 'default_branch'])
      .where('id', '=', repositoryId)
      .executeTakeFirst()

    if (!repository)
      return { contributors: 0 }

    const { repositoryPath } = await import('../Actions/Git/storage')
    const handle = await ownerHandle(repository)
    const resolved = repositoryPath(handle, String(repository.name))

    if (!resolved.ok)
      return { contributors: 0 }

    const ref = String(repository.default_branch ?? 'main')

    /*
     * `--no-merges`, deliberately.
     *
     * A merge commit is authored by whoever pressed the button, and on a forge
     * that is the same handful of maintainers over and over - so counting them
     * makes the contributors list a list of who has merge rights rather than of
     * who wrote the code. Every host that shows this excludes them.
     *
     * Timed and bounded like the language measure: this job is allowed to be
     * slow and not to be unbounded.
     */
    const listed = await runGit(
      resolved.path!,
      ['shortlog', '-sne', '--no-merges', ref],
      { timeoutMs: 120_000, priority: 'background' },
    )

    if (!listed.ok) {
      // An empty repository has no history and no contributors, which is a
      // fact rather than a failure - and the commonest reason this is reached.
      return { contributors: 0 }
    }

    const tallies = mergeTallies(parseShortlog(listed.stdout))

    // Which of these addresses belong to accounts here, asked once rather than
    // per row. On a mirror the answer is usually none of them.
    const accounts = tallies.length > 0 ? await accountsByEmail(tallies.map(tally => tally.email)) : new Map()

    /*
     * Replaced in one go, and not wrapped in a transaction - the same trade the
     * language measure makes. The window where the list is briefly empty is a
     * panel section missing for a moment on a job that runs after a push, and
     * the alternative on this query builder is a transaction around a loop of a
     * hundred inserts.
     */
    await db.deleteFrom('repository_contributors').where('repository_id', '=', repositoryId).execute()

    for (const tally of tallies) {
      await db.insertInto('repository_contributors').values({
        repository_id: repositoryId,
        name: tally.name.slice(0, 200),
        email: tally.email.slice(0, 200),
        commits: tally.commits,
        user_id: accounts.get(tally.email) ?? null,
      }).execute()
    }

    return { contributors: tallies.length }
  },
})

/**
 * Which of these addresses have an account on this instance.
 *
 * One query with an `in`, because the alternative is a query per contributor
 * and a repository with a hundred of them would spend a hundred round trips on
 * a job that already walked the history.
 *
 * A miss is the ordinary case and not a failure: git's author address is chosen
 * by whoever ran the commit and most of them belong to people who have never
 * heard of this server.
 */
async function accountsByEmail(emails: readonly string[]): Promise<Map<string, number>> {
  const found = new Map<string, number>()

  try {
    const rows = await db
      .selectFrom('users')
      .select(['id', 'email'])
      .where('email', 'in', [...emails])
      .execute()

    for (const row of rows)
      found.set(String(row.email ?? '').toLowerCase(), Number(row.id))
  }
  catch {
    // A list with nobody linked is still a list. Failing the measure over this
    // would throw away the counts, which are the part that took the work.
  }

  return found
}

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

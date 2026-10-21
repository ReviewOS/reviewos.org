import { db, Seeder } from '@stacksjs/database'

/**
 * Give every issue and pull request a number its repository allocated.
 *
 * A number is the thing a reader types and a commit message cites. In the
 * product it comes from `allocateNumber` in `app/Actions/Repo/authorize.ts`,
 * which is a compare-and-swap on `repositories.issue_counter`: read the
 * current value, write `current + 1` only while it is still `current`, retry if
 * somebody else got there first. Issues and pull requests both call it, so one
 * repository has **one** sequence covering both, exactly as GitHub does.
 *
 * The model factories do not. Both declare
 * `number: faker.number.int({ min: 1, max: 200 })`, which is random per row, so
 * seeded data violated the invariant two ways at once: two pull requests in one
 * repository were numbered 166, and another repository had an issue and a pull
 * request both numbered 96. Neither is reachable from `allocateNumber`.
 *
 * A factory cannot do better, for the reason filed as stacksjs/stacks#2951: it
 * is handed `faker` and its own row, never a database, so it cannot know which
 * numbers its repository has already used. So the numbering happens here, where
 * the rows can be counted.
 *
 * ## Order
 *
 * At 10, which has to be before everything that reads a number:
 * `TimelineEntries` (11) stores a sibling's number as `reference_number`,
 * `RepositoryGit` (12) puts the number in a branch name and a commit message,
 * and `Pipelines` (14) derives idempotency keys from the commit that branch
 * points at. Renumbering after any of them would leave those pointing at
 * numbers that no longer exist.
 */
export default class IssueNumbers extends Seeder {
  static order = 10
  static tags = ['issues', 'repositories']

  async run(): Promise<void> {
    const repositories = await db
      .selectFrom('repositories')
      .select(['id', 'issue_counter'])
      .orderBy('id')
      .execute()

    if (repositories.length === 0)
      return

    let renumbered = 0
    let touched = 0

    for (const repository of repositories) {
      const repositoryId = Number(repository.id)

      const issues = await db
        .selectFrom('issues')
        .select(['id', 'number', 'created_at'])
        .where('repository_id', '=', repositoryId)
        .orderBy('id')
        .execute()

      const pulls = await db
        .selectFrom('pull_requests')
        .select(['id', 'number', 'created_at'])
        .where('repository_id', '=', repositoryId)
        .orderBy('id')
        .execute()

      if (issues.length === 0 && pulls.length === 0)
        continue

      /*
       * One sequence over both, oldest first.
       *
       * Sorted by `created_at` so the numbers run in the order the rows claim
       * to have been created, with issues before pull requests on a tie and
       * the id last. Seeded timestamps are all within a second of each other,
       * so the tiebreakers are what actually decide the order - which is fine,
       * and the reason they are spelled out rather than left to the database:
       * this has to produce the same answer on every run, or a reseed would
       * shuffle every number in the instance.
       */
      const ordered = [
        ...issues.map(row => ({ table: 'issues' as const, id: Number(row.id), number: Number(row.number), at: String(row.created_at ?? ''), rank: 0 })),
        ...pulls.map(row => ({ table: 'pull_requests' as const, id: Number(row.id), number: Number(row.number), at: String(row.created_at ?? ''), rank: 1 })),
      ].sort((a, b) => a.at.localeCompare(b.at) || a.rank - b.rank || a.id - b.id)

      const wanted = new Map(ordered.map((row, index) => [`${row.table}:${row.id}`, index + 1]))
      const already = ordered.every(row => row.number === wanted.get(`${row.table}:${row.id}`))

      // Already a clean sequence. Re-running must not rewrite numbers that are
      // correct, because a number is a URL and a reseed that shuffles them
      // invalidates every link anybody saved.
      if (already && Number(repository.issue_counter ?? 0) === ordered.length)
        continue

      /*
       * Two passes, because the column is now uniquely indexed.
       *
       * Assigning the final numbers one row at a time collides with the index
       * halfway through: if one row holds 5 and another is on its way to 5, the
       * second update is refused before the first has moved. Which is the index
       * doing its job, and the reason this seeder failed the moment the index
       * landed.
       *
       * So the rows that have to move are parked above every number in use
       * first, then brought down. The staging value is `offset + final`, and
       * `offset` is past the highest number either table holds for this
       * repository, so a parked row can collide with neither another parked row
       * (their finals differ) nor a row that is already correct and never moves
       * (its number is below the offset).
       */
      const moving = ordered.filter(row => row.number !== wanted.get(`${row.table}:${row.id}`))

      if (moving.length > 0) {
        const offset = Math.max(...ordered.map(row => row.number), ordered.length) + 1

        for (const row of moving) {
          await db
            .updateTable(row.table)
            .set({ number: offset + wanted.get(`${row.table}:${row.id}`)! })
            .where('id', '=', row.id)
            .execute()
        }

        for (const row of moving) {
          await db
            .updateTable(row.table)
            .set({ number: wanted.get(`${row.table}:${row.id}`)! })
            .where('id', '=', row.id)
            .execute()

          renumbered += 1
        }
      }

      /*
       * And the counter, so the next real allocation continues the sequence
       * rather than colliding with it.
       *
       * Without this the seeded rows would hold 1 to N while `issue_counter`
       * still held whatever the factory left, and the first issue opened
       * through the interface would be handed a number that is already taken -
       * which is the bug this seeder exists to remove, reintroduced by the
       * seeder itself.
       */
      await db
        .updateTable('repositories')
        .set({ issue_counter: ordered.length })
        .where('id', '=', repositoryId)
        .execute()

      touched += 1
    }

    if (renumbered > 0)
      console.error(`[seed] renumbered ${renumbered} issue(s) and change(s) across ${touched} repositories, one sequence each`)
  }
}

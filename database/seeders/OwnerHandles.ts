import { db, Seeder } from '@stacksjs/database'
import { isSafeSegment } from '../../app/Actions/Git/storage'

/**
 * Handles that can be a URL and a directory, which is most of what a handle is.
 *
 * A handle is the first segment of every page an owner has and the first
 * directory of every repository they own under `storage/repos`. Seeded
 * handles were arriving with a space in them - `helenjames 1`,
 * `globalsoft-ltd 1` - which is neither.
 *
 * The space comes from the framework's seeder, which disambiguates a
 * duplicate value in a unique column by appending `" " + counter`
 * (`claimUniqueValues` in `@stacksjs/database`). For a number that is
 * harmless; for anything that has to survive a URL, a path, an email or a DNS
 * label it produces a value that is invalid for the one job the column has.
 * Filed upstream.
 *
 * The models no longer collide - `User.handle` and `Organization.handle` carry
 * their own suffix now - so a fresh seed never reaches that code. This is for
 * the instances that already have the damage: ten users and **all four**
 * organizations, which meant no organization could own a repository at all,
 * since `repositoryPath` refuses the segment outright.
 *
 * Runs before anything that turns a handle into a path.
 */
export default class OwnerHandles extends Seeder {
  /** Before `RepositoryOwners` (10) and `RepositoryGit` (12), both of which read handles. */
  static order = 9
  static tags = ['owners', 'repositories']

  async run(): Promise<void> {
    let repaired = 0

    for (const table of ['users', 'organizations'] as const) {
      const rows = await db.selectFrom(table).select(['id', 'handle']).execute()
      const taken = new Set(rows.map(row => String(row.handle ?? '')))

      for (const row of rows) {
        const handle = String(row.handle ?? '')

        if (isSafeSegment(handle))
          continue

        /*
         * Derived from what is there rather than regenerated, so a handle
         * somebody could already have linked to stays recognisable:
         * `helenjames 1` becomes `helenjames-1`, not a new random string.
         */
        let candidate = handle
          .toLowerCase()
          .replace(/[^a-z0-9._-]+/g, '-')
          .replace(/-+/g, '-')
          .replace(/^[-.]+|[-.]+$/g, '')
          .slice(0, 39)

        if (!candidate || !isSafeSegment(candidate))
          candidate = `owner-${row.id}`

        // The repair must not create the collision it is repairing.
        let unique = candidate
        let attempt = 2

        while (taken.has(unique))
          unique = `${candidate}-${attempt++}`

        taken.add(unique)

        await db.updateTable(table).set({ handle: unique }).where('id', '=', row.id).execute()

        repaired += 1
      }
    }

    if (repaired > 0)
      console.error(`[seed] repaired ${repaired} handle(s) that could not be a URL segment`)
  }
}

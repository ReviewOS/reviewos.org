import { db, Seeder } from '@stacksjs/database'

/**
 * Point every seeded repository at an owner that exists.
 *
 * A repository's owner is polymorphic: `owner_type` says `user` or
 * `organization` and `owner_id` indexes whichever table that names. The model
 * factory cannot resolve that, and not because nobody tried. A factory is
 * handed `faker` and the values generated for its own row, never a database, so
 * `owner_id` was `faker.number.int({ min: 1, max: 4 })` - an id invented on the
 * assumption that owners are numbered from one. They are not, after the first
 * re-seed: organizations are 21 to 24 here, and all eight seeded repositories
 * pointed at rows that do not exist.
 *
 * The framework's seeder resolves a `belongsTo` by reading the parent table, so
 * the obvious fix is to declare one. It is the wrong fix: a `belongsTo` on
 * `owner_id` generates a foreign key, and a foreign key on a polymorphic column
 * is a constraint that forbids half the values the column exists to hold. The
 * column has to be able to name an organization while the constraint insists it
 * names a user.
 *
 * So it is repaired here instead, after the model pass, which is the one place
 * that can see both tables. Only orphans are touched, so running this against a
 * database whose repositories are already coherent changes nothing, and the
 * fifteen repositories the test suite creates with real owners are left alone.
 *
 * ## And the visibility mix, for the same reason
 *
 * `visibility` has the same problem in a milder form: a factory decides one row
 * at a time, and over eight rows a 50/50 choice is not a spread. One seed came
 * out seven private, which put every issue in the database behind a permission
 * check and left an anonymous visitor with nothing to look at; weighting it
 * towards public then came out nine public and no private one, so nothing
 * exercised the permission path. A proportion only means something to somebody
 * counting the rows, which a factory cannot do and this can.
 *
 * So the model writes `public` and every third repository is made private here:
 * both states always exist, whatever the seeded count is. Repositories that
 * are already private are left alone, because this runs again on every seed and
 * the point is a stable mix rather than a reshuffle.
 *
 * ## Why it is worth repairing rather than tolerating
 *
 * `app/Ops/admin.ts` falls back to the raw id when a handle cannot be found,
 * deliberately, because a page with an id on it is still a usable page. That
 * makes orphaned owners invisible: the admin list reads `4` where every other
 * row reads a handle, and nothing reports it. `tests/e2e/admin.test.ts` asserts
 * the owner is not a bare number for exactly this reason.
 */
export default class RepositoryOwners extends Seeder {
  /** After the model pass, which is what creates the rows this repairs. */
  static order = 10
  static tags = ['repositories']

  async run(): Promise<void> {
    const owners = {
      user: (await db.selectFrom('users').select(['id']).limit(500).execute()).map(row => Number(row.id)),
      organization: (await db.selectFrom('organizations').select(['id']).limit(500).execute()).map(row => Number(row.id)),
    }

    // Nothing to point at. A fresh database with no accounts is not a failure
    // here, it is a database the model pass has not reached yet.
    if (owners.user.length === 0 && owners.organization.length === 0)
      return

    const repositories = await db
      .selectFrom('repositories')
      .select(['id', 'owner_type', 'owner_id'])
      .execute()

    let repaired = 0

    for (const repository of repositories) {
      const declared = String(repository.owner_type) === 'organization' ? 'organization' : 'user'

      // The type it asked for when that table has rows, and the other one when
      // it does not: an organization-owned repository with no organizations to
      // own it is better owned by a user than left pointing at nothing.
      const pool = owners[declared].length > 0 ? owners[declared] : owners[declared === 'user' ? 'organization' : 'user']
      const type = owners[declared].length > 0 ? declared : (declared === 'user' ? 'organization' : 'user')

      if (pool.includes(Number(repository.owner_id)) && declared === type)
        continue

      await db
        .updateTable('repositories')
        .set({ owner_type: type, owner_id: pool[repaired % pool.length] })
        .where('id', '=', repository.id)
        .execute()

      repaired += 1
    }

    if (repaired > 0)
      console.error(`[seed] repaired ${repaired} repository owner(s) that pointed at rows which do not exist`)

    await this.visibilityMix()
  }

  /**
   * Every third repository private, counted over the rows that exist.
   *
   * Keyed on the row's own id rather than on its position in the list, so a
   * repository's visibility is decided once and never changes.
   *
   * Position was the first attempt and it drifts: this runs at order 10 and
   * `StackedChange` creates a repository at order 13, so the second seed sees
   * a list one longer and the row that was last becomes a multiple of three.
   * That row is the stack demonstration, which quietly went private on the
   * second seed and stopped being visible to anyone not signed in.
   */
  private async visibilityMix(): Promise<void> {
    const repositories = await db
      .selectFrom('repositories')
      .select(['id', 'visibility'])
      .orderBy('id')
      .execute()

    // One repository cannot hold both states, and making the only one private
    // would leave a seeded instance with nothing public at all.
    if (repositories.length < 3)
      return

    let hidden = 0

    for (const repository of repositories) {
      if (Number(repository.id) % 3 !== 2 || String(repository.visibility) === 'private')
        continue

      await db
        .updateTable('repositories')
        .set({ visibility: 'private' })
        .where('id', '=', repository.id)
        .execute()

      hidden += 1
    }

    if (hidden > 0)
      console.error(`[seed] made ${hidden} repositor${hidden === 1 ? 'y' : 'ies'} private, so both visibilities exist`)
  }
}

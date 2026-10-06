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
  }
}

import { db, Seeder } from '@stacksjs/database'
import { initBare } from '../../app/Actions/Git/git'
import { isSafeSegment, repositoryPath } from '../../app/Actions/Git/storage'
import { branchSha, createCommit } from '../../app/Actions/Git/write'

/**
 * One stack, so the feature the product leads with can be opened.
 *
 * Stacked pull requests are a first-class object here - AGENTS.md gives
 * "stack" its own row in the domain vocabulary, the landing page argues for
 * them, and `resources/functions/stack.ts` carries several hundred lines of
 * ordering, orphan detection and landable-prefix rules. None of it was
 * reachable from seed data: every seeded pull request branches off the default
 * branch, so the instance had 185 changes and not one stack.
 *
 * `buildStack` walks `stack_parent_id`, which `stackDetect` fills at open time
 * when a change targets another change's head branch. A seeder cannot go
 * through the open-time path without inventing a request, so it writes the
 * same rows that path would: chained branches, chained bases, and the parent
 * links between them.
 *
 * ## Its own repository, deliberately
 *
 * Retrofitting three existing changes would mean rewriting rows whose branches
 * and shas were just made consistent, to produce a stack nobody can find. A
 * named repository is something a person can be pointed at, and it leaves the
 * other 185 changes exactly as they are.
 */

/** Bottom first, which is the order they land in. */
const CHANGES = [
  {
    branch: 'stack/extract-the-parser',
    title: 'Extract the parser',
    body: 'The first of three. Splitting the change is what makes the next two readable.',
    file: 'src/parse.ts',
    content: `export function parse(input: string): string[] {\n  return input.split(',').map(part => part.trim())\n}\n`,
  },
  {
    branch: 'stack/validate-what-it-parsed',
    title: 'Validate what it parsed',
    body: 'Depends on the parser above, and shows only its own work.',
    file: 'src/validate.ts',
    content: `import { parse } from './parse'\n\nexport function validate(input: string): boolean {\n  return parse(input).every(part => part.length > 0)\n}\n`,
  },
  {
    branch: 'stack/report-the-failures',
    title: 'Report the failures',
    body: 'The top of the stack. Merging the two below retargets this one.',
    file: 'src/report.ts',
    content: `import { validate } from './validate'\n\nexport function report(input: string): string {\n  return validate(input) ? 'ok' : 'some entries are empty'\n}\n`,
  },
] as const

const AUTHOR = { name: 'ReviewOS Seed', email: 'seed@reviewos.localhost', date: '2026-01-16T10:00:00Z' }
const REPOSITORY = 'stacked-change'
const BASE = 'main'

export default class StackedChange extends Seeder {
  /** After `RepositoryGit`, which owns the ordinary repositories. */
  static order = 13
  static tags = ['repositories', 'git', 'stacks']

  async run(): Promise<void> {
    /*
     * The first owner whose handle can be a path, which is not the first
     * owner.
     *
     * Seeded handles collide and get a numeric suffix appended with a space -
     * `helenjames 1`, `globalsoft-ltd 1` - and a handle with a space in it can
     * never be a URL segment or a directory under `storage/repos`. Ten of 348
     * users and *all four* organizations are in that state, so taking the
     * first row meant this seeder silently did nothing.
     */
    const owner = (await db.selectFrom('users').select(['id', 'handle']).orderBy('id').limit(50).execute())
      .find(candidate => isSafeSegment(String(candidate.handle ?? '')))

    // No usable account yet is a database the model pass has not reached, not
    // a failure here - the same rule `RepositoryOwners` follows.
    if (!owner?.handle)
      return

    /*
     * An existing one is found by name alone, not by owner.
     *
     * Keyed on `(owner, name)` this created a *second* stack the moment the
     * chosen owner changed - which happened as soon as `OwnerHandles` repaired
     * the handles, since the first path-safe user is a different person
     * afterwards. Two `stacked-change` repositories, three changes each, from
     * a seeder whose whole second half is about being re-runnable.
     */
    const existing = await db
      .selectFrom('repositories')
      .select(['id', 'owner_id', 'owner_type'])
      .where('name', '=', REPOSITORY)
      .executeTakeFirst()

    const holder = existing
      ? await db
        .selectFrom(String(existing.owner_type) === 'organization' ? 'organizations' : 'users')
        .select(['handle'])
        .where('id', '=', existing.owner_id)
        .executeTakeFirst()
      : owner

    const handle = String(holder?.handle ?? owner.handle)
    const resolved = repositoryPath(handle, REPOSITORY)

    if (!resolved.ok || !resolved.path)
      return

    // Already here. Re-seeding must not append a second stack to a repository
    // that has one, and must never rewrite a branch somebody has pushed to.
    if (existing && await branchSha(resolved.path, CHANGES[CHANGES.length - 1]!.branch))
      return

    const repositoryId = existing?.id ?? (await db
      .insertInto('repositories')
      .values({
        name: REPOSITORY,
        description: 'Three dependent changes, to show a stack end to end.',
        owner_type: 'user',
        owner_id: owner.id,
        visibility: 'public',
        default_branch: BASE,
        /*
         * The path on disk, because this column is read and not merely stored:
         * `app/Actions/Git/hooks.ts` looks a repository **up** by it, so a push
         * to a repository with no `disk_path` finds nothing, and
         * `DiffConflictsAction` hands it to git directly. Left out here, it
         * defaulted to empty - the one repository in a fresh seed whose path
         * was wrong, while `RepositoryGit` set the other eight.
         */
        disk_path: resolved.relative,
      })
      .returning(['id'])
      .executeTakeFirst())?.id

    if (!repositoryId)
      return

    if (!(await Bun.file(`${resolved.path}/HEAD`).exists())) {
      const created = await initBare(resolved.path, BASE)

      if (!created.ok)
        return
    }

    let parentSha = await branchSha(resolved.path, BASE)

    if (!parentSha) {
      const root = await createCommit(resolved.path, {
        branch: BASE,
        parentSha: null,
        expectedBranchSha: null,
        message: 'Add the module the stack splits up',
        author: AUTHOR,
        files: {
          'README.md': `# ${REPOSITORY}\n\nThree dependent changes that merge in order. Open any one of them to see\nthe whole stack and its position in it.\n`,
          'src/index.ts': `export const name = '${REPOSITORY}'\n`,
        },
      })

      if (!root.ok)
        return

      parentSha = root.sha
    }

    const highest = await db
      .selectFrom('pull_requests')
      .select(['number'])
      .where('repository_id', '=', repositoryId)
      .orderBy('number', 'desc')
      .limit(1)
      .executeTakeFirst()

    let number = Number(highest?.number ?? 0)
    let base = BASE
    let baseSha = parentSha
    let parentId: number | null = null

    for (const change of CHANGES) {
      /*
       * Each commit sits on the one below it, which is what makes this a stack
       * rather than three changes off the same base - and it is also what
       * makes each diff show only its own work, since the base it is compared
       * against is the change below rather than the default branch.
       */
      const commit = await createCommit(resolved.path, {
        branch: change.branch,
        parentSha: baseSha,
        expectedBranchSha: null,
        message: change.title,
        author: AUTHOR,
        files: { [change.file]: change.content },
      })

      if (!commit.ok)
        return

      number += 1

      const row = await db
        .insertInto('pull_requests')
        .values({
          repository_id: repositoryId,
          number,
          title: change.title,
          body: change.body,
          /*
           * The owner, because a change with no author renders as "by
           * someone".
           *
           * This was left null, and these three were the only pull requests in
           * a seeded instance without an author - the list said "opened 18
           * minutes ago by someone" on the one repository built to demonstrate
           * the product. Nothing errored, which is why it survived: a null
           * author has a fallback, and the fallback is the word "someone".
           */
          author_id: owner.id,
          state: 'open',
          draft: false,
          head_branch: change.branch,
          head_sha: commit.sha,
          base_branch: base,
          base_sha: baseSha,
          stack_parent_id: parentId,
        })
        .returning(['id'])
        .executeTakeFirst()

      if (!row?.id)
        return

      parentId = Number(row.id)
      base = change.branch
      baseSha = commit.sha
    }

    /*
     * And the repository's counter, which this seeder allocated out of.
     *
     * It numbers its changes by reading the highest one already there and
     * incrementing, which is right, but it left `repositories.issue_counter` at
     * whatever it was - 0 for a repository this seeder created. `allocateNumber`
     * starts from that counter, so the next pull request opened here through the
     * interface would be handed number 1, which this stack already holds. Before
     * `(repository_id, number)` was unique that produced a second change on an
     * occupied number and made one of the two unreachable; now it is a failed
     * insert, which is better and still wrong.
     */
    await db
      .updateTable('repositories')
      .set({ issue_counter: number })
      .where('id', '=', repositoryId)
      .execute()

    console.error(`[seed] a stack of ${CHANGES.length} at ${handle}/${REPOSITORY}`)
  }
}

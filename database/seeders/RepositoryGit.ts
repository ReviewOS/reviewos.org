import { db, Seeder } from '@stacksjs/database'
import { initBare } from '../../app/Actions/Git/git'
import { repositoryPath } from '../../app/Actions/Git/storage'
import { branchSha, createCommit } from '../../app/Actions/Git/write'

/**
 * Repositories that actually contain something.
 *
 * Seeding wrote 75 repository rows and not one commit, because no seeder
 * touched `storage/repos` at all. Every repository page loaded and every
 * `tree/` and `commits/` under it answered 404, so on a fresh checkout the
 * code browser, the diff and the review surface - the thing this product is
 * built around - could not be opened at all without creating a repository by
 * hand first. A forge whose demo data cannot demonstrate a review is seed data
 * that proves the schema and nothing else.
 *
 * ## Through the git actions, never around them
 *
 * AGENTS.md: bare repositories are driven by the system git binary, and
 * anything touching one on disk goes through `app/Actions/Git/`. So this calls
 * `initBare` and `createCommit` rather than spawning plumbing itself, which
 * also means it inherits their concurrency slots, their ref guards and their
 * safe-path checks for free.
 *
 * `createCommit` writes a blob, a tree, a commit and a ref into a bare
 * repository with no clone and no worktree, which is the same path
 * `app/Actions/Profile/seed.ts` already uses to write a profile README.
 *
 * ## What it builds, and why that shape
 *
 * Two commits on the default branch, then one commit on a branch off the
 * first, so every repository has: a history worth paging, a file that changed
 * between two commits, and a branch that diverges from its base. That last one
 * is the minimum for a pull request to show a diff rather than an empty one -
 * a seeded PR whose head and base are the same commit renders a review screen
 * with nothing to review, which looks like a broken page rather than an empty
 * change.
 *
 * The repository's own pull request rows are then pointed at those real
 * commits, the same repair `RepositoryOwners` does for polymorphic owners:
 * the factories invented `head_sha` values like `1111...`, which name nothing.
 *
 * Re-runnable. A repository whose default branch already exists is left
 * completely alone, so this never rewrites history somebody has pushed to, and
 * `buddy setup` re-seeding is a no-op here.
 */

/*
 * Every repository, not a sample.
 *
 * This was capped at 24, and the cap was wrong twice over. It counted
 * *this run's* builds, so a second run built 24 more rather than converging -
 * re-seeding grew the set instead of leaving it alone. And the repositories it
 * left out still had pull requests, which kept their invented shas and
 * rendered a review screen with no diff: the exact failure this seeder exists
 * to remove, now only on the repositories nobody chose to look at.
 *
 * Seventy-five repositories is about four git processes each and lands in well
 * under a minute, against a `buddy seed` that already takes longer than that.
 * A repository that cannot be opened is a worse cost than the seconds.
 */

/** Fixed, so re-seeding produces the same history rather than a new one daily. */
const AUTHOR = { name: 'ReviewOS Seed', email: 'seed@reviewos.localhost', date: '2026-01-15T09:00:00Z' }

function readme(name: string): string {
  return `# ${name}\n\nSeeded by \`database/seeders/RepositoryGit.ts\` so this repository has a\nhistory to browse and a change to review.\n`
}

export default class RepositoryGit extends Seeder {
  /** After the model pass and after owners are repaired, since the path needs a handle. */
  static order = 12
  static tags = ['repositories', 'git']

  async run(): Promise<void> {
    const repositories = await db
      .selectFrom('repositories')
      .select(['id', 'name', 'owner_type', 'owner_id', 'default_branch'])
      .execute()

    if (repositories.length === 0)
      return

    const handles = { user: new Map<number, string>(), organization: new Map<number, string>() }

    for (const [kind, table] of [['user', 'users'], ['organization', 'organizations']] as const) {
      for (const row of await db.selectFrom(table).select(['id', 'handle']).limit(500).execute())
        handles[kind].set(Number(row.id), String(row.handle))
    }

    // Repositories carrying pull requests first: those are the pages where a
    // missing diff is most visible.
    const withPulls = new Set(
      (await db.selectFrom('pull_requests').select(['repository_id']).execute()).map(row => Number(row.repository_id)),
    )

    const ordered = [...repositories].sort((a, b) =>
      Number(withPulls.has(Number(b.id))) - Number(withPulls.has(Number(a.id))))

    let built = 0

    for (const repository of ordered) {
      const kind = String(repository.owner_type) === 'organization' ? 'organization' : 'user'
      const owner = handles[kind].get(Number(repository.owner_id))

      // An owner this seeder cannot name is a repository `RepositoryOwners`
      // has not repaired yet, not a failure here.
      if (!owner)
        continue

      const branch = String(repository.default_branch || 'main')
      const resolved = repositoryPath(owner, String(repository.name))

      if (!resolved.ok || !resolved.path)
        continue

      /*
       * History is built once; the pull requests are wired every run.
       *
       * These were one check, and that was a bug: a repository built on an
       * earlier run skipped the whole body, so any pull request that failed to
       * wire the first time kept its invented sha for ever. The two questions
       * are separate - "does this have commits" and "does this change point at
       * one" - and only the first is answered by the repository existing.
       */
      const tip = (await Bun.file(`${resolved.path}/HEAD`).exists()) ? await branchSha(resolved.path, branch) : null

      if (tip) {
        await this.openChanges(Number(repository.id), resolved.path, branch, tip)
        continue
      }

      const created = await initBare(resolved.path, branch)

      if (!created.ok)
        continue

      const name = String(repository.name)

      const first = await createCommit(resolved.path, {
        branch,
        parentSha: null,
        expectedBranchSha: null,
        message: 'Add a README',
        author: AUTHOR,
        files: { 'README.md': readme(name) },
      })

      if (!first.ok)
        continue

      const second = await createCommit(resolved.path, {
        branch,
        parentSha: first.sha,
        expectedBranchSha: first.sha,
        message: 'Add the greeting it describes',
        author: AUTHOR,
        files: { 'src/index.ts': `export function greet(who: string): string {\n  return \`Hello, \${who}\`\n}\n` },
      })

      if (!second.ok)
        continue

      built += 1

      await this.openChanges(Number(repository.id), resolved.path, branch, second.sha)
    }

    if (built > 0)
      console.error(`[seed] built ${built} repositories with history under storage/repos`)
  }

  /**
   * A branch per pull request, and the rows pointed at it.
   *
   * The factory invented `head_sha` as a repeated digit, which names no object,
   * so the review screen had nothing to resolve. Each open pull request gets a
   * real branch off the default tip with one commit on it, and its row is
   * updated to the shas that exist - base at the tip it forked from, head at
   * the commit, which is exactly what the diff is computed between.
   */
  private async openChanges(repositoryId: number, path: string, base: string, baseSha: string): Promise<void> {
    const pulls = await db
      .selectFrom('pull_requests')
      .select(['id', 'number', 'head_branch'])
      .where('repository_id', '=', repositoryId)
      /*
       * Every one of them, not the first few.
       *
       * This was `.limit(4)`, which left nine pull requests across the
       * instance pointing at invented shas - on the busiest repositories,
       * which are the ones worth opening. One commit each is the cheapest
       * thing this seeder does.
       */
      .execute()

    for (const pull of pulls) {
      /*
       * A branch per pull request, which the factory did not give them.
       *
       * Several pull requests in one repository were handed the same
       * `head_branch`, so the second `createCommit` hit the ref guard - the
       * branch already existed - and that row kept its invented sha while the
       * first looked fine. The number is what makes it unique, and it is also
       * what a reader sees on the page.
       */
      const head = `${String(pull.head_branch || 'change')}-${pull.number}`
      const already = await branchSha(path, head)

      // Wired on an earlier run. Nothing to redo, and nothing to overwrite.
      if (already && already === String(pull.head_sha ?? ''))
        continue

      const commit = already
        ? { ok: true as const, sha: already }
        // Branching off the base: there is a parent, and no ref yet - the case
        // `createCommit` documents `expectedBranchSha: null` for.
        : await createCommit(path, {
          branch: head,
          parentSha: baseSha,
          expectedBranchSha: null,
          message: `Rename the greeting's parameter (#${pull.number})`,
          author: AUTHOR,
          files: {
            // Varied by number, so two changes in one repository are not the
            // same diff twice over.
            'src/index.ts': `export function greet(who${pull.number}: string): string {\n  return \`Hello, \${who${pull.number}}\`\n}\n`,
          },
        })

      if (!commit.ok)
        continue

      await db
        .updateTable('pull_requests')
        .set({ base_branch: base, base_sha: baseSha, head_branch: head, head_sha: commit.sha })
        .where('id', '=', pull.id)
        .execute()
    }
  }
}

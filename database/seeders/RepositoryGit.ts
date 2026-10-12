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

/** The three-line file every `greet.ts` review thread is anchored to. */
function greeter(parameter = 'who'): string {
  return `export function greet(${parameter}: string): string {\n  return \`Hello, \${${parameter}}\`\n}\n`
}

/**
 * A source file long enough to hold the line a thread points at.
 *
 * The review-thread factory invents paths like `src/sensor.ts` and lines as
 * high as 398, so a repository holding only a README and a three-line greeter
 * could never anchor them: the file is absent, and the line is past the end of
 * everything else. Generating the file the fixture already names is cheaper
 * than teaching the fixture to name a file that exists, and it has the side
 * effect of making the repository worth browsing - a tree with one file in it
 * demonstrates nothing about a code browser.
 */
function sourceFile(path: string, lines: number): string {
  const subject = path.replace(/^src\//, '').replace(/\.ts$/, '')
  const body: string[] = [
    `/** Seeded ${subject} helpers, long enough to anchor a review thread. */`,
    '',
  ]

  for (let n = body.length + 1; n <= lines; n += 1)
    body.push(`export const ${subject}${n} = ${n}`)

  return `${body.join('\n')}\n`
}

/**
 * The branch name for a pull request, derived so that deriving it twice is a
 * no-op.
 *
 * This read `${stored}-${number}` off the row, and the same loop then wrote
 * the result back to that column - so every reseed appended the number again.
 * Nine runs turned `feature/card` into
 * `feature/card-45-45-45-45-45-45-45-45-45`, on 202 of 242 pull requests, and
 * left eight dead branches per change behind on disk for the branch list to
 * show. The guard that should have caught it on run two could not: it compared
 * against `pull.head_sha`, which the query did not select, so it was comparing
 * every sha against the string "undefined".
 *
 * A seeder is re-run by definition - that is what `useSeeder` means - so a
 * value it computes from a column it also writes has to be a fixed point.
 * Stripping the suffix before appending it makes this one: a name that already
 * ends in `-<number>` is already correct and comes back unchanged, whatever
 * state an earlier run left the row in.
 */
export function headBranchFor(stored: string, number: number): string {
  const suffix = `-${number}`
  let base = stored

  while (base.endsWith(suffix))
    base = base.slice(0, -suffix.length)

  return `${base || 'change'}${suffix}`
}

export default class RepositoryGit extends Seeder {
  /** After the model pass and after owners are repaired, since the path needs a handle. */
  static order = 12
  static tags = ['repositories', 'git']

  async run(): Promise<void> {
    const repositories = await db
      .selectFrom('repositories')
      .select(['id', 'name', 'owner_type', 'owner_id', 'default_branch', 'disk_path'])
      .execute()

    if (repositories.length === 0)
      return

    const handles = { user: new Map<number, string>(), organization: new Map<number, string>() }

    for (const [kind, table] of [['user', 'users'], ['organization', 'organizations']] as const) {
      for (const row of await db.selectFrom(table).select(['id', 'handle']).limit(500).execute())
        handles[kind].set(Number(row.id), String(row.handle))
    }

    /*
     * Which files each repository's review threads expect, and how far down.
     *
     * Read once rather than per repository: the whole table is a few dozen
     * rows, and the alternative is a query inside the build loop.
     */
    const anchors = await this.threadAnchors()

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
       * The row's own `disk_path`, pointed at the directory this seeder builds.
       *
       * The model factory invents one - `<some other handle>/<some other
       * name>.git` - and 54 of 106 repositories were carrying a path that
       * named a *different* repository. That is not cosmetic, because the
       * column is read rather than merely stored: `app/Actions/Git/hooks.ts`
       * looks a repository **up** by it, so a push could not find the
       * repository it had just been pushed to, and `DiffConflictsAction` hands
       * it straight to git, so the conflict view on a seeded pull request
       * resolved nothing.
       *
       * Set here because this is the first place that knows both halves: the
       * owner's handle, which only exists after `OwnerHandles` has repaired it,
       * and the directory, which this seeder is about to create.
       */
      if (String(repository.disk_path ?? '') !== resolved.relative) {
        await db
          .updateTable('repositories')
          .set({ disk_path: resolved.relative })
          .where('id', '=', repository.id)
          .execute()
      }

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

      /*
       * `greet.ts` at the root, plus whatever `src/*.ts` this repository's
       * review threads point at - not `src/index.ts`, which was a file of my
       * own invention that nothing referenced. Eleven threads anchor to
       * `greet.ts` line 3, which is the last line of the greeter below.
       */
      const sources: Record<string, string> = { 'greet.ts': greeter() }

      for (const [anchorPath, deepest] of anchors.get(Number(repository.id)) ?? [])
        sources[anchorPath] = sourceFile(anchorPath, Math.max(deepest, 8))

      const second = await createCommit(resolved.path, {
        branch,
        parentSha: first.sha,
        expectedBranchSha: first.sha,
        message: 'Add the greeting and the modules the reviews discuss',
        author: AUTHOR,
        files: sources,
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
   * Which files each repository's review threads expect, and the deepest line.
   *
   * A thread carries a path and a line and nothing that ties it to a
   * repository, so the repository comes through its pull request. The deepest
   * line is what decides how long the generated file has to be: a thread on
   * line 398 of a 40-line file anchors to nothing.
   */
  private async threadAnchors(): Promise<Map<number, Map<string, number>>> {
    const pulls = new Map(
      (await db.selectFrom('pull_requests').select(['id', 'repository_id']).execute())
        .map(row => [Number(row.id), Number(row.repository_id)]),
    )

    const anchors = new Map<number, Map<string, number>>()

    for (const thread of await db.selectFrom('review_threads').select(['pull_request_id', 'path', 'line']).execute()) {
      const repositoryId = pulls.get(Number(thread.pull_request_id))
      const path = String(thread.path ?? '').trim()

      // `greet.ts` and `README.md` are written for every repository anyway;
      // only the invented `src/*.ts` paths need generating.
      if (!repositoryId || !path.startsWith('src/'))
        continue

      const forRepository = anchors.get(repositoryId) ?? new Map<string, number>()

      forRepository.set(path, Math.max(forRepository.get(path) ?? 0, Number(thread.line ?? 1)))
      anchors.set(repositoryId, forRepository)
    }

    return anchors
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
      .select(['id', 'number', 'head_branch', 'head_sha'])
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
       *
       * Through `headBranchFor`, because the name is derived from a column
       * this loop also writes: see the note on that function.
       */
      const head = headBranchFor(String(pull.head_branch || 'change'), Number(pull.number))
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
          // Varied by number, so two changes in one repository are not the
          // same diff twice over, and on the file the threads are anchored to.
          files: { 'greet.ts': greeter(`who${pull.number}`) },
        })

      if (!commit.ok)
        continue

      await db
        .updateTable('pull_requests')
        .set({ base_branch: base, base_sha: baseSha, head_branch: head, head_sha: commit.sha })
        .where('id', '=', pull.id)
        .execute()

      /*
       * And the threads on it, which are the point of the whole exercise.
       *
       * A review thread anchors to a path, a line, a side and the commit it
       * was written against - that last one is what lets a rebase move it
       * instead of losing it. The factory left `original_commit_sha` null or
       * set to a repeated digit, so every thread was anchored to a commit that
       * does not exist, on a file that did not either. Both are real now.
       */
      await db
        .updateTable('review_threads')
        .set({ original_commit_sha: commit.sha })
        .where('pull_request_id', '=', pull.id)
        .execute()
    }
  }
}

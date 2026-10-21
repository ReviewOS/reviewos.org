import { db, Seeder } from '@stacksjs/database'

/**
 * Checks, runs and test results, anchored to commits that exist.
 *
 * The roadmap calls a check result landing on the diff the one thing neither
 * GitHub Actions nor Buildkite can be priced against, and on a seeded instance
 * it could only ever be seen empty. Four screens said so at once: the checks
 * tab on every pull request reported "Nothing has reported on this commit",
 * "Nothing has reported test results for this commit" and "No checks are
 * required on this branch", `/runs` and `/workflows` had nothing to list, and
 * `/tests` had no history to trend.
 *
 * Not because anything was broken. `tests/e2e/checks-page.test.ts` builds its
 * own rows and passes, so the screens work; it is the seed that had no data.
 * `CheckRun` asked for 25 rows whose `head_sha` was faker's invention, so they
 * matched **no** pull request in the instance and the panel - which keys on
 * `(repository_id, head_sha)` - never saw one of them. Every other model in
 * the family carried `useSeeder: { count: 0 }`, which is honest about a factory
 * that cannot do the job but leaves the product invisible.
 *
 * ## Why a seeder and not factories
 *
 * Every row here is only meaningful relative to another row. A check run has
 * to carry the head sha of a real pull request, an annotation has to name a
 * path and a line that exist in that repository's tree, a workflow run belongs
 * to a version of a workflow in the repository it ran for, and a test
 * execution belongs to both a run and a managed test. A factory sees `faker`
 * and its own row, never the database, so none of those relationships can be
 * expressed there. Same reasoning as `Reactions.ts` and `TimelineEntries.ts`.
 *
 * ## Deterministic, not random
 *
 * Which check fails, which run is still going and which test is flaky are all
 * decided by position, so a reseed produces the same instance and the screens
 * can be compared between runs. It also guarantees the mix: a green instance
 * demonstrates nothing about how a failure reads, and with eight repositories
 * a coin flip reliably delivers all of one or all of the other.
 */

/**
 * The workflow file these runs claim to come from.
 *
 * Written out rather than implied, because `content_digest` is a hash of it
 * and a hash of nothing in particular is a column that lies about what it is.
 * It is also the file a reader would expect to find at the `source_path`
 * recorded below.
 */
const DEFINITION = `name: CI
on:
  push:
  pull_request:
  workflow_dispatch:

jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - run: ./buddy lint
  typecheck:
    runs-on: ubuntu-latest
    needs: [lint]
    steps:
      - run: ./buddy typecheck
  test:
    runs-on: ubuntu-latest
    needs: [typecheck]
    steps:
      - run: ./buddy test
`

/** The three jobs, in the order a pipeline would run them. */
const JOBS = [
  { id: 'lint', name: 'lint' },
  { id: 'typecheck', name: 'typecheck' },
  { id: 'test', name: 'test' },
] as const

/**
 * What each pull request's checks say, chosen by position.
 *
 * Every state the panel renders differently is represented, because each is a
 * separate branch in `labelFor` and an unexercised branch is one nobody has
 * looked at: all green, a failure with annotations on the diff, a run still in
 * progress, and a cancelled one. `neutral` is in there too, since a check that
 * reports nothing conclusive is what `checks-api.test.ts` pins as *not* green.
 */
const OUTCOMES = [
  { label: 'green', conclusions: ['success', 'success', 'success'], status: 'completed' },
  { label: 'failing', conclusions: ['success', 'success', 'failure'], status: 'completed' },
  { label: 'running', conclusions: ['success', null, null], status: 'in_progress' },
  { label: 'cancelled', conclusions: ['success', 'cancelled', 'cancelled'], status: 'completed' },
  { label: 'neutral', conclusions: ['success', 'neutral', 'success'], status: 'completed' },
] as const

/** The run state that goes with each outcome, so the list and the tab agree. */
const RUN_STATE: Record<string, string> = {
  green: 'succeeded',
  failing: 'failed',
  running: 'running',
  cancelled: 'cancelled',
  neutral: 'succeeded',
}

/**
 * The tests each repository tracks.
 *
 * Named after the files `RepositoryGit` actually writes, so a reader following
 * a failure from the test screen into the tree finds the file it names.
 */
const TESTS = [
  'greet.ts > greets the person named',
  'greet.ts > falls back when nobody is named',
  'greet.ts > trims surrounding whitespace',
  'tree > lists the root of a repository',
  'tree > resolves a path under a ref',
] as const

/** A stable millisecond offset, so timestamps read as a sequence. */
function minutesBefore(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString()
}

export default class Pipelines extends Seeder {
  /**
   * After `RepositoryGit` (12) and `StackedChange` (13).
   *
   * Both of those rewrite `pull_requests.head_sha` to a commit they created,
   * and a check run written before that points at the sha the factory
   * invented. This seeder exists because of exactly that mistake, so running
   * ahead of them would reintroduce it.
   */
  static order = 14
  static tags = ['checks', 'pipelines']

  async run(): Promise<void> {
    const repositories = await db
      .selectFrom('repositories')
      .select(['id', 'name', 'owner_type', 'owner_id', 'default_branch'])
      .orderBy('id')
      .execute()

    if (repositories.length === 0)
      return

    const pulls = await db
      .selectFrom('pull_requests')
      .select(['id', 'number', 'repository_id', 'head_sha', 'base_branch', 'author_id'])
      .orderBy('id')
      .execute()

    // Nothing to report against. A database whose pull requests have not been
    // seeded yet is not a failure here.
    if (pulls.length === 0)
      return

    const byRepository = new Map<number, typeof pulls>()

    for (const pull of pulls) {
      const list = byRepository.get(Number(pull.repository_id)) ?? []

      list.push(pull)
      byRepository.set(Number(pull.repository_id), list)
    }

    let checks = 0
    let runs = 0
    let executions = 0
    let position = 0

    for (const repository of repositories) {
      const repositoryId = Number(repository.id)
      const mine = byRepository.get(repositoryId) ?? []

      if (mine.length === 0)
        continue

      // Wired on an earlier run. Keyed on the run rather than on the check,
      // because the run is the row this seeder creates first.
      const already = await db
        .selectFrom('workflow_runs')
        .select(['id'])
        .where('repository_id', '=', repositoryId)
        .executeTakeFirst()

      if (already)
        continue

      const versionId = await this.workflow(repository)

      if (!versionId)
        continue

      const suiteId = await this.suite(repositoryId, String(repository.name))
      const managed = suiteId ? await this.managedTests(repositoryId, suiteId) : []

      for (const [index, pull] of mine.entries()) {
        const headSha = String(pull.head_sha ?? '')

        // A pull request whose head sha is not a commit is one `RepositoryGit`
        // could not wire, and a check on it would be the bug this file fixes.
        if (headSha.length < 7)
          continue

        const outcome = OUTCOMES[position % OUTCOMES.length]!

        position += 1

        // A run is per pull request: two changes at the same commit each had
        // their own pipeline execution, and the run list shows both.
        runs += await this.run_(repositoryId, versionId, pull, outcome, index + 1)

        /*
         * Reports are per **commit**, not per pull request, so a second pull
         * request pointing at the same head sha reuses them.
         *
         * Not a detail: `check_runs.idempotency_key` is unique, and keying it
         * on `(repository, sha, name)` is right precisely because a check
         * describes a commit. Two pull requests can share a head sha, and this
         * seeder crashed on the duplicate key the first time two did -
         * `pull_requests.number` is `faker.number.int({ min: 1, max: 200 })`
         * and `(repository_id, number)` carries no unique index, so one
         * repository ended up with two changes numbered 166, both of which
         * `RepositoryGit` gave the same branch and therefore the same commit.
         *
         * Writing a second set of reports for the second pull request would be
         * the wrong fix: it would mean two `lint` results on one commit, which
         * is not a thing a forge should show. Skipping is what a real reporter
         * does, through the same idempotency key.
         */
        const reported = await db
          .selectFrom('check_runs')
          .select(['id'])
          .where('repository_id', '=', repositoryId)
          .where('head_sha', '=', headSha)
          .executeTakeFirst()

        if (reported)
          continue

        checks += await this.checks(repositoryId, headSha, pull, outcome)

        if (suiteId && managed.length > 0)
          executions += await this.testRun(repositoryId, suiteId, managed, pull, outcome)
      }

      await this.requireChecks(repositoryId, String(repository.default_branch || 'main'))
    }

    if (runs > 0)
      console.error(`[seed] ${runs} workflow run(s), ${checks} check(s) and ${executions} test execution(s) on real commits`)
  }

  /**
   * One workflow and one version of it per repository, as a push would record.
   *
   * Reuses what is there rather than inserting blind, because a seeder is not
   * a transaction: the first run of this file failed partway through on an
   * over-long `content_digest` and left two repositories holding a workflow
   * with no version. The run gate above keys on `workflow_runs`, so those two
   * would have been handed a *second* workflow on the next seed, and the
   * workflow list would have shown one repository with two identical CI
   * entries. Partial state has to converge, not accumulate.
   *
   * The version lookup is not optional either: `workflow_versions` carries a
   * unique index on `(workflow_id, content_digest)`, and the digest is derived
   * from a constant here, so a second insert for the same workflow is a
   * constraint violation rather than a duplicate.
   */
  private async workflow(repository: { id: unknown, owner_type: unknown, owner_id: unknown }): Promise<number | null> {
    const digest = new Bun.CryptoHasher('sha256').update(DEFINITION).digest('hex')

    const existing = await db
      .selectFrom('workflows')
      .select(['id'])
      .where('repository_id', '=', Number(repository.id))
      .where('path', '=', '.github/workflows/ci.yml')
      .executeTakeFirst()

    const workflowId = existing?.id
      ? Number(existing.id)
      : await this.insertWorkflow(repository)

    if (!workflowId)
      return null

    const version = await db
      .selectFrom('workflow_versions')
      .select(['id'])
      .where('workflow_id', '=', workflowId)
      .where('content_digest', '=', digest)
      .executeTakeFirst()

    const versionId = version?.id
      ? Number(version.id)
      : await this.insertVersion(workflowId, digest)

    if (!versionId)
      return null

    const job = await db
      .selectFrom('workflow_version_jobs')
      .select(['id'])
      .where('workflow_version_id', '=', versionId)
      .executeTakeFirst()

    if (!job) {
      await db
        .insertInto('workflow_version_jobs')
        .values(JOBS.map((one, index) => ({
          workflow_version_id: versionId,
          job_id: one.id,
          position: index,
          name: one.name,
          runs_on: 'ubuntu-latest',
          needs: index === 0 ? null : JSON.stringify([JOBS[index - 1]!.id]),
          timeout_minutes: 30,
        })))
        .execute()
    }

    return versionId
  }

  private async insertWorkflow(repository: { id: unknown, owner_type: unknown, owner_id: unknown }): Promise<number | null> {
    const workflow = await db
      .insertInto('workflows')
      .values({
        owner_type: String(repository.owner_type) === 'organization' ? 'organization' : 'user',
        owner_id: Number(repository.owner_id),
        repository_id: Number(repository.id),
        path: '.github/workflows/ci.yml',
        name: 'CI',
        state: 'active',
        uuid: crypto.randomUUID(),
      })
      .returning(['id'])
      .executeTakeFirst()

    return workflow?.id ? Number(workflow.id) : null
  }

  /**
   * A version, because a run belongs to one rather than to the workflow.
   *
   * `workflow_runs.workflow_version_id` is `not null` and the run list joins
   * through it to get the workflow's name, so a run without a version is a row
   * that cannot be displayed.
   */
  private async insertVersion(workflowId: number, digest: string): Promise<number | null> {
    const version = await db
      .insertInto('workflow_versions')
      .values({
        workflow_id: workflowId,
        source_path: '.github/workflows/ci.yml',
        content_digest: digest,
        on_push: true,
        on_pull_request: true,
        on_dispatch: true,
        uuid: crypto.randomUUID(),
      })
      .returning(['id'])
      .executeTakeFirst()

    return version?.id ? Number(version.id) : null
  }

  /** The run itself, and a job per declared job. */
  private async run_(
    repositoryId: number,
    versionId: number,
    pull: { id: unknown, head_sha: unknown },
    outcome: typeof OUTCOMES[number],
    number: number,
  ): Promise<number> {
    const finished = outcome.status === 'completed'

    const run = await db
      .insertInto('workflow_runs')
      .values({
        workflow_version_id: versionId,
        repository_id: repositoryId,
        number,
        state: RUN_STATE[outcome.label] ?? 'succeeded',
        event: 'pull_request',
        head_sha: String(pull.head_sha),
        pull_request_id: Number(pull.id),
        started_at: minutesBefore(number * 7 + 4),
        finished_at: finished ? minutesBefore(number * 7) : null,
        attempt: 1,
        approval_state: 'not-required',
        uuid: crypto.randomUUID(),
      })
      .returning(['id'])
      .executeTakeFirst()

    if (!run?.id)
      return 0

    await db
      .insertInto('workflow_jobs')
      .values(JOBS.map((job, index) => {
        const conclusion = outcome.conclusions[index] ?? null

        return {
          workflow_run_id: Number(run.id),
          job_id: job.id,
          name: job.name,
          position: index,
          state: jobState(conclusion, outcome.status),
          runs_on: 'ubuntu-latest',
          needs: index === 0 ? null : JSON.stringify([JOBS[index - 1]!.id]),
          started_at: conclusion === null && outcome.status !== 'in_progress' ? null : minutesBefore(number * 7 + 4 - index),
          finished_at: conclusion === null ? null : minutesBefore(number * 7 + 1 - index),
          uuid: crypto.randomUUID(),
        }
      }))
      .execute()

    return 1
  }

  /**
   * The reports the checks tab reads: a check run per job, plus one status.
   *
   * Both kinds, because the panel merges them and they arrive by different
   * routes - a check run is reported through the checks API by something that
   * knows about jobs, a commit status is the older, simpler shape an external
   * service posts. A panel exercised with only one of them leaves the merge
   * untested by eye.
   */
  private async checks(
    repositoryId: number,
    headSha: string,
    pull: { number: unknown },
    outcome: typeof OUTCOMES[number],
  ): Promise<number> {
    const rows = JOBS.map((job, index) => {
      const conclusion = outcome.conclusions[index] ?? null
      const done = conclusion !== null

      return {
        repository_id: repositoryId,
        head_sha: headSha,
        name: job.name,
        status: done ? 'completed' : (index === 1 && outcome.status === 'in_progress' ? 'in_progress' : 'queued'),
        conclusion,
        summary: summaryFor(job.name, conclusion),
        details_url: `/runs`,
        started_at: index === 0 || done || outcome.status === 'in_progress' ? minutesBefore(12 - index) : null,
        completed_at: done ? minutesBefore(8 - index) : null,
        provider: 'reviewos',
        // Deterministic, and unique by construction: the column carries a
        // unique index precisely so a reporter that retries cannot create a
        // second row for one report.
        idempotency_key: `seed:${repositoryId}:${headSha}:${job.name}`,
        output_title: conclusion === 'failure' ? 'One assertion failed' : null,
        output_text: conclusion === 'failure' ? 'greet.ts:3 expected "hello who" and received "hello"' : null,
        attempt: 1,
        uuid: crypto.randomUUID(),
      }
    })

    await db.insertInto('check_runs').values(rows).execute()

    /*
     * An annotation on the failing check, on a line that exists.
     *
     * `greet.ts` is three lines long in every seeded repository and is the file
     * the review threads already anchor to, so an annotation on line 3 lands on
     * a line a reader can actually see in the diff. An annotation past the end
     * of a file renders nowhere, which is the failure mode worth avoiding here:
     * it looks like the annotation feature does not work.
     */
    const failing = await db
      .selectFrom('check_runs')
      .select(['id'])
      .where('repository_id', '=', repositoryId)
      .where('head_sha', '=', headSha)
      .where('conclusion', '=', 'failure')
      .executeTakeFirst()

    if (failing?.id) {
      await db
        .insertInto('check_annotations')
        .values([
          {
            check_run_id: Number(failing.id),
            repository_id: repositoryId,
            path: 'greet.ts',
            start_line: 3,
            end_line: 3,
            side: 'right',
            level: 'failure',
            title: 'Assertion failed',
            message: 'expected "hello who" and received "hello"',
            raw_details: null,
          },
          {
            check_run_id: Number(failing.id),
            repository_id: repositoryId,
            path: 'greet.ts',
            start_line: 1,
            end_line: 1,
            side: 'right',
            level: 'warning',
            title: 'Missing return type',
            message: 'the exported function has no declared return type',
            raw_details: null,
          },
        ])
        .execute()
    }

    await db
      .insertInto('commit_statuses')
      .values({
        repository_id: repositoryId,
        sha: headSha,
        context: 'coverage/reviewos',
        state: outcome.label === 'failing' ? 'failure' : (outcome.label === 'running' ? 'pending' : 'success'),
        description: outcome.label === 'failing' ? 'coverage fell by 1.4%' : 'coverage held at 88%',
        target_url: `/runs`,
      })
      .execute()

    return rows.length
  }

  /** One test suite per repository, which the managed tests and runs hang off. */
  private async suite(repositoryId: number, name: string): Promise<number | null> {
    /*
     * Looked up before it is inserted, for the reason `workflow()` is: this
     * seeder is not a transaction, and `test_suites` carries a unique index per
     * repository.
     *
     * The repository gate above keys on `workflow_runs`, so any state where the
     * suite exists and the runs do not - a partial failure, or somebody
     * clearing the run tables to re-report - sent a second insert at that index
     * and took the whole seeder down with
     * `duplicate key value violates unique constraint "test_suites_repository_index"`.
     * Partial state has to converge.
     */
    const existing = await db
      .selectFrom('test_suites')
      .select(['id'])
      .where('repository_id', '=', repositoryId)
      .executeTakeFirst()

    if (existing?.id)
      return Number(existing.id)

    const suite = await db
      .insertInto('test_suites')
      .values({
        repository_id: repositoryId,
        name: 'bun test',
        slug: `${name}-bun-test`.toLowerCase().replace(/[^a-z0-9-]/g, '-'),
        uuid: crypto.randomUUID(),
      })
      .returning(['id'])
      .executeTakeFirst()

    return suite?.id ? Number(suite.id) : null
  }

  /** The tracked tests, one of them flaky so the trend screen has something to say. */
  private async managedTests(repositoryId: number, suiteId: number): Promise<number[]> {
    // Same reasoning as the suite: reuse what the suite already tracks rather
    // than tracking each test twice.
    const already = await db
      .selectFrom('managed_tests')
      .select(['id'])
      .where('test_suite_id', '=', suiteId)
      .orderBy('id')
      .execute()

    if (already.length > 0)
      return already.map(row => Number(row.id))

    const ids: number[] = []

    for (const [index, name] of TESTS.entries()) {
      const flaky = index === 2

      const row = await db
        .insertInto('managed_tests')
        .values({
          test_suite_id: suiteId,
          repository_id: repositoryId,
          scope: name.split(' > ')[0] ?? null,
          name,
          state: 'enabled',
          flaky,
          flaky_reason: flaky ? 'passed on retry in 3 of the last 10 runs' : null,
          flaky_since: flaky ? minutesBefore(60 * 24 * 6) : null,
          uuid: crypto.randomUUID(),
        })
        .returning(['id'])
        .executeTakeFirst()

      if (row?.id)
        ids.push(Number(row.id))
    }

    return ids
  }

  /** A test run for one pull request, and an execution per tracked test. */
  private async testRun(
    repositoryId: number,
    suiteId: number,
    managed: readonly number[],
    pull: { id: unknown, head_sha: unknown, base_branch: unknown },
    outcome: typeof OUTCOMES[number],
  ): Promise<number> {
    // The third test is the flaky one, and the failing outcome is where it
    // reports red; everywhere else it passes, which is what makes it flaky
    // rather than broken.
    const failedIndex = outcome.label === 'failing' ? 2 : -1

    const run = await db
      .insertInto('test_runs')
      .values({
        test_suite_id: suiteId,
        repository_id: repositoryId,
        head_sha: String(pull.head_sha),
        branch: String(pull.base_branch ?? 'main'),
        pull_request_id: Number(pull.id),
        source: 'junit',
        passed: failedIndex === -1 ? managed.length : managed.length - 1,
        failed: failedIndex === -1 ? 0 : 1,
        skipped: 0,
        muted_failures: 0,
        duration_ms: 4_200 + managed.length * 90,
        uuid: crypto.randomUUID(),
      })
      .returning(['id'])
      .executeTakeFirst()

    if (!run?.id)
      return 0

    await db
      .insertInto('test_executions')
      .values(managed.map((managedId, index) => ({
        test_run_id: Number(run.id),
        managed_test_id: managedId,
        repository_id: repositoryId,
        result: index === failedIndex ? 'failed' : 'passed',
        duration_ms: 120 + index * 35,
        retries: index === 2 ? 1 : 0,
        failure_message: index === failedIndex ? 'expected "hello who" and received "hello"' : null,
        failure_stack: index === failedIndex ? 'at greet (greet.ts:3:11)' : null,
        tags: null,
        uuid: crypto.randomUUID(),
      })))
      .execute()

    return managed.length
  }

  /**
   * Two checks required on the default branch, where a rule already exists.
   *
   * The third empty state on the tab was "No checks are required on this
   * branch", and that one is not about reports at all: it reads
   * `protected_branches.required_checks`, which every seeded rule carried as an
   * empty array. Only rules that are already there are touched, so this does
   * not invent protection for a repository that has none.
   */
  private async requireChecks(repositoryId: number, branch: string): Promise<void> {
    const rule = await db
      .selectFrom('protected_branches')
      .select(['id', 'required_checks'])
      .where('repository_id', '=', repositoryId)
      .where('pattern', '=', branch)
      .executeTakeFirst()

    if (!rule?.id)
      return

    const current = String(rule.required_checks ?? '[]')

    // Already named some. A rule somebody configured is not this seeder's to
    // rewrite.
    if (current !== '[]' && current !== '' && current !== 'null')
      return

    await db
      .updateTable('protected_branches')
      .set({ required_checks: JSON.stringify(['lint', 'test']) })
      .where('id', '=', rule.id)
      .execute()
  }
}

/** The job state that matches a check conclusion. */
function jobState(conclusion: string | null, status: string): string {
  if (conclusion === 'failure')
    return 'failed'

  if (conclusion === 'cancelled')
    return 'cancelled'

  if (conclusion === 'neutral')
    return 'skipped'

  if (conclusion === 'success')
    return 'succeeded'

  return status === 'in_progress' ? 'running' : 'queued'
}

/** What a check says about itself, which is the line the panel shows. */
function summaryFor(job: string, conclusion: string | null): string {
  switch (conclusion) {
    case 'success':
      return `${job} passed`
    case 'failure':
      return `${job} failed: 1 of 42 assertions`
    case 'cancelled':
      return `${job} was cancelled when a newer commit arrived`
    case 'neutral':
      return `${job} had nothing to do on this commit`
    default:
      return `${job} is waiting for a runner`
  }
}

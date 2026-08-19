export interface CommandConfig {
  /** The command file name (without .ts extension) */
  file: string
  /** Whether the command is enabled */
  enabled?: boolean
  /** Command aliases */
  aliases?: string[]
}

export type CommandRegistry = Record<string, string | CommandConfig>

/**
 * The application's command registry.
 *
 * Commands listed here will be auto-loaded by the CLI.
 * You can use a simple string (file name) or a config object for more control.
 *
 * @example
 * // Simple registration
 * 'inspire': 'Inspire',
 *
 * // With config
 * 'send-emails': {
 *   file: 'SendEmails',
 *   enabled: true,
 *   aliases: ['emails', 'mail'],
 * },
 */
export default {
  /*
   * The contributor-facing CLI, all in one file.
   *
   * Registered under `review` because the registry keys a file rather than a
   * command name - the file declares `login`, `pr`, `stack` and `review`
   * itself, which is what a person types.
   */
  'review': 'Review',

  // `instance:check`, for after a deploy that did not go well and for a
  // container's start script.
  'instance': 'Doctor',

  // The API and webhook reference, written by the code that implements them.
  // `--check` is what a test uses to notice the committed pages have drifted.
  'docs:reference': 'DocsReference',

  /*
   * The Open Graph cards used to be here as `social:card`: one card, written
   * as HTML and screenshotted through headless Chrome. `buddy generate:images`
   * replaces it, drawing a card per route from `config/images.ts` with
   * ts-images and no browser anywhere in the pipeline.
   */

  'inspire': 'Inspire',
  'seed:demo': 'SeedDemo',
  'export:repository': 'ExportRepository',
  'import:git': 'ImportGit',
  'import:github': 'ImportGitHub',
  'import:buildkite': 'ImportBuildkite',
  'workflow:build': 'WorkflowBuild',
  'fleet:apply': 'FleetApply',
  'mirror:add': 'MirrorAdd',
  'git:hooks': 'GitHooks',
  'git:restore': 'GitRestore',
  'git:scan': 'GitScan',
  'git:ssh': 'GitSsh',
  'push:keys': 'PushKeys',

  /*
   * The single-tenant execution plane. A command rather than a setting on
   * purpose: this instance does not execute repository code unless an operator
   * has said where, and typing this is that.
   */
  'runner:local': 'RunnerLocal',
  /*
   * The runner as a program to copy to a fleet machine. The same executor
   * `runner:local` uses, compiled: a fleet is machines that are not this one,
   * and installing the whole application on a build agent is not a reasonable
   * thing to ask.
   */
  'build:runner': 'BuildRunner',
  /*
   * Run the tests and report the results, from any CI.
   *
   * Thin on purpose: Bun already emits JUnit, so this carries the four facts a
   * report needs and a test runner does not know - repository, commit, branch,
   * and an idempotency key - and nothing else.
   */
  'tests:report': 'ReportTests',
  /*
   * The pipeline surface from a terminal: validate, dispatch, inspect, follow,
   * unblock, cancel, re-run.
   *
   * A client of the public API and nothing else. A command that reached the
   * database would work on the instance's own machine and nowhere else, and
   * would stop being a test of whether the API is usable by anybody.
   */
  'ci:validate': 'Ci',
  'ci:runs': 'Ci',
  'ci:run': 'Ci',
  'ci:logs': 'Ci',
  'ci:dispatch': 'Ci',
  'ci:unblock': 'Ci',
  'ci:cancel': 'Ci',
  'ci:rerun': 'Ci',
  /*
   * The dependency cache's disk, and what the nightly sweep would take.
   *
   * Not in `Ci.ts`, and the exception is deliberate: everything above is a
   * client of the public API, and this reads the database. It answers a
   * question about the instance's disk rather than about anybody's repository,
   * and there is no API for "every repository's cache" that would be safe to
   * expose. It is what makes the collection policy visible before it deletes
   * anything, which the roadmap asks for by name.
   */
  'ci:caches': 'Caches',
  /*
   * Move this instance to another database engine, and prove the copy.
   *
   * Phase 17 makes MySQL the metadata database and every existing install is
   * on Postgres, so the migration is a command rather than a page of
   * instructions: it copies through the drivers, counts both sides, and hashes
   * both sides, because a restore that lands 99% of the rows looks exactly
   * like one that lands all of them.
   */
  'db:migrate-engine': 'DbMigrateEngine',
  /*
   * The Vitess keyspace layout, computed from the schema rather than written
   * down. Vitess mode is opt-in and for large instances only, but the decision
   * about how this schema would shard is one it has to keep being true to - and
   * a decision in prose drifts the first time somebody adds a model.
   */
  'db:keyspaces': 'DbKeyspaces',
  'db:backfill-shard-key': 'DbBackfillShardKey',
  'search:index': 'SearchIndex',
} satisfies CommandRegistry

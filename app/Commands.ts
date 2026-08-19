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
} satisfies CommandRegistry

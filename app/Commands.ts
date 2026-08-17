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

  // The Open Graph card. Chrome renders it, the PNG is committed, and this
  // runs when the copy changes rather than on every build.
  'social:card': 'SocialCard',

  'inspire': 'Inspire',
  'seed:demo': 'SeedDemo',
  'export:repository': 'ExportRepository',
  'import:git': 'ImportGit',
  'import:github': 'ImportGitHub',
  'mirror:add': 'MirrorAdd',
  'git:hooks': 'GitHooks',
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
} satisfies CommandRegistry

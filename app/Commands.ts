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
} satisfies CommandRegistry

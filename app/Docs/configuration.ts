/**
 * The configuration reference, from the two things that already know.
 *
 * `.env.example` is where every variable is named with a default and, usually,
 * a paragraph saying why it exists - written by whoever added the variable, at
 * the moment they understood it. The application's own source is where those
 * variables are read. Neither is a document anybody maintains for the docs
 * site, which is exactly why they are the ones to generate from: a page written
 * separately drifts, and the way it drifts is silent.
 *
 * The drift this replaces was real. `docs/self-hosting.md` documented
 * `SEARCH_HOST` and `SEARCH_KEY` for Meilisearch months after the instance
 * moved to Typesense, and an operator following it would have configured a
 * search engine this application never reads.
 *
 * Two things the page says that a list of names cannot:
 *
 * - **Where each one is read.** A variable with no reader in `app/` is either
 *   the framework's or dead, and both are worth knowing before somebody spends
 *   an evening setting it.
 * - **Which ones are not yours to set.** Git hands a hook `GIT_DIR` and friends
 *   on every push. Listing them beside `APP_KEY` would invite somebody to put
 *   them in `.env`, where they would be wrong for every repository but one.
 */

/** One variable as `.env.example` declares it. */
export interface EnvEntry {
  name: string
  /** The default, verbatim. Empty string when the line is `NAME=`. */
  value: string
  /**
   * Whether the line itself is commented out.
   *
   * A commented assignment means "this is off unless you say otherwise", which
   * is a different fact from an empty value: `# VAPID_PUBLIC_KEY=` is a feature
   * nobody has turned on, `DB_PASSWORD=` is a password that is genuinely blank.
   */
  optional: boolean
  /** The comment block above it, as written. */
  comment: string
}

/**
 * Variables the system sets, which nobody should put in `.env`.
 *
 * The `GIT_*` ones arrive per push, per repository, from git itself: a value in
 * `.env` would be wrong for every repository but the one it was copied from,
 * and the failure is a push that writes objects into another repository's
 * directory.
 *
 * `PATH` and `HOME` are the process's own, read where this instance hands an
 * environment to something it spawns - a git hook, or a step on the local
 * runner. Declaring them would mean an operator setting the shell's `HOME` in a
 * web application's configuration file, which is a worse idea than the missing
 * line this list exists to allow.
 */
export const GIT_SET = new Set([
  'GIT_DIR',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_PUSH_OPTION_COUNT',
  'GIT_TERMINAL_PROMPT',
  'PATH',
  'HOME',
  'LANG',
])

const GROUP_TITLES: Record<string, string> = {
  APP: 'The application',
  AUTH: 'Sessions and tokens',
  AWS: 'AWS',
  BROADCAST: 'Realtime',
  DATABASE: 'Database',
  DB: 'Database',
  DEBUG: 'Development',
  DIFF: 'The diff viewer',
  DOTENV: 'Encrypted values',
  ERROR: 'Error reporting',
  FILESYSTEM: 'Storage',
  FRONTEND: 'Exposed to the browser',
  GIT: 'Git',
  GITHUB: 'GitHub',
  MAIL: 'Email',
  METRICS: 'Metrics',
  PORT: 'Ports',
  QUEUE: 'The queue',
  REDIS: 'Redis',
  REVIEWOS: 'ReviewOS',
  SCREENSHOT: 'Screenshots',
  SEARCH: 'Search',
  SHUTDOWN: 'Stopping',
  SQS: 'SQS',
  SSH: 'SSH',
  SSO: 'Single sign-on',
  STRIPE: 'Stripe',
  SUDO: 'Local development',
  TS: 'Cloud dashboard',
  TYPESENSE: 'Search',
  VAPID: 'Web push',
  WEBHOOK: 'Webhooks',
}

/** `APP_KEY` belongs with `APP_URL`; `DATABASE_URL` belongs with `DB_HOST`. */
export function groupOf(name: string): string {
  const prefix = name.split('_')[0] ?? name

  return GROUP_TITLES[prefix] ?? prefix.charAt(0) + prefix.slice(1).toLowerCase()
}

/**
 * `.env.example`, as entries in the order it declares them.
 *
 * That order is curated - somebody grouped the database values together and
 * put the ones you must set near the top - so the page keeps it rather than
 * sorting alphabetically and scattering them.
 */
export function parseEnvExample(source: string): EnvEntry[] {
  const entries: EnvEntry[] = []
  let comment: string[] = []

  for (const raw of String(source ?? '').split('\n')) {
    const line = raw.trimEnd()

    // A commented-out assignment is an entry, not prose. Reading it as a
    // comment would attach a variable's own line to the next one's paragraph.
    const commented = /^#\s*([A-Z][A-Z0-9_]*)=(.*)$/.exec(line)
    const set = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line)

    if (set || commented) {
      const [, name = '', value = ''] = (set ?? commented)!

      entries.push({
        name,
        value: value.trim(),
        optional: !set,
        comment: comment.join('\n').trim(),
      })

      comment = []
      continue
    }

    if (line.startsWith('#')) {
      comment.push(line.replace(/^#\s?/, ''))
      continue
    }

    // A blank line ends a paragraph's association with what follows. Without
    // this every comment in the file accumulates onto the next variable.
    if (line === '')
      comment = []
  }

  return entries
}

/**
 * The variables the boot check validates, read out of the check itself.
 *
 * Worth marking, because these are the ones where a wrong value stops the
 * instance with a sentence rather than failing quietly a fortnight later. Taken
 * from `app/Ops/config.ts` rather than listed here, so a rule added there shows
 * up on the page without anybody remembering to say so.
 */
export function checkedVariables(source: string): Set<string> {
  return new Set([...String(source ?? '').matchAll(/variable:\s*'([A-Z][A-Z0-9_]*)'/g)].map(match => match[1] ?? ''))
}

/**
 * Which files read each variable, so a reader can go and look.
 *
 * Two passes, because the codebase spells an environment read two ways. Most
 * are `process.env.NAME` or `Bun.env.NAME` and match on sight. The rest arrive
 * as a passed-in object - `app/Ops/config.ts` takes the environment as an
 * argument so its rules are testable without setting a variable in the test
 * runner's own process, and `sshCloneUrlFor` does the same - where the property
 * is `environment.SSH_CLONE_HOST` and no pattern for "env" will find it.
 *
 * So a name already declared in `.env.example` is also matched as a bare
 * property. The false positive that admits - a field that happens to be named
 * `APP_KEY` on something unrelated - is a wrong file path in a list; the false
 * negative it avoids is the page claiming nothing reads a variable that does.
 */
export function envReads(files: Array<{ path: string, source: string }>, known: Set<string> = new Set()): Map<string, string[]> {
  const reads = new Map<string, string[]>()

  const add = (name: string, path: string): void => {
    const paths = reads.get(name) ?? []

    if (!paths.includes(path))
      reads.set(name, [...paths, path])
  }

  for (const { path, source } of files) {
    for (const match of source.matchAll(/(?:Bun\.env|process\.env|\benv)\.([A-Z][A-Z0-9_]{2,})/g))
      add(match[1] ?? '', path)

    if (known.size === 0)
      continue

    for (const match of source.matchAll(/\.([A-Z][A-Z0-9_]{2,})\b/g)) {
      const name = match[1] ?? ''

      if (known.has(name))
        add(name, path)
    }
  }

  return reads
}

/**
 * Variable names in prose, as code.
 *
 * Not cosmetic: `SHUTDOWN_LEAD_MS` in running text is `SHUTDOWN` then an
 * emphasis run, so markdown renders half the name in italics and eats the
 * underscores. The comments in `.env.example` are written for somebody reading
 * a file, where backticks would be noise, so they are added here instead.
 *
 * Text already inside backticks is left alone - it is code twice otherwise, and
 * a fenced block would gain backticks in the middle of a command.
 */
export function codeVariables(text: string, known: Set<string>): string {
  return String(text ?? '')
    .split(/(`[^`]*`)/)
    .map(part => part.startsWith('`')
      ? part
      : part.replace(/\b[A-Z][A-Z0-9_]{2,}\b/g, name => (known.has(name) ? `\`${name}\`` : name)))
    .join('')
}

function describeDefault(entry: EnvEntry): string {
  if (entry.optional)
    return entry.value ? `\`${entry.value}\`, and the line is commented out` : 'unset'

  return entry.value ? `\`${entry.value}\`` : 'empty'
}

/**
 * The page.
 *
 * One section per variable rather than one row: most of these carry a
 * paragraph explaining a decision, and a paragraph in a table cell is a
 * paragraph nobody reads.
 */
export function renderConfiguration(entries: EnvEntry[], reads: Map<string, string[]>, at: string, checked: Set<string> = new Set()): string {
  const declared = new Set(entries.map(entry => entry.name))

  // Read by this application and absent from `.env.example`: a variable
  // somebody can only discover by reading the source, which is the same as
  // undocumented. Listed rather than hidden, because the list is the to-do.
  const undeclared = [...reads.keys()]
    .filter(name => !declared.has(name) && !GIT_SET.has(name) && !runnerOnly(name, reads))
    .sort()

  /*
   * Variables the *runner* reads, which are a different kind of thing.
   *
   * The runner is compiled into a binary and copied to a machine that is not
   * this one, so its variables are set on that machine and belong in nobody's
   * `.env`. Listing them under "add a line to `.env.example`" would be telling
   * an operator to configure the instance for a program that does not run on
   * it.
   */
  const runnerRead = [...reads.keys()]
    .filter(name => runnerOnly(name, reads))
    .sort()

  const out: string[] = [
    '# Configuration',
    '',
    '<!-- Generated by `buddy docs:reference`. Edits here are overwritten; change `.env.example`. -->',
    '',
    'Every variable this instance reads, from `.env.example` and from the source that reads it.',
    'Generated, because a configuration page written separately drifts and does so silently: this',
    'one replaced a hand-written table that still named a search engine the application had stopped',
    'using months earlier.',
    '',
    'Nothing is committed. `.env` is gitignored, values can come from a file instead by naming it in',
    '`<NAME>_FILE`, and `buddy instance:check` reads the ones that have to be right and says which',
    'are wrong and what to do about them.',
    '',
    // Asterisks rather than underscores, because the comments carried over
    // from `.env.example` use asterisks and a document that mixes the two is a
    // lint warning here. One style, chosen by whichever the prose already uses.
    `*Generated ${at}.*`,
    '',
  ]

  const groups = new Map<string, EnvEntry[]>()

  for (const entry of entries) {
    const group = groupOf(entry.name)

    groups.set(group, [...(groups.get(group) ?? []), entry])
  }

  for (const [group, members] of groups) {
    out.push(`## ${group}`, '')

    for (const entry of members) {
      const where = reads.get(entry.name) ?? []

      out.push(`### \`${entry.name}\``, '')
      const boot = checked.has(entry.name)
        ? ' Checked at boot, so a wrong value stops the instance with a sentence rather than failing quietly later.'
        : ''

      out.push(`Default: ${describeDefault(entry)}.${boot}`, '')

      if (entry.comment)
        out.push(codeVariables(entry.comment, declared), '')

      if (where.length > 0)
        out.push(`Read by ${where.map(path => `\`${path}\``).join(', ')}.`, '')
      else
        out.push('*No reader in `app/`, `routes/` or `resources/`: this one is the framework\'s.*', '')
    }
  }

  out.push(
    '## Set by git, not by you',
    '',
    'Git hands these to a hook on every push, per repository. A value for one of them in `.env`',
    'would be wrong for every repository but the one it was copied from, and the failure is a push',
    'writing objects into somebody else\'s directory.',
    '',
    ...[...GIT_SET].sort().map(name => `- \`${name}\``),
    '',
  )

  if (undeclared.length > 0) {
    out.push(
      '## Read but not declared',
      '',
      'These are read by the application and absent from `.env.example`, which means the only way to',
      'find them is to read the source. That is the same as undocumented, so the list is here rather',
      'than nowhere - and the fix is a line in `.env.example`, not a line here.',
      '',
      ...undeclared.map(name => `- \`${name}\`, read by ${(reads.get(name) ?? []).map(path => `\`${path}\``).join(', ')}`),
      '',
    )
  }

  if (runnerRead.length > 0) {
    out.push(
      '## Set where the work runs, not on the instance',
      '',
      'Two programs read their configuration somewhere else: the runner, compiled into a binary and',
      'copied to a machine that is not this one, and `buddy tests:report`, run by whatever CI a',
      'repository already uses. These are set *there* rather than in this instance\'s `.env`. Each',
      'has a command-line flag too, and the flag wins.',
      '',
      ...runnerRead.map(name => `- \`${name}\`, read by ${(reads.get(name) ?? []).map(path => `\`${path}\``).join(', ')}`),
      '',
    )
  }

  return `${out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`
}

/**
 * Whether a variable belongs to a program that runs somewhere else.
 *
 * Three of them: the runner binary, copied to a machine that is not this one;
 * the test collector, run by whatever CI a repository already uses; and the
 * `ci:` commands, which are a client of this instance's API and are as likely
 * to be run from a laptop as from the box. All three read their configuration
 * *there*, so listing them under "add a line to `.env.example`" would be
 * telling an operator to configure this instance for a program that does not
 * run on it.
 */
function runnerOnly(name: string, reads: Map<string, string[]>): boolean {
  const paths = reads.get(name) ?? []

  return paths.length > 0 && paths.every(path =>
    path.includes('Runner/standalone')
    // The runner's own container support, which is configuration of the
    // machine that runs the work rather than of this instance: whether docker
    // or podman is there is a fact about that host.
    || path.includes('Runner/container')
    || path.includes('Commands/ReportTests')
    || path.includes('Commands/Ci'))
}

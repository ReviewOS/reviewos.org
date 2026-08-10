/**
 * Searching a repository's code with `git grep`.
 *
 * ## The approach, decided rather than drifted into
 *
 * `git grep` against a ref: exact, cheap, and already indexed by git itself.
 * It reads the tree at a commit, so results are the code *as it is on that
 * ref* rather than as it was when some indexer last ran - which for a review
 * tool is the difference between an answer and a plausible answer.
 *
 * What it does not do is scale across an instance. Searching a thousand
 * repositories means a thousand processes, and the fix for that is a trigram
 * index - a substantial subsystem with its own storage, its own staleness, and
 * its own failure modes. **That is deliberately not built.** The roadmap says
 * to record the decision rather than leave it implied: in-repository search is
 * genuinely useful on its own, instance-wide search is a separate project, and
 * shipping the second badly is how forges end up with code search everybody
 * distrusts.
 *
 * ## Everything here is about not handing user input to a shell
 *
 * There is no shell - `git` is spawned with an argument array - but `git grep`
 * has its own flags, and a pattern beginning with `-` is read as one. So the
 * pattern goes after `-e`, and paths after `--`, which is what those separators
 * are for. Without them a search for `--help` prints git's help into a page,
 * and a search for `-P` quietly changes the regex engine.
 */

/** What a caller asks for. Everything except `pattern` is optional. */
export interface SearchRequest {
  pattern: string
  ref: string
  /** Treat the pattern as a regular expression rather than a literal. */
  regex?: boolean
  caseSensitive?: boolean
  /** Limit to paths matching these globs, as `git grep -- <pathspec>` takes. */
  paths?: readonly string[]
  /** Limit to a language, by the extensions it is written in. */
  language?: string
  /** Lines of context either side, as the blob view would show them. */
  context?: number
  maxResults?: number
}

export interface SearchMatch {
  path: string
  line: number
  /** The matching line, as it is in the file. */
  text: string
  /** Lines before and after, when context was asked for. */
  before: string[]
  after: string[]
}

/**
 * Extensions per language, for the filter.
 *
 * A small list rather than a complete one, and that is the honest trade: a
 * filter offering four hundred languages nobody has in their repository is
 * worse than one offering the dozen somebody might. It exists so "where is this
 * called from, in the TypeScript only" is answerable without a path glob.
 */
export const LANGUAGE_EXTENSIONS: Record<string, readonly string[]> = {
  typescript: ['ts', 'tsx', 'mts', 'cts'],
  javascript: ['js', 'jsx', 'mjs', 'cjs'],
  python: ['py', 'pyi'],
  go: ['go'],
  rust: ['rs'],
  ruby: ['rb', 'rake'],
  java: ['java'],
  kotlin: ['kt', 'kts'],
  swift: ['swift'],
  c: ['c', 'h'],
  cpp: ['cc', 'cpp', 'cxx', 'hh', 'hpp'],
  php: ['php'],
  shell: ['sh', 'bash', 'zsh'],
  sql: ['sql'],
  css: ['css', 'scss', 'less'],
  html: ['html', 'htm'],
  markdown: ['md', 'mdx'],
  json: ['json'],
  yaml: ['yml', 'yaml'],
  stx: ['stx'],
}

/** How many matches to return at most, however many the pattern has. */
export const MAX_RESULTS = 200

/**
 * The arguments for one search.
 *
 * Built here rather than inline so they can be asserted without running git.
 * The ordering is not cosmetic: `-e` has to come last among the flags because
 * everything after it is the pattern, and `--` has to come after the ref
 * because everything after *that* is a path.
 */
export function searchArgs(request: SearchRequest): string[] {
  const args = ['grep', '--line-number', '--no-color']

  /*
   * `--fixed-strings` unless regex was asked for.
   *
   * The default matters more than it looks. Somebody searching for `foo(bar)`
   * or `a.b.c` in a literal search means those characters, and a default of
   * "regex" turns the first into a group and the second into three wildcards -
   * so the results are wrong in a way that looks like the code is not there.
   */
  args.push(request.regex ? '--extended-regexp' : '--fixed-strings')

  if (!request.caseSensitive)
    args.push('--ignore-case')

  const context = Math.max(0, Math.min(10, Number(request.context ?? 0)))

  if (context > 0)
    args.push(`--context=${context}`)

  // The pattern behind `-e`, so a pattern starting with `-` is a pattern rather
  // than a flag. Without it, searching for `--help` prints git's help.
  args.push('-e', request.pattern)

  args.push(request.ref)

  const paths = pathspecs(request)

  if (paths.length > 0)
    args.push('--', ...paths)

  return args
}

/**
 * The pathspecs a request implies: the caller's paths, and its language.
 *
 * A language becomes `*.ts`, `*.tsx`, and so on. Combined with explicit paths
 * they are unioned, because `git grep` treats multiple pathspecs as alternatives
 * - which is what somebody asking for "TypeScript, under src/" would expect if
 * they thought about it, and they will not think about it.
 */
export function pathspecs(request: SearchRequest): string[] {
  const paths = (request.paths ?? [])
    .map(one => String(one).trim())
    .filter(Boolean)
    // A pathspec beginning with `:` is magic to git - `:(exclude)` and friends -
    // and one arriving from a query string should be a path.
    .filter(one => !one.startsWith(':'))

  const extensions = LANGUAGE_EXTENSIONS[String(request.language ?? '').toLowerCase()] ?? []

  if (extensions.length === 0)
    return paths

  const byLanguage = extensions.map(extension => `*.${extension}`)

  if (paths.length === 0)
    return byLanguage

  /*
   * Both, narrowed to the intersection where git can express it.
   *
   * `src/*.ts` rather than `src/` and `*.ts` as alternatives, because the
   * alternatives would return every TypeScript file in the repository *and*
   * every file under `src`, which is the opposite of narrowing. A path already
   * naming a file is left alone.
   */
  return paths.flatMap((path) => {
    if (/\.\w+$/.test(path))
      return [path]

    const base = path.replace(/\/+$/, '')

    return byLanguage.map(glob => `${base}/**/${glob}`)
  })
}

/**
 * Parse `git grep`'s output into matches.
 *
 * The format is `path:line:text` for a match and `path-line-text` for a context
 * line, and a `--` line separates runs. The separator characters are why this
 * is parsed rather than split: a path can contain a colon, and so can the text,
 * so the split has to be leftmost-twice and no further.
 */
export function parseMatches(output: string, limit = MAX_RESULTS, ref?: string): SearchMatch[] {
  const matches: SearchMatch[] = []

  /*
   * A rolling buffer of context lines seen since the last match.
   *
   * `git grep --context` interleaves them: leading context, the match, trailing
   * context, then `--` before the next run. So a context line belongs to the
   * *next* match if none has been seen since the last separator, and to the
   * previous one otherwise - which is what the buffer and `current` between
   * them say, without needing to know where a run began.
   */
  let leading: string[] = []
  let current: SearchMatch | null = null

  for (const raw of String(output ?? '').split('\n')) {
    if (raw === '' || raw === '--') {
      leading = []
      current = null

      continue
    }

    const parsed = parseLine(raw)

    if (!parsed)
      continue

    if (parsed.kind === 'match') {
      if (matches.length >= limit)
        break

      current = { path: stripRef(parsed.path, ref), line: parsed.line, text: parsed.text, before: leading, after: [] }
      leading = []
      matches.push(current)

      continue
    }

    if (current)
      current.after.push(parsed.text)
    else
      leading.push(parsed.text)
  }

  return matches
}

/**
 * The path without the ref git prefixed it with.
 *
 * `git grep <pattern> main` prints `main:src/cart.ts:3:...`, because it is
 * reporting a path *inside a tree object* rather than in the working
 * directory. Left on, every result's path is wrong by a prefix and every link
 * built from it is a 404 - and it only shows up when a ref is passed, which is
 * always here and never in a shell where somebody would notice.
 */
function stripRef(path: string, ref?: string): string {
  const prefix = `${String(ref ?? '')}:`

  return ref && path.startsWith(prefix) ? path.slice(prefix.length) : path
}

/**
 * One output line, split at the separator pair that has a line number between.
 *
 * `path:line:text` for a match and `path-line-text` for a context line - and
 * git escapes neither separator, so both occur in real paths and constantly in
 * real code. Splitting at the first two occurrences gets `src/a:b.ts:7:x`
 * wrong: it reads a path of `src/a` and a line of `b.ts`, fails to parse it,
 * and drops a genuine match.
 *
 * So the split is chosen by what is *between* the separators: the first pair
 * whose middle is a line number. That is unambiguous in practice, because a
 * path segment that is entirely digits and is followed by the rest of a line is
 * not a shape real output produces.
 */
function parseLine(raw: string): { kind: 'match' | 'context', path: string, line: number, text: string } | null {
  for (const [separator, kind] of [[':', 'match'], ['-', 'context']] as const) {
    let first = raw.indexOf(separator)

    while (first > 0) {
      const second = raw.indexOf(separator, first + 1)

      if (second > first) {
        const between = raw.slice(first + 1, second)

        if (/^\d+$/.test(between)) {
          return { kind, path: raw.slice(0, first), line: Number(between), text: raw.slice(second + 1) }
        }
      }

      if (second < 0)
        break

      first = raw.indexOf(separator, first + 1)
    }
  }

  return null
}

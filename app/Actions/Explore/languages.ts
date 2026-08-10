/**
 * What a repository is written in, by counting bytes.
 *
 * ## Bytes rather than files, because files lie
 *
 * A repository with forty small YAML files and one large Go program is a Go
 * repository, and counting files says it is YAML. Byte counts are what every
 * forge settled on for the same reason, and the difference is not marginal:
 * configuration and lock files outnumber source files in most modern projects.
 *
 * ## What is excluded, and why each one
 *
 * - **Vendored and generated trees.** `node_modules`, `vendor`, `dist`. A
 *   repository that checks in its dependencies is not written in whatever they
 *   are written in, and the breakdown would otherwise say so with total
 *   confidence.
 * - **Lock files.** They are enormous, machine-written, and read by nobody -
 *   `bun.lock` alone would make half this instance's repositories "JSON".
 * - **Anything not recognised.** A breakdown of "43% Other" is not information.
 *   Unknown extensions are dropped from the numerator rather than pooled, so
 *   the percentages describe the code that *is* identified.
 *
 * The extension table is deliberately short. A list of four hundred languages
 * nobody has is worse than the two dozen somebody might, because the long tail
 * is where the misidentifications live - `.ts` is TypeScript here and Qt
 * Linguist somewhere else, and guessing on volume is how a Go repository comes
 * out as "Perl".
 */

/** Extension to language. Lowercase, no leading dot. */
export const EXTENSION_LANGUAGE: Record<string, string> = {
  ts: 'TypeScript',
  tsx: 'TypeScript',
  mts: 'TypeScript',
  cts: 'TypeScript',
  js: 'JavaScript',
  jsx: 'JavaScript',
  mjs: 'JavaScript',
  cjs: 'JavaScript',
  stx: 'STX',
  vue: 'Vue',
  svelte: 'Svelte',
  py: 'Python',
  rb: 'Ruby',
  go: 'Go',
  rs: 'Rust',
  java: 'Java',
  kt: 'Kotlin',
  kts: 'Kotlin',
  swift: 'Swift',
  m: 'Objective-C',
  c: 'C',
  h: 'C',
  cc: 'C++',
  cpp: 'C++',
  cxx: 'C++',
  hpp: 'C++',
  cs: 'C#',
  php: 'PHP',
  ex: 'Elixir',
  exs: 'Elixir',
  erl: 'Erlang',
  hs: 'Haskell',
  scala: 'Scala',
  clj: 'Clojure',
  lua: 'Lua',
  pl: 'Perl',
  r: 'R',
  jl: 'Julia',
  dart: 'Dart',
  zig: 'Zig',
  nim: 'Nim',
  sh: 'Shell',
  bash: 'Shell',
  zsh: 'Shell',
  fish: 'Shell',
  ps1: 'PowerShell',
  sql: 'SQL',
  css: 'CSS',
  scss: 'SCSS',
  less: 'Less',
  html: 'HTML',
  htm: 'HTML',
  svg: 'SVG',
  md: 'Markdown',
  mdx: 'Markdown',
  tex: 'TeX',
  dockerfile: 'Dockerfile',
  tf: 'HCL',
  hcl: 'HCL',
  proto: 'Protocol Buffers',
  graphql: 'GraphQL',
  gql: 'GraphQL',
  yml: 'YAML',
  yaml: 'YAML',
  toml: 'TOML',
  json: 'JSON',
  jsonc: 'JSON',
  xml: 'XML',
}

/** Path segments whose contents are somebody else's code, or generated. */
const EXCLUDED_SEGMENTS = new Set([
  'node_modules',
  'vendor',
  'dist',
  'build',
  'out',
  'target',
  'coverage',
  '.git',
  '.next',
  '.nuxt',
  '.output',
  '.cache',
  'third_party',
  'thirdparty',
])

/** Files that are enormous, machine-written, and read by nobody. */
const EXCLUDED_NAMES = new Set([
  'bun.lock',
  'bun.lockb',
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'composer.lock',
  'gemfile.lock',
  'cargo.lock',
  'poetry.lock',
  'go.sum',
])

/** Whether this path counts towards what the repository is written in. */
export function countsTowardsLanguage(path: string): boolean {
  const segments = String(path ?? '').split('/')
  const name = (segments[segments.length - 1] ?? '').toLowerCase()

  if (!name || EXCLUDED_NAMES.has(name))
    return false

  // Any excluded segment anywhere in the path, not only at the root: a
  // monorepo has `packages/api/node_modules` and it is no more the repository's
  // code than the one at the top would be.
  return !segments.some(segment => EXCLUDED_SEGMENTS.has(segment.toLowerCase()))
}

/**
 * The language a path is in, or null.
 *
 * Matched on the extension, and on the whole name for the few files that have
 * none - `Dockerfile` and `Makefile` are how a repository declares itself and
 * an extension-only table misses both.
 */
export function languageOf(path: string): string | null {
  const name = (String(path ?? '').split('/').pop() ?? '').toLowerCase()

  if (!name)
    return null

  if (name === 'dockerfile' || name.startsWith('dockerfile.'))
    return 'Dockerfile'

  if (name === 'makefile' || name === 'gnumakefile')
    return 'Makefile'

  // A dotfile with no other dot - `.gitignore` - has no extension to read.
  const dot = name.lastIndexOf('.')

  if (dot <= 0)
    return null

  return EXTENSION_LANGUAGE[name.slice(dot + 1)] ?? null
}

export interface LanguageBytes {
  language: string
  bytes: number
  /** Of the identified code, rounded to one decimal. */
  percent: number
}

/**
 * The breakdown for a repository, from its files and their sizes.
 *
 * Percentages are of *identified* code rather than of the tree, which is why
 * they add to a hundred even when half the repository is images. A breakdown
 * whose numbers do not add up is one nobody trusts twice, and "43% Other" is
 * not information anybody can act on.
 */
export function breakdown(files: readonly { path: string, bytes: number }[]): LanguageBytes[] {
  const totals = new Map<string, number>()

  for (const file of files) {
    if (!countsTowardsLanguage(file.path))
      continue

    const language = languageOf(file.path)

    if (!language)
      continue

    totals.set(language, (totals.get(language) ?? 0) + Math.max(0, Number(file.bytes) || 0))
  }

  const identified = [...totals.values()].reduce((sum, bytes) => sum + bytes, 0)

  if (identified === 0)
    return []

  return [...totals.entries()]
    .map(([language, bytes]) => ({
      language,
      bytes,
      percent: Math.round((bytes / identified) * 1000) / 10,
    }))
    // Largest first, and ties by name so two runs of the same repository agree.
    .sort((a, b) => b.bytes - a.bytes || a.language.localeCompare(b.language))
}

/**
 * Parse `git ls-tree -r --long <ref>` into files and sizes.
 *
 * Each line is `<mode> <type> <sha> <size>\t<path>`, and the tab is what
 * separates the path - which is the only reliable separator, because a path may
 * contain spaces and the size column is right-aligned with a variable number of
 * them.
 */
export function parseTree(output: string): { path: string, bytes: number }[] {
  const files: { path: string, bytes: number }[] = []

  for (const line of String(output ?? '').split('\n')) {
    const tab = line.indexOf('\t')

    if (tab < 0)
      continue

    const fields = line.slice(0, tab).trim().split(/\s+/)

    // `<mode> <type> <sha> <size>`. A submodule is `commit` with a size of `-`,
    // and a directory does not appear at all under `-r`.
    if (fields.length < 4 || fields[1] !== 'blob')
      continue

    const bytes = Number(fields[3])

    files.push({ path: line.slice(tab + 1), bytes: Number.isFinite(bytes) ? bytes : 0 })
  }

  return files
}

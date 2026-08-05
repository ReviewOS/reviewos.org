import { readFileSync } from 'node:fs'

/**
 * What a new repository can start with.
 *
 * An empty repository is a dead end: there is nothing to browse, nothing to
 * review, and the only page it can show is instructions for pushing. A first
 * commit turns it into something that works immediately, and the three files
 * people actually want are always the same three.
 *
 * Everything here is pure - it produces file contents, and
 * `writeInitialCommit` puts them in a repository. That split is what lets the
 * licence texts be tested for being *exact*, which for a licence is the whole
 * requirement.
 */

export interface ScaffoldOptions {
  repository: string
  description?: string | null
  readme?: boolean
  gitignore?: string | null
  license?: string | null
  /** Whose name goes in the copyright line. */
  holder?: string | null
  year?: number
}

export interface ScaffoldFile {
  path: string
  content: string
}

/**
 * The licences offered.
 *
 * The texts live in `resources/licenses/*.txt`, verbatim, and the long ones
 * were fetched from their canonical sources rather than typed - apache.org,
 * gnu.org, mozilla.org. **Verbatim or absent** is the rule: a licence is a
 * legal document, and one with a word changed is not the licence it claims to
 * be, so reproducing an eleven-thousand-word text from memory is exactly how a
 * repository ends up carrying something subtly different from what it says.
 *
 * Files rather than string literals in this module for the same reason. A
 * thirty-five thousand character constant in a source file is a constant nobody
 * reviews, and a diff that touches one is a diff nobody can read.
 */
export const LICENSES: Record<string, { name: string, spdx: string }> = {
  'mit': { name: 'MIT License', spdx: 'MIT' },
  'apache-2.0': { name: 'Apache License 2.0', spdx: 'Apache-2.0' },
  'gpl-3.0': { name: 'GNU General Public License v3.0', spdx: 'GPL-3.0-only' },
  'agpl-3.0': { name: 'GNU Affero General Public License v3.0', spdx: 'AGPL-3.0-only' },
  'lgpl-3.0': { name: 'GNU Lesser General Public License v3.0', spdx: 'LGPL-3.0-only' },
  'mpl-2.0': { name: 'Mozilla Public License 2.0', spdx: 'MPL-2.0' },
  'bsd-2-clause': { name: 'BSD 2-Clause License', spdx: 'BSD-2-Clause' },
  'bsd-3-clause': { name: 'BSD 3-Clause License', spdx: 'BSD-3-Clause' },
  'isc': { name: 'ISC License', spdx: 'ISC' },
  'unlicense': { name: 'The Unlicense', spdx: 'Unlicense' },
}

/** Where the texts are, relative to the project. */
export const LICENSE_ROOT = 'resources/licenses'

/**
 * Read once, then remembered.
 *
 * Ten files totalling a hundred kilobytes, and a repository is created rarely -
 * but a licence is also the largest thing this module hands back, and reading
 * thirty-five thousand characters off disk to answer the same question twice is
 * work nobody asked for.
 */
const cache = new Map<string, string>()

function readLicense(key: string): string | null {
  const held = cache.get(key)
  if (held !== undefined)
    return held

  if (!(key in LICENSES))
    return null

  try {
    const text = readFileSync(`${LICENSE_ROOT}/${key}.txt`, 'utf8')
    cache.set(key, text)

    return text
  }
  catch {
    // A missing file is a broken install rather than a bad request, and the
    // caller's answer is the same either way: this licence is not available.
    return null
  }
}

/**
 * Starting `.gitignore` files.
 *
 * Short on purpose. A three-hundred-line template covering every editor anybody
 * has ever used is a file nobody reads and nobody edits, so it accumulates
 * rules for tools the project does not use. These cover the output of the
 * toolchain and nothing else; an editor's own droppings belong in a personal
 * global ignore file rather than in every repository.
 */
export const GITIGNORES: Record<string, { name: string, content: string }> = {
  node: {
    name: 'Node',
    content: `node_modules/
dist/
build/
coverage/
*.log
.env
.env.local
.DS_Store
`,
  },

  bun: {
    name: 'Bun',
    content: `node_modules/
dist/
coverage/
*.log
.env
.env.local
.DS_Store
`,
  },

  python: {
    name: 'Python',
    content: `__pycache__/
*.py[cod]
.venv/
venv/
dist/
build/
*.egg-info/
.pytest_cache/
.mypy_cache/
.coverage
.env
.DS_Store
`,
  },

  go: {
    name: 'Go',
    content: `bin/
dist/
*.exe
*.test
*.out
vendor/
.env
.DS_Store
`,
  },

  rust: {
    name: 'Rust',
    content: `target/
**/*.rs.bk
*.pdb
.env
.DS_Store
`,
  },
}

/** A licence key as somebody may have typed it. Null when it is not one. */
export function licenseKey(raw: unknown): string | null {
  const key = String(raw ?? '').trim().toLowerCase()

  return key && key in LICENSES ? key : null
}

/** A gitignore template name. Null when it is not one. */
export function gitignoreKey(raw: unknown): string | null {
  const key = String(raw ?? '').trim().toLowerCase()

  return key && key in GITIGNORES ? key : null
}

/**
 * A licence, with the year and the holder filled in.
 *
 * Only in the places the licence itself marks for it. The short licences carry
 * `{{year}}` and `{{holder}}` in their copyright line; Apache and the GPLs put
 * `[yyyy]`, `[name of copyright owner]` and `<year>` in the "how to apply this
 * licence" appendix at the end, which is the designated slot and the only place
 * in those documents where a name belongs. Nothing else in a licence is
 * substituted, because nothing else in a licence is variable.
 *
 * An empty holder would leave `Copyright (c) 2026`, which names nobody and is
 * the one part of a licence that has to be right, so it falls back rather than
 * leaving a blank.
 */
export function licenseText(key: string, holder: string, year: number): string | null {
  const text = readLicense(key)
  if (text === null)
    return null

  const named = holder.trim() || 'the repository owners'

  return text
    .replaceAll('{{year}}', String(year))
    .replaceAll('{{holder}}', named)
    // Apache-2.0's appendix.
    .replaceAll('[yyyy]', String(year))
    .replaceAll('[name of copyright owner]', named)
    // The GPL family's.
    .replaceAll('<year>', String(year))
    .replaceAll('<name of author>', named)
}

/**
 * The starting README.
 *
 * The name as a heading and the description under it, and nothing else. A
 * template with headings somebody has to delete is worse than a short file
 * somebody has to extend, because the deleting never happens and every
 * repository ends up with an empty "Contributing" section.
 */
export function renderReadme(repository: string, description?: string | null): string {
  const summary = String(description ?? '').trim()

  return summary ? `# ${repository}\n\n${summary}\n` : `# ${repository}\n`
}

/**
 * The files a new repository starts with, in the order they are committed.
 *
 * Returns an empty list when nothing was asked for, which is what makes "create
 * an empty repository" still the default: a repository somebody is about to
 * push an existing history into must not have a commit of its own, or their
 * first push is a rejected non-fast-forward.
 */
export function scaffoldFiles(options: ScaffoldOptions): ScaffoldFile[] {
  const files: ScaffoldFile[] = []

  if (options.readme)
    files.push({ path: 'README.md', content: renderReadme(options.repository, options.description) })

  const ignore = gitignoreKey(options.gitignore)
  if (ignore)
    files.push({ path: '.gitignore', content: GITIGNORES[ignore]!.content })

  const license = licenseKey(options.license)
  if (license) {
    const text = licenseText(license, String(options.holder ?? ''), options.year ?? new Date().getFullYear())
    if (text)
      files.push({ path: 'LICENSE', content: text })
  }

  return files
}

/** What the first commit says it did. */
export function initialCommitMessage(files: readonly ScaffoldFile[]): string {
  const names = files.map(file => file.path)

  return names.length > 0 ? `Add ${listNames(names)}` : 'Initial commit'
}

function listNames(names: readonly string[]): string {
  if (names.length === 1)
    return names[0]!

  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

/**
 * `hashFiles()`, answered where the files are.
 *
 * The expression language refuses it on the control plane, and that refusal is
 * right: the control plane has a repository, not a checkout, and a hash of the
 * wrong tree restores the wrong cache. The runner has the checkout, so this is
 * where `key: deps-${{ hashFiles('bun.lock') }}` gets its answer - and it has to
 * be *GitHub's* answer, digit for digit, or a key written for Actions names a
 * different cache entry here than the author thinks it does.
 *
 * What Actions does, copied rather than improved:
 *
 * - Every pattern is a glob relative to the workspace, several may be given,
 *   and one starting with `!` excludes. The **last** pattern that matches a
 *   path decides, so `'**\/package-lock.json', '!node_modules/**'` excludes
 *   and the reverse order would put them back.
 * - A pattern that names a directory matches everything under it, which is
 *   `@actions/glob`'s implicit descendants: `hashFiles('src')` is the source
 *   tree, not the empty answer for a path that is not a file.
 * - Dotfiles match, symbolic links are followed, and directories themselves
 *   are never hashed.
 * - The answer is the SHA-256 of each file's own SHA-256 digest, concatenated
 *   in path order - and **the empty string when nothing matched**, which is
 *   what makes `key: x-${{ hashFiles('missing.lock') }}` a stable `x-` rather
 *   than an error.
 *
 * Sorted, where Actions walks the tree in directory order: the documented
 * promise is "a hash of these files", and an order that depends on the
 * filesystem would hand two runners two keys for one checkout.
 */

import { closeSync, openSync, readSync, statSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'

/**
 * The runner's own scratch directory inside the workspace.
 *
 * Never part of the checkout, and full of files that change on every job - a
 * `'**'` that reached it would produce a key nothing ever hits again.
 */
const RUNNER_DIRECTORY = '.reviewos-runner'

interface Pattern {
  negate: boolean
  /** The pattern itself, relative to the workspace. */
  glob: Bun.Glob
  /** The same pattern with `/**` appended, for implicit descendants. */
  descendants: Bun.Glob
  text: string
}

/**
 * A pattern as `@actions/glob` reads it, relative to the workspace.
 *
 * An absolute pattern under the workspace is made relative, because that is the
 * form `${{ github.workspace }}/bun.lock` produces. One outside it can match
 * nothing Actions would hash, so it becomes null rather than a scan of `/`.
 */
function patternOf(raw: string, workspace: string): Pattern | null {
  let text = raw.trim()

  if (!text || text.startsWith('#'))
    return null

  const negate = text.startsWith('!')

  if (negate)
    text = text.slice(1).trim()

  if (isAbsolute(text)) {
    const inside = relative(workspace, text)

    if (inside.startsWith('..') || isAbsolute(inside))
      return null

    text = inside
  }

  text = text.replace(/^(?:\.\/)+/, '').replace(/\/+$/, '')

  if (!text || text === '.')
    text = '**'

  // A pattern that climbs out of the workspace names files Actions refuses to
  // hash, so it is dropped here rather than scanned and filtered afterwards.
  if (text.split('/').includes('..'))
    return null

  return { negate, glob: new Bun.Glob(text), descendants: new Bun.Glob(`${text}/**`), text }
}

function matches(pattern: Pattern, path: string): boolean {
  return pattern.glob.match(path) || pattern.descendants.match(path)
}

/** The SHA-256 of one file, read in pieces so a large one is not held whole. */
function digestOf(path: string): Uint8Array {
  const hasher = new Bun.CryptoHasher('sha256')
  const buffer = new Uint8Array(1 << 20)
  const descriptor = openSync(path, 'r')

  try {
    for (;;) {
      const read = readSync(descriptor, buffer, 0, buffer.length, null)

      if (read <= 0)
        break

      hasher.update(buffer.subarray(0, read))
    }
  }
  finally {
    closeSync(descriptor)
  }

  return hasher.digest() as Uint8Array
}

/** The files the patterns select, relative to the workspace and sorted. */
export function filesFor(workspace: string, patterns: readonly string[]): string[] {
  const root = resolve(workspace)
  const parsed = patterns.map(one => patternOf(one, root)).filter((one): one is Pattern => one !== null)
  const candidates = new Set<string>()

  for (const pattern of parsed.filter(one => !one.negate)) {
    for (const glob of [pattern.glob, pattern.descendants]) {
      for (const path of glob.scanSync({ cwd: root, onlyFiles: true, dot: true, followSymlinks: true }))
        candidates.add(path.replace(/^(?:\.\/)+/, '').split(sep).join('/'))
    }
  }

  const selected: string[] = []

  for (const path of candidates) {
    if (path === RUNNER_DIRECTORY || path.startsWith(`${RUNNER_DIRECTORY}/`))
      continue

    // The last pattern to match decides, which is how a later `!` excludes
    // and a later positive pattern puts something back.
    let included = false

    for (const pattern of parsed) {
      if (matches(pattern, path))
        included = !pattern.negate
    }

    if (!included)
      continue

    const full = resolve(root, path)

    if (!full.startsWith(`${root}${sep}`))
      continue

    // A symbolic link to a directory scans as a file entry on some systems.
    // Directories are never hashed, whichever way they were reached.
    if (!statSync(full).isFile())
      continue

    selected.push(path)
  }

  // Compared as strings, not with the locale: a key must not depend on which
  // language the runner's machine was set up in.
  return selected.sort((one, two) => (one < two ? -1 : one > two ? 1 : 0))
}

/**
 * What `hashFiles(...patterns)` evaluates to in this workspace.
 *
 * Throws when a matched file cannot be read. That is deliberate: the caller
 * turns it into a failed step naming the expression, and the alternative - a
 * hash of the files that happened to be readable - is a cache key that is
 * wrong without saying so.
 */
export function hashFiles(workspace: string, patterns: readonly string[]): string {
  const files = filesFor(workspace, patterns)

  if (files.length === 0)
    return ''

  const combined = new Bun.CryptoHasher('sha256')

  for (const file of files)
    combined.update(digestOf(resolve(workspace, file)))

  return combined.digest('hex')
}

/**
 * A `hashFiles` for one expression context, remembering its answers.
 *
 * A step's `with:`, `env:` and `run:` are interpolated separately, and a key
 * written as `${{ hashFiles('**\/bun.lock') }}` in two of them would otherwise
 * walk a `node_modules` twice for the same answer. Scoped to one context, which
 * is one step: the step before it may have changed the files, so nothing is
 * remembered across steps.
 */
export function hashFilesIn(workspace: string): (patterns: readonly string[]) => string {
  const answers = new Map<string, string>()

  return (patterns) => {
    const key = JSON.stringify(patterns)
    const known = answers.get(key)

    if (known !== undefined)
      return known

    const answer = hashFiles(workspace, patterns)

    answers.set(key, answer)

    return answer
  }
}

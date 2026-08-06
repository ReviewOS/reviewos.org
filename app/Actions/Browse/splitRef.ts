/**
 * Telling a ref from a path when the URL cannot.
 *
 * `/{owner}/{repo}/tree/{ref}/{path}` is the URL every forge uses and it is
 * ambiguous by construction: `fix/rounding/src/index.ts` is a branch called
 * `fix/rounding` holding `src/index.ts`, or a branch called `fix` holding
 * `rounding/src/index.ts`, and nothing in the string says which. Git allows
 * slashes in ref names and people use them - `fix/`, `feat/`, `release/` are
 * the normal shape of a branch name - so this is the common case, not an edge.
 *
 * The router cannot resolve it, because it does not know the repository's
 * refs. Only something holding the ref list can, which is what this does.
 *
 * Splitting on the first slash - which is what a `[ref]/[...path]` route does
 * on its own - sent every slashed branch to a ref that does not exist. Git
 * then resolved nothing, the page fell back to the default branch, and the
 * reader got somebody else's files under the branch name they clicked. No
 * error, no empty page: just the wrong contents, which is the failure mode
 * worth the most trouble to avoid.
 */

export interface RefAndPath {
  /** The ref the URL names, or the first segment when none of the known refs matched. */
  ref: string
  /** Everything after it, with no leading or trailing slashes. */
  path: string
}

/**
 * Split `{ref}/{path}` using the refs that actually exist.
 *
 * Longest match wins: a repository with both `fix` and `fix/rounding` resolves
 * `fix/rounding/src` to the longer branch, because the alternative is that
 * creating `fix` silently changes where every `fix/rounding` link goes.
 *
 * With no match the first segment is the ref, which is the old behaviour and
 * the right fallback: a sha, a tag that has since been deleted, and a typo all
 * land there, and git gives its own answer about each.
 */
export function splitRefAndPath(candidate: string, knownRefs: readonly string[]): RefAndPath {
  const trimmed = trim(candidate)
  if (!trimmed)
    return { ref: '', path: '' }

  let longest = ''
  for (const ref of knownRefs) {
    const name = trim(ref)
    if (!name || name.length <= longest.length)
      continue

    // A prefix match has to end on a segment boundary. Without that, `fix` is
    // a "prefix" of `fixtures/data.json` and the file disappears into a ref
    // name.
    if (trimmed === name || trimmed.startsWith(`${name}/`))
      longest = name
  }

  if (longest)
    return { ref: longest, path: trim(trimmed.slice(longest.length)) }

  const firstSlash = trimmed.indexOf('/')
  return firstSlash === -1
    ? { ref: trimmed, path: '' }
    : { ref: trimmed.slice(0, firstSlash), path: trim(trimmed.slice(firstSlash + 1)) }
}

/**
 * Put one back together for a link.
 *
 * The counterpart of the split, so a page building a URL and a page reading
 * one cannot disagree about the shape. Both halves are already path segments,
 * so neither is encoded here - encoding `fix/rounding` would produce `fix%2F`,
 * which is a ref no git command has heard of.
 */
export function joinRefAndPath(ref: string, path: string): string {
  const left = trim(ref)
  const right = trim(path)

  return right ? `${left}/${right}` : left
}

function trim(value: string | null | undefined): string {
  return (value ?? '').replace(/^\/+|\/+$/g, '')
}

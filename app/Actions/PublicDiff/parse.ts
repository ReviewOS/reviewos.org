/**
 * A GitHub URL, read.
 *
 * The pitch this exists for is a URL swap - change the hostname and the diff
 * opens here - so the first thing this has to do is understand the URL somebody
 * already has. That is not one shape: a pull request is `/pull/123`,
 * `/pull/123/files`, `/pull/123/commits`, `/pull/123.diff` and `/pull/123.patch`,
 * and a reader arrives with whichever one they copied.
 *
 * All of them are the same diff, so all of them resolve to one target and one
 * canonical path. A viewer that treats them as five URLs is a viewer where the
 * same change has five links, none of which is the one to share.
 */

/** What kind of thing a URL points at. Each has its own patch endpoint. */
export type TargetKind = 'pull' | 'commit' | 'compare'

export interface DiffTarget {
  kind: TargetKind
  owner: string
  repository: string
  /** The pull number, the commit sha, or the compare range, as written. */
  ref: string
  /**
   * The path this viewer serves it at, always in one form.
   *
   * A reader who arrived at `.diff` gets redirected here, so a link copied out
   * of the address bar is the same link whichever door they came in through.
   */
  canonical: string
  /**
   * True when the reader asked for the raw patch rather than the viewer.
   *
   * `.diff` and `.patch` are what a script fetches, and answering those with an
   * HTML page would break every one of them. They canonicalize to the viewer
   * for a *browser*, and are served as text when something asks for text.
   */
  raw: 'diff' | 'patch' | null
}

/** Where this viewer lives. One place, so the canonical form has one prefix. */
export const MOUNT = '/view'

/**
 * A GitHub owner or repository name.
 *
 * GitHub's own rule, near enough: letters, digits, hyphens, underscores and
 * dots, and no leading dot. Written as a check rather than trusted, because
 * this value goes into a URL this server then fetches - see `fetch.ts` for the
 * other half of that, which is an allowlist of hosts.
 */
const NAME = /^[\w.-]{1,100}$/

function named(value: string): boolean {
  return NAME.test(value) && !value.startsWith('.') && !value.includes('..')
}

/** A commit sha, in any of the lengths a person pastes. */
const SHA = /^[0-9a-f]{7,40}$/i

/**
 * A compare range: `v6.0...v7.0`, `main...feature`, `a...b` with owners.
 *
 * Deliberately permissive about what a ref may contain, because git's own rule
 * is permissive and a range that GitHub understands is one this viewer should
 * pass along. What it is not permissive about is the shape - two sides and a
 * separator - and anything with a slash-dot-dot in it, which is the path
 * traversal this is standing in front of.
 */
const RANGE = /^[\w.\-/~^]{1,200}(?:\.\.\.|\.\.)[\w.\-/~^:]{1,200}$/

function isRange(value: string): boolean {
  return RANGE.test(value) && !value.includes('/../') && !value.startsWith('../')
}

/** The suffix a raw request carries, stripped from the ref. */
function splitRaw(ref: string): { ref: string, raw: 'diff' | 'patch' | null } {
  if (ref.endsWith('.diff'))
    return { ref: ref.slice(0, -'.diff'.length), raw: 'diff' }

  if (ref.endsWith('.patch'))
    return { ref: ref.slice(0, -'.patch'.length), raw: 'patch' }

  return { ref, raw: null }
}

/**
 * Read a path into a target, or answer null.
 *
 * Takes a *path* rather than a URL, because both doors hand it one: the mounted
 * form (`/view/owner/repo/pull/1`) after its prefix is removed, and the
 * hostname-swap form as it stands. Null means "this is not a diff URL", which
 * every caller answers with a 404 rather than a guess.
 */
export function parseDiffPath(path: string): DiffTarget | null {
  const parts = path.replace(/^\/+/, '').replace(/\/+$/, '').split('/')

  if (parts.length < 4)
    return null

  const [owner, repository, kind, ...rest] = parts as [string, string, string, ...string[]]

  if (!named(owner) || !named(repository))
    return null

  if (kind === 'pull' || kind === 'pulls') {
    const { ref, raw } = splitRaw(rest[0] ?? '')

    // `/files`, `/commits`, `/checks` - the tabs GitHub puts after a pull
    // request number. All of them are the same diff to this viewer, so they are
    // read and dropped rather than refused: refusing them would mean a reader
    // who copied the URL from the tab they were on gets a 404.
    if (!/^\d{1,12}$/.test(ref))
      return null

    return {
      kind: 'pull',
      owner,
      repository,
      ref,
      canonical: `${MOUNT}/${owner}/${repository}/pull/${ref}`,
      raw,
    }
  }

  if (kind === 'commit' || kind === 'commits') {
    const { ref, raw } = splitRaw(rest[0] ?? '')

    if (!SHA.test(ref))
      return null

    return {
      kind: 'commit',
      owner,
      repository,
      ref: ref.toLowerCase(),
      canonical: `${MOUNT}/${owner}/${repository}/commit/${ref.toLowerCase()}`,
      raw,
    }
  }

  if (kind === 'compare') {
    // A compare range can contain slashes - `main...user:feature/x` - so the
    // rest of the path is the range rather than its first segment.
    const { ref, raw } = splitRaw(rest.join('/'))

    if (!isRange(ref))
      return null

    return {
      kind: 'compare',
      owner,
      repository,
      ref,
      canonical: `${MOUNT}/${owner}/${repository}/compare/${ref}`,
      raw,
    }
  }

  return null
}

/**
 * Read a whole URL somebody pasted, of the kind a person actually pastes.
 *
 * `https://github.com/o/r/pull/1`, `github.com/o/r/pull/1`, and the path alone
 * all mean the same thing to somebody typing into a box, so all three are read.
 * The host is checked when it is present: this viewer fetches from GitHub, and
 * accepting a URL pointing anywhere else would make it a fetcher pointed at the
 * internet with a text box in front of it.
 */
export function parseDiffUrl(input: string): DiffTarget | null {
  const trimmed = input.trim()

  if (trimmed === '')
    return null

  if (!trimmed.includes('://') && !trimmed.startsWith('github.com') && !trimmed.startsWith('www.github.com'))
    return parseDiffPath(trimmed)

  let url: URL

  try {
    url = new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`)
  }
  catch {
    return null
  }

  const host = url.hostname.toLowerCase().replace(/^www\./, '')

  if (host !== 'github.com')
    return null

  return parseDiffPath(url.pathname)
}

/**
 * What a release is, and which one is the latest.
 *
 * Both questions look trivial and are not. "Latest" is the answer every
 * download button and every install script depends on, and getting it from
 * `published_at` alone means a patch backported to an old branch and published
 * today becomes the version everybody installs.
 */

/** Fields a release may carry. Absent means "leave it alone" on an edit. */
export interface ReleasePatch {
  tag_name?: string
  name?: string
  body?: string | null
  is_draft?: boolean
  is_prerelease?: boolean
}

export type ReleaseDecision =
  | { ok: true, changes: Record<string, unknown> }
  | { ok: false, error: string, status: number }

/**
 * A tag name that git will accept and a URL can carry.
 *
 * Narrower than git's own rules, deliberately. git permits a tag with a slash
 * in it (`release/1.0`), and this refuses one: a tag name goes into a release
 * URL, and a slash there is a path segment that every route has to be careful
 * about forever. Refusing it costs a naming convention nobody uses for versions.
 */
export function isUsableTagName(name: string): boolean {
  const tag = name.trim()

  if (!tag || tag.length > 100)
    return false

  // git's own refusals, the ones that matter: leading dash reads as an option,
  // `..` and `@{` are revision syntax, and a leading or trailing dot is refused
  // by `check-ref-format`.
  if (tag.startsWith('-') || tag.startsWith('.') || tag.endsWith('.'))
    return false

  if (tag.includes('..') || tag.includes('@{'))
    return false

  return /^[A-Za-z0-9._+-]+$/.test(tag)
}

/**
 * Read a release, for creating or editing one.
 *
 * A draft has no `published_at` and a published release has one, and that is
 * the only place the two are reconciled - the column is not something a caller
 * sets, because "published, with no publication date" is a state nothing else
 * in the product knows how to read.
 */
export function decideRelease(patch: ReleasePatch, nowIso: string, existing?: { is_draft: boolean, published_at: string | null }): ReleaseDecision {
  const changes: Record<string, unknown> = {}

  if (patch.tag_name !== undefined) {
    const tag = String(patch.tag_name).trim()

    if (!isUsableTagName(tag))
      return { ok: false, error: 'That tag name cannot be used', status: 422 }

    changes.tag_name = tag
  }

  if (patch.name !== undefined) {
    const name = String(patch.name).trim()

    if (name.length > 255)
      return { ok: false, error: 'That release name is too long', status: 422 }

    changes.name = name
  }

  if (patch.body !== undefined)
    changes.body = patch.body === null ? null : String(patch.body)

  if (patch.is_prerelease !== undefined)
    changes.is_prerelease = Boolean(patch.is_prerelease)

  if (patch.is_draft !== undefined) {
    const draft = Boolean(patch.is_draft)
    changes.is_draft = draft

    const wasPublished = existing ? !existing.is_draft : false

    if (!draft && !wasPublished)
      changes.published_at = nowIso

    // Back to a draft. The publication date goes with it, because a release
    // that is a draft *and* carries the day it was published is a row nothing
    // else in the product knows how to read.
    if (draft)
      changes.published_at = null
  }

  if (Object.keys(changes).length === 0)
    return { ok: false, error: 'Nothing to change', status: 422 }

  return { ok: true, changes }
}

export interface ReleaseRow {
  tag_name: string
  is_draft?: boolean
  is_prerelease?: boolean
  published_at?: string | null
}

/**
 * Whether a tag names a prerelease.
 *
 * By its suffix, the way every version scheme in use marks one: `v1.0.0-rc.1`,
 * `2.0.0-beta`, `0.4.0-alpha.2`. Offered as a *default* when somebody publishes
 * rather than as a rule, because the flag on the row is the answer and this is
 * only a good guess at what they meant.
 */
export function looksLikePrerelease(tag: string): boolean {
  return /-(?:alpha|beta|rc|pre|preview|canary|next|dev|nightly|snapshot)\b/i.test(tag)
}

/**
 * Compare two version-ish tags, newest first.
 *
 * Semver where both sides look like semver, and byte order where they do not.
 * The comparison people actually notice is `v10` against `v9`: alphabetically
 * `v10` sorts first, so a release list ordered by name shows a two-year-old
 * v1.10.0 above last week's v1.9.0, and every install script that takes the
 * first entry installs the wrong one.
 *
 * A prerelease sorts *below* the release it precedes, which is semver's own
 * rule and the reason `1.0.0-rc.1` must not be offered as the latest `1.0.0`.
 */
export function compareTags(a: string, b: string): number {
  const left = parseVersion(a)
  const right = parseVersion(b)

  if (!left || !right)
    return b.localeCompare(a, 'en')

  for (let index = 0; index < 3; index += 1) {
    const difference = right.numbers[index]! - left.numbers[index]!
    if (difference !== 0)
      return difference
  }

  // Equal numbers: a release outranks its own prereleases.
  if (left.pre === null && right.pre !== null)
    return -1
  if (left.pre !== null && right.pre === null)
    return 1
  if (left.pre === null && right.pre === null)
    return 0

  return comparePrerelease(right.pre!, left.pre!)
}

/**
 * The release a download button should point at.
 *
 * Not "the most recently published", which is the obvious implementation and is
 * wrong in the case that matters: a patch backported to an old branch and
 * published today would become the version everybody installs. Highest version
 * wins, and drafts and prereleases are not candidates at all.
 */
export function latestRelease<T extends ReleaseRow>(releases: readonly T[]): T | null {
  const candidates = releases.filter(release => !release.is_draft && !release.is_prerelease)

  if (candidates.length === 0)
    return null

  return [...candidates].sort((a, b) => compareTags(a.tag_name, b.tag_name))[0] ?? null
}

/** Releases in the order a list shows them: newest version first. */
export function sortReleases<T extends ReleaseRow>(releases: readonly T[]): T[] {
  return [...releases].sort((a, b) => compareTags(a.tag_name, b.tag_name))
}

interface ParsedVersion {
  numbers: [number, number, number]
  /** The dot-separated identifiers after `-`, or null when there are none. */
  pre: string[] | null
}

/**
 * `v1.2.3-rc.1` and friends.
 *
 * A leading `v` is accepted because almost every repository uses one, and a
 * missing patch or minor is filled with zero: `v2` and `v2.0.0` are the same
 * version, and a comparison that says otherwise is a comparison nobody trusts.
 * Build metadata after `+` is dropped, which is semver's rule - it does not
 * affect precedence.
 */
function parseVersion(tag: string): ParsedVersion | null {
  const match = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(tag.trim())

  if (!match)
    return null

  return {
    numbers: [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)],
    pre: match[4] ? match[4].split('.') : null,
  }
}

/**
 * Semver's prerelease comparison, which is not a string comparison.
 *
 * Numeric identifiers compare as numbers, so `rc.9` comes before `rc.10`
 * instead of after it. A numeric identifier always ranks below a non-numeric
 * one, and a shorter list ranks below a longer one with the same prefix -
 * `1.0.0-rc` precedes `1.0.0-rc.1`.
 *
 * Returns a positive number when `a` is the newer of the two, matching
 * `compareTags`, which sorts newest first.
 */
function comparePrerelease(a: string[], b: string[]): number {
  const length = Math.max(a.length, b.length)

  for (let index = 0; index < length; index += 1) {
    const left = a[index]
    const right = b[index]

    if (left === undefined)
      return -1
    if (right === undefined)
      return 1

    const leftNumeric = /^\d+$/.test(left)
    const rightNumeric = /^\d+$/.test(right)

    if (leftNumeric && rightNumeric) {
      if (Number(left) !== Number(right))
        return Number(left) - Number(right)
      continue
    }

    if (leftNumeric !== rightNumeric)
      return leftNumeric ? -1 : 1

    if (left !== right)
      return left.localeCompare(right, 'en')
  }

  return 0
}

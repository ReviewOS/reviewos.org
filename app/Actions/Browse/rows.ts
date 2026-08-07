/**
 * Turning what git said into what a component draws.
 *
 * The components in `resources/components/` take rows that are already
 * decided: a name, a link, a piece of text on the right. That is deliberate.
 * A component with no `<script>` block cannot import anything, and one with a
 * script can - which makes it tempting to build links inside the template, in
 * a file no test can reach. Every rule about what a link looks like lives here
 * instead, and the components stay markup.
 *
 * The links go through `joinRefAndPath` rather than string concatenation for
 * the reason that function exists: a branch called `fix/rounding` is a branch,
 * and a URL that treats its slash as a separator points somewhere else.
 */

import type { CommitSummary } from './load'
import type { TreeEntry } from './parse'
import { joinRefAndPath } from './splitRef'

/** One line of a directory listing. */
export interface TreeRow {
  name: string
  /** Null for a submodule, which points at another repository and has nothing here to open. */
  href: string | null
  /** A size for a file, a short sha for a submodule, and nothing for a directory. */
  meta: string
  /** The icon class, chosen from the entry's type rather than from its name. */
  icon: string
}

/** One entry in the ref picker. */
export interface RefLink {
  name: string
  href: string
  /** Whether this is the ref being looked at, so the picker can say so. */
  isCurrent: boolean
}

const ICONS = {
  tree: 'i-hugeicons-folder-01',
  commit: 'i-hugeicons-git-merge',
  blob: 'i-hugeicons-file-01',
} as const

/**
 * A directory listing, ready to draw.
 *
 * Directories carry no size on purpose. Git does not know one without walking
 * the whole tree, and a number that costs a traversal per row is a number
 * worth doing without.
 */
export function treeRows(
  entries: readonly TreeEntry[],
  base: string,
  ref: string,
  directory: string,
  formatSize: (size: number | null) => string,
  shortSha: (sha: string) => string,
): TreeRow[] {
  return entries.map((entry) => {
    const inside = directory ? `${directory}/${entry.name}` : entry.name

    if (entry.type === 'commit') {
      return {
        name: entry.name,
        href: null,
        meta: shortSha(entry.sha),
        icon: ICONS.commit,
      }
    }

    return {
      name: entry.name,
      href: `${base}/tree/${joinRefAndPath(ref, inside)}`,
      meta: entry.type === 'tree' ? '' : formatSize(entry.size),
      icon: ICONS[entry.type] ?? ICONS.blob,
    }
  })
}

/**
 * The branches or tags a picker offers, each linking to the path being looked
 * at rather than to the repository root.
 *
 * Switching branch from three directories down and landing at the root is the
 * kind of small wrongness that makes a picker not worth using: the whole
 * reason to switch is usually to see this file on the other branch.
 */
export function refLinks(
  names: readonly string[],
  base: string,
  current: string,
  directory: string,
): RefLink[] {
  return names.map(name => ({
    name,
    href: `${base}/tree/${joinRefAndPath(name, directory)}`,
    isCurrent: name === current,
  }))
}

/** One line of a commit history. */
export interface CommitRow {
  sha: string
  /** The seven characters git itself shows. */
  short: string
  subject: string
  href: string
  /** Who, and how long ago, as one sentence rather than two columns to line up. */
  byline: string
}

/**
 * A commit history, ready to draw.
 *
 * The subject is the link because that is what somebody reads and then wants
 * to open; the sha is a second link to the same place, for anybody who is
 * navigating by sha rather than by message.
 *
 * A commit with no subject is possible - `git commit --allow-empty-message` -
 * and renders as a link with nothing in it, which is unclickable in practice.
 * It gets its sha instead, because a row you cannot open is worse than a row
 * that says less than you hoped.
 */
export function commitRows(
  commits: readonly CommitSummary[],
  base: string,
  relativeTime: (when: string) => string,
  shortSha: (sha: string) => string,
): CommitRow[] {
  return commits.map((commit) => {
    const short = shortSha(commit.sha)

    return {
      sha: commit.sha,
      short,
      subject: commit.subject || short,
      href: `${base}/commit/${commit.sha}`,
      byline: `${commit.authorName} committed ${relativeTime(commit.when)}`,
    }
  })
}

/** A signature, as one badge. */
export interface SignatureBadge {
  /** Whether to draw anything at all. */
  show: boolean
  label: string
  /** Which of the three appearances: good, uncertain, or bad. */
  tone: 'good' | 'quiet' | 'bad'
  /** The sentence on hover, and the one a screen reader gets. */
  detail: string
  icon: string
}

/**
 * What a reader is told about a commit signature.
 *
 * Four things are worth being careful about here, and three of them are about
 * not overclaiming.
 *
 * **An unsigned commit gets no badge.** Most commits are unsigned, and marking
 * them would put a warning on nearly every row of every repository - which
 * teaches people to ignore it, and it is the same warning that has to mean
 * something on the day a signature really is bad.
 *
 * **`unknown_key` is not a failure.** The signature may be perfectly good; this
 * server has nothing to check it against. Saying "unverified" rather than
 * "invalid" is the difference between "we do not know" and "we know it is
 * wrong", and only one of those is an accusation.
 *
 * **`unavailable` is about this server, not the commit.** gpg missing or a
 * keyring that could not be written says nothing about who wrote the commit,
 * so it reads as a shrug rather than as a verdict.
 *
 * **`verified` means one specific thing**: the signature is good, *and* the key
 * belongs to somebody here, *and* that key claims the address the commit says
 * wrote it. Anything less is one of the two above.
 */
export function signatureBadge(
  status: 'unsigned' | 'verified' | 'unknown_key' | 'invalid' | 'unavailable',
  signerName?: string | null,
): SignatureBadge {
  switch (status) {
    case 'verified':
      return {
        show: true,
        label: 'Verified',
        tone: 'good',
        detail: signerName
          ? `Signed by a key registered to ${signerName}, matching the address on the commit.`
          : 'Signed by a registered key matching the address on the commit.',
        icon: 'i-hugeicons-checkmark-badge-01',
      }

    case 'invalid':
      return {
        show: true,
        label: 'Invalid',
        tone: 'bad',
        detail: 'This commit carries a signature and the signature does not check out.',
        icon: 'i-hugeicons-alert-02',
      }

    case 'unknown_key':
      return {
        show: true,
        label: 'Unverified',
        tone: 'quiet',
        detail: 'This commit is signed by a key nobody here has registered, so there is nothing to check it against.',
        icon: 'i-hugeicons-help-circle',
      }

    case 'unavailable':
      return {
        show: true,
        label: 'Unverified',
        tone: 'quiet',
        detail: 'This commit is signed, and this server could not check the signature.',
        icon: 'i-hugeicons-help-circle',
      }

    default:
      // Unsigned. Most commits, and not worth a mark.
      return { show: false, label: '', tone: 'quiet', detail: '', icon: '' }
  }
}

/**
 * Who wrote a repository, out of what git says about its commits.
 *
 * Pure: it parses `git shortlog` and shapes the result. Running git lives in
 * `app/Jobs/MeasureContributorsJob.ts`, and storing the answer is what makes
 * this affordable at all - walking a two-hundred-thousand-commit history is
 * seconds of CPU, and no page can spend that.
 *
 * The identity question is the interesting one, and the answer is deliberately
 * dull. Git's author is a name and an email chosen by whoever ran the commit,
 * with no connection to an account here; most contributors to a mirrored
 * repository have none. So a contributor **is** an email address, a person with
 * three addresses appears three times, and a local account is attached only
 * when an address matches one exactly. Every cleverer rule guesses that two
 * strangers are one person, and that guess attributes somebody's commits to
 * somebody else.
 */

/** One author, as git counts them. */
export interface ContributorTally {
  name: string
  /** Lower-cased: git does not, and mail servers do not care. */
  email: string
  commits: number
}

/** How many contributors are kept. Past this the list is a scroll, not a list. */
export const MAX_CONTRIBUTORS = 100

/**
 * Parse `git shortlog -sne`.
 *
 * Each line is a count, a tab or run of spaces, a name, and an address in
 * angle brackets:
 *
 *     ```
 *      1247\tChris <chris@example.com>
 *         3\tA. N. Other <other@example.org>
 *     ```
 *
 * The address is taken from the **last** pair of angle brackets rather than the
 * first, because a display name may legitimately contain them - `Chris <the
 * maintainer> <chris@example.com>` is a real shape - and splitting on the first
 * one puts half a name in the email column, where it becomes the identity the
 * whole table is keyed on.
 *
 * A line without an address is dropped rather than kept under an empty key.
 * Git produces those for commits with a malformed author, and one empty key per
 * repository would collect every one of them into a single fictional person.
 */
export function parseShortlog(stdout: string): ContributorTally[] {
  const tallies: ContributorTally[] = []

  for (const line of String(stdout ?? '').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed)
      continue

    const counted = /^(\d+)\s+(.*)$/.exec(trimmed)
    if (!counted)
      continue

    const commits = Number(counted[1])
    const rest = counted[2] ?? ''

    const open = rest.lastIndexOf('<')
    const close = rest.lastIndexOf('>')

    if (open === -1 || close < open)
      continue

    const email = rest.slice(open + 1, close).trim().toLowerCase()
    const name = rest.slice(0, open).trim()

    if (!email || !Number.isFinite(commits) || commits <= 0)
      continue

    tallies.push({ name: name || email, email, commits })
  }

  return tallies
}

/**
 * The tallies as they are stored: merged by address, biggest first, capped.
 *
 * Merged because one address can appear under several spellings of a name -
 * `Chris`, `chris`, `Chris B` - and `shortlog` groups by the pair, so the same
 * person arrives as three rows the unique index would reject. The name kept is
 * the one on the most commits, which is the spelling that person actually uses.
 *
 * Capped at a hundred. A repository with four thousand contributors has a
 * hundred worth naming and three thousand nine hundred rows that cost a write
 * on every push to show nobody anything.
 */
export function mergeTallies(tallies: readonly ContributorTally[], limit = MAX_CONTRIBUTORS): ContributorTally[] {
  const byEmail = new Map<string, { name: string, commits: number, best: number }>()

  for (const tally of tallies) {
    const existing = byEmail.get(tally.email)

    if (!existing) {
      byEmail.set(tally.email, { name: tally.name, commits: tally.commits, best: tally.commits })
      continue
    }

    existing.commits += tally.commits

    if (tally.commits > existing.best) {
      existing.best = tally.commits
      existing.name = tally.name
    }
  }

  return [...byEmail.entries()]
    .map(([email, value]) => ({ name: value.name, email, commits: value.commits }))
    // By commits, then by address, so two people with the same count come back
    // in the same order twice - a list that shuffles between page loads reads
    // as data that is changing.
    .sort((a, b) => b.commits - a.commits || a.email.localeCompare(b.email, 'en'))
    .slice(0, Math.max(0, limit))
}

/** One row of the contributors list, ready to draw. */
export interface ContributorRow {
  name: string
  commits: number
  /** The commit count as a person reads it: `1.2k`. */
  commitsLabel: string
  /** A profile, when the address belongs to an account here. Empty otherwise. */
  href: string
  avatarUrl: string
  /** What stands in for an avatar: one letter, never a gravatar. */
  initial: string
  /** Whether this contributor has an account on this instance. */
  known: boolean
}

/** An account this instance knows about, keyed by the address git recorded. */
export interface KnownAccount {
  handle: string
  name?: string | null
  avatarUrl?: string | null
}

/**
 * What to call somebody when the commit gave no name.
 *
 * The part before the `@`, never the address. A commit with an empty author
 * name is rare and real, and printing the whole address on a public page is
 * precisely how address harvesting works - the domain is the half that makes it
 * deliverable. `git log` already discloses it to anybody who clones, and that
 * is a different audience from a search engine.
 */
export function displayName(name: string, email: string): string {
  const given = String(name ?? '').trim()

  if (given)
    return given

  const local = String(email ?? '').split('@')[0] ?? ''

  return local || 'Unknown'
}

/**
 * The rows a page draws.
 *
 * A contributor with a local account gets their handle, their avatar and a link
 * to their profile; everybody else gets the name off the commit and no link.
 * Both are shown, and that is the point: on a mirror almost nobody has an
 * account here, and a list that only named the people who did would credit four
 * of the two hundred people who wrote the code.
 *
 * The address is never rendered. It is the key this is grouped by and it is a
 * personal detail that appearing on a public page is exactly how address
 * harvesting works - `git log` already discloses it to anybody who clones, and
 * that is a different audience from a search engine.
 */
export function contributorRows(
  contributors: readonly { name: unknown, email: unknown, commits: unknown }[],
  accounts: ReadonlyMap<string, KnownAccount>,
  formatCount: (value: number) => string,
): ContributorRow[] {
  return contributors.map((contributor) => {
    const email = String(contributor.email ?? '').toLowerCase()
    const account = accounts.get(email) ?? null
    const name = account?.name || account?.handle || displayName(String(contributor.name ?? ''), email)
    const commits = Number(contributor.commits ?? 0)

    return {
      name,
      commits,
      commitsLabel: formatCount(commits),
      href: account ? `/${account.handle}` : '',
      avatarUrl: String(account?.avatarUrl ?? ''),
      initial: (name.trim()[0] ?? '?').toUpperCase(),
      known: Boolean(account),
    }
  })
}

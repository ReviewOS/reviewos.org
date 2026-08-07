/**
 * Who should look at this, based on who has looked at it before.
 *
 * `CODEOWNERS` answers "who is responsible", which is a policy. This answers
 * "who knows this code", which is a fact, and the two disagree often enough to
 * both be worth having: the owner of a directory is frequently not the person
 * who wrote the twelve lines somebody just changed.
 *
 * Three inputs, and the third is what makes it usable rather than merely
 * correct:
 *
 * - **Who touched these paths**, from git. Not the repository at large: a
 *   suggestion that names the most prolific committer for every change is a
 *   suggestion nobody reads twice.
 * - **How recently**, because a file's expert is whoever has been in it lately,
 *   not whoever wrote it in 2019 and has not opened it since.
 * - **How much is already waiting on them.** Without this the same three people
 *   are suggested for everything, get buried, and stop answering - and a queue
 *   that always names the same person is how a review culture ends up with
 *   three bottlenecks and everybody else out of practice.
 *
 * Pure over plain values, so the weighting can be argued about in a test rather
 * than in a browser.
 */

/** One person's history with the paths a pull request touches. */
export interface Contribution {
  /** Whoever this is, as this forge knows them. */
  handle: string
  /** When they last touched one of the changed paths, in milliseconds. */
  lastTouched: number
  /** How many commits of theirs touched them. */
  commits: number
}

export interface Suggestion {
  handle: string
  /** Higher is a better suggestion. Only meaningful against its siblings. */
  score: number
  /** Why they are being suggested, in a phrase, for showing beside the name. */
  reason: string
}

/** A day, in milliseconds. The unit recency is measured in. */
const DAY = 86_400_000

/**
 * How much a contribution still counts, by age.
 *
 * Halves every ninety days. A half-life rather than a cliff because there is no
 * honest date on which somebody stops knowing a file, and a threshold would put
 * one there: two people either side of it would be ranked as though one had
 * never seen the code.
 *
 * Ninety days is a guess, stated as one. It is long enough that a quarter's gap
 * does not erase somebody and short enough that a file's current owner beats
 * the person who wrote it three years ago.
 */
export const RECENCY_HALF_LIFE_DAYS = 90

export function recencyWeight(lastTouched: number, now: number): number {
  const days = Math.max(0, (now - lastTouched) / DAY)

  return 2 ** (-days / RECENCY_HALF_LIFE_DAYS)
}

/**
 * How much somebody's queue discounts them.
 *
 * A reviewer with nothing waiting is worth their full score; each open request
 * takes a share off. Reciprocal rather than subtractive so it can never go
 * negative and never quite reaches zero: somebody buried in requests is still
 * the right suggestion when they are the only person who has touched the file.
 * Being busy is a reason to prefer somebody else, not a reason to be invisible.
 */
export function loadWeight(openRequests: number): number {
  return 1 / (1 + Math.max(0, openRequests) / 3)
}

/**
 * Rank the candidates.
 *
 * `exclude` is the author and anybody already asked. Suggesting the author is
 * absurd, and suggesting somebody who is already on the list makes the feature
 * look broken to the person who just added them.
 */
export function suggestReviewers(options: {
  contributions: readonly Contribution[]
  /** Open review requests per handle. Missing means none. */
  load?: Readonly<Record<string, number>>
  exclude?: readonly string[]
  now: number
  limit?: number
}): Suggestion[] {
  const { contributions, load = {}, exclude = [], now, limit = 3 } = options
  const skip = new Set(exclude.map(one => one.toLowerCase()))

  const ranked = contributions
    .filter(one => one.handle !== '' && !skip.has(one.handle.toLowerCase()))
    .map((one) => {
      const recency = recencyWeight(one.lastTouched, now)
      const waiting = load[one.handle.toLowerCase()] ?? 0

      return {
        handle: one.handle,
        score: one.commits * recency * loadWeight(waiting),
        reason: reasonFor(one, waiting, now),
      }
    })
    .filter(one => one.score > 0)

  // Sorted on a copy by construction - `map` already made one - and tied on the
  // handle so two people with identical histories come back in the same order
  // every time rather than in whatever order git happened to report them.
  ranked.sort((left, right) => right.score - left.score || left.handle.localeCompare(right.handle))

  return ranked.slice(0, Math.max(0, limit))
}

/**
 * Why somebody is being suggested, in a phrase.
 *
 * Shown beside the name. A suggestion nobody can see the reason for is one
 * people click without thinking or ignore entirely, and both are worse than no
 * suggestion: the first sends the review to the wrong person with a shrug.
 */
function reasonFor(contribution: Contribution, waiting: number, now: number): string {
  const days = Math.floor(Math.max(0, (now - contribution.lastTouched) / DAY))
  const when = days === 0 ? 'today' : days === 1 ? 'yesterday' : `${days}d ago`
  const commits = contribution.commits === 1 ? '1 commit' : `${contribution.commits} commits`

  return waiting > 0
    ? `${commits} here, last ${when}, ${waiting} waiting on them`
    : `${commits} here, last ${when}`
}

/**
 * Who has touched these paths, from git.
 *
 * `git log` over the changed paths only, on the base rather than the head: the
 * head's most recent commits are the ones being reviewed, and counting them
 * would suggest the author of the change as the reviewer of it.
 *
 * Bounded by commit count rather than by date. A file touched twice in five
 * years and a file touched daily should both answer, and a date window makes
 * the first one silent.
 */
export async function contributionsFor(options: {
  diskPath: string
  ref: string
  paths: readonly string[]
  limit?: number
}): Promise<Contribution[]> {
  const { diskPath, ref, paths, limit = 200 } = options
  if (paths.length === 0)
    return []

  const { isSafeRevision, runGit } = await import('../Git/git')
  if (!isSafeRevision(ref))
    return []

  // `%ae` and `%at`: the author's email and when they authored it. The
  // committer is whoever ran the rebase, which after any history rewrite is one
  // person for the whole branch and tells you nothing about who knows the code.
  const result = await runGit(diskPath, [
    'log',
    `--max-count=${Math.max(1, Math.min(limit, 2000))}`,
    '--format=%ae%x00%at',
    ref,
    '--',
    ...paths,
  ])

  if (!result.ok)
    return []

  const byEmail = new Map<string, { lastTouched: number, commits: number }>()

  for (const line of result.stdout.split('\n')) {
    const [email, at] = line.split('\0')
    if (!email)
      continue

    const when = Number(at) * 1000
    const existing = byEmail.get(email.toLowerCase())

    if (existing) {
      existing.commits += 1
      existing.lastTouched = Math.max(existing.lastTouched, when)
    }
    else {
      byEmail.set(email.toLowerCase(), { lastTouched: when, commits: 1 })
    }
  }

  return [...byEmail].map(([handle, counts]) => ({ handle, ...counts }))
}

/**
 * Turn the emails git reports into the handles this forge knows.
 *
 * An email with no account here is dropped rather than carried through as
 * itself. `CODEOWNERS` keeps an unresolvable name because the *file* said to
 * ask them and dropping it would misreport what the file says; a suggestion has
 * no such author, and offering to request a review from somebody who cannot be
 * requested is offering a button that does not work.
 */
export async function resolveContributors(contributions: readonly Contribution[]): Promise<Contribution[]> {
  const emails = contributions.map(one => one.handle).filter(Boolean)
  if (emails.length === 0)
    return []

  const rows: any[] = await db
    .selectFrom('users')
    .select(['handle', 'email'])
    .where('email', 'in', emails)
    .execute()

  const handleFor = new Map<string, string>()
  for (const row of rows)
    handleFor.set(String(row.email).toLowerCase(), String(row.handle))

  const merged = new Map<string, Contribution>()

  for (const one of contributions) {
    const handle = handleFor.get(one.handle.toLowerCase())
    if (!handle)
      continue

    // One person, two email addresses, is ordinary. Merging them here rather
    // than ranking them twice is the difference between somebody appearing at
    // the top and appearing twice in the middle.
    const existing = merged.get(handle)
    if (existing) {
      existing.commits += one.commits
      existing.lastTouched = Math.max(existing.lastTouched, one.lastTouched)
    }
    else {
      merged.set(handle, { handle, commits: one.commits, lastTouched: one.lastTouched })
    }
  }

  return [...merged.values()]
}

/**
 * How many open review requests each of these people already has.
 *
 * `whereNull` rather than `where(column, 'is', null)`. The second binds the
 * null as a parameter and emits `"responded_at" is $2`, which Postgres answers
 * with `syntax error at or near "$2"` - the same family as the `IN`-on-a-write
 * and empty-`SET` defects the roadmap records, and `MirrorMetadataSyncJob` has
 * a note about the `is not` half of it.
 *
 * It failed loudly here only because nothing was catching it. Wrapped in the
 * `try` this function is called from, it would have returned an empty load and
 * every suggestion would have quietly ignored how busy anybody was - which is
 * the whole reason the load term exists.
 */
export async function reviewLoad(handles: readonly string[]): Promise<Record<string, number>> {
  if (handles.length === 0)
    return {}

  const rows: any[] = await db
    .selectFrom('pull_request_reviewers')
    .innerJoin('users', 'users.id', '=', 'pull_request_reviewers.reviewer_id')
    .innerJoin('pull_requests', 'pull_requests.id', '=', 'pull_request_reviewers.pull_request_id')
    .select(['users.handle as handle'])
    .where('users.handle', 'in', handles.map(one => one.toLowerCase()))
    .whereNull('pull_request_reviewers.responded_at')
    .where('pull_requests.state', '=', 'open')
    .execute()

  const load: Record<string, number> = {}
  for (const row of rows) {
    const key = String(row.handle).toLowerCase()
    load[key] = (load[key] ?? 0) + 1
  }

  return load
}

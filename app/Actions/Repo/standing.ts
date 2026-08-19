/**
 * Where a reader stands with a repository: have they starred it, are they
 * watching it, and how many others are.
 *
 * `stars` and `watches` have had a table, a model, an endpoint and a unique
 * index since phase 1, and no control anywhere in the interface - so the only
 * way to star a repository on this forge was to post to the API by hand, and
 * `stars_count` was a column the seeder filled and nothing else ever moved.
 *
 * The shaping is pure and separate from the reading for the usual reason: what
 * a button *says* is a rule, and a rule in a template is a rule no test can
 * reach. See `app/Actions/Browse/rows.ts` for the same split.
 */

/** What somebody asked to hear about, or null when they never said. */
export type Subscription = 'all' | 'participating' | 'ignore' | null

export interface RepositoryStanding {
  stars: number
  /** Whether *this* reader has starred it. False for a signed-out reader. */
  starred: boolean
  watchers: number
  subscription: Subscription
  forks: number
}

/**
 * The counts and the reader's own answer, in one round trip each.
 *
 * Counted rather than read off `repositories.stars_count`, because the column
 * is a cache that only the star endpoint maintains and a page that draws the
 * wrong number beside a button somebody just pressed is the one place the
 * staleness is visible. `recountStars` writes the column back on every toggle;
 * this is what the page believes in between.
 *
 * Never throws. A header that renders without a star button is a small loss; a
 * server script that throws renders the whole page with every variable
 * undefined - see the notes in `resources/components/RepoBrowser.stx`.
 */
export async function standingFor(repositoryId: unknown, viewerId: unknown): Promise<RepositoryStanding> {
  const id = Number(repositoryId)
  const viewer = Number(viewerId) || null
  const empty: RepositoryStanding = { stars: 0, starred: false, watchers: 0, subscription: null, forks: 0 }

  if (!Number.isFinite(id) || id <= 0)
    return empty

  try {
    const [stars, watchers, mine, watching, repository] = await Promise.all([
      db.selectFrom('stars').select(db.fn.count('id').as('n')).where('repository_id', '=', id).executeTakeFirst(),
      // `ignore` is a row and is not a watcher. "I have decided not to hear
      // about this" is a decision worth storing and is not a subscriber.
      db.selectFrom('watches').select(db.fn.count('id').as('n'))
        .where('repository_id', '=', id).where('subscription', '!=', 'ignore').executeTakeFirst(),
      viewer
        ? db.selectFrom('stars').select(['id']).where('repository_id', '=', id).where('user_id', '=', viewer).executeTakeFirst()
        : Promise.resolve(undefined),
      viewer
        ? db.selectFrom('watches').select(['subscription']).where('repository_id', '=', id).where('user_id', '=', viewer).executeTakeFirst()
        : Promise.resolve(undefined),
      db.selectFrom('repositories').select(['forks_count']).where('id', '=', id).executeTakeFirst(),
    ])

    return {
      stars: Number(stars?.n ?? 0),
      starred: Boolean(mine),
      watchers: Number(watchers?.n ?? 0),
      subscription: (watching?.subscription as Subscription) ?? null,
      forks: Number(repository?.forks_count ?? 0),
    }
  }
  catch {
    return empty
  }
}

/** One control in the header, ready to draw. */
export interface StandingButton {
  label: string
  /** The count beside it, already formatted. Empty when there is none to show. */
  count: string
  /** Whether this reader has already done it, for `aria-pressed` and the tint. */
  pressed: boolean
  /** What the form sends, or empty when the control is a sign-in link. */
  value: string
  icon: string
  /** The sentence on hover, and the one a screen reader gets. */
  title: string
}

/**
 * Counts as people read them.
 *
 * Thousands are abbreviated because the number is a *size*, not a quantity
 * somebody is going to do arithmetic with: "1.2k" and "1,247" carry the same
 * information to a reader scanning a header, and only one of them fits.
 */
export function formatCount(value: number): string {
  const count = Math.max(0, Math.trunc(Number(value) || 0))

  if (count < 1000)
    return String(count)

  if (count < 1_000_000) {
    const thousands = count / 1000

    // One decimal below ten thousand, none above: `9.4k` is useful and
    // `94.3k` is noise on a number nobody is checking.
    return thousands < 10 ? `${trim(thousands.toFixed(1))}k` : `${Math.round(thousands)}k`
  }

  return `${trim((count / 1_000_000).toFixed(1))}m`
}

function trim(value: string): string {
  return value.endsWith('.0') ? value.slice(0, -2) : value
}

/**
 * The star control.
 *
 * One button that toggles, matching the endpoint, and for the endpoint's
 * reason: the page cannot know whether the star it drew has been pressed since
 * it was drawn, so asking it to choose between "star" and "unstar" is asking it
 * to guess - and it guesses wrong for anybody with two tabs open.
 *
 * The count is drawn whether or not it is zero. A repository with no stars
 * showing a bare "Star" and one with four showing "Star 4" makes the control
 * change shape as it is used, and the empty state is worth stating anyway.
 */
export function starButton(standing: RepositoryStanding): StandingButton {
  return {
    label: standing.starred ? 'Starred' : 'Star',
    count: formatCount(standing.stars),
    pressed: standing.starred,
    value: 'toggle',
    icon: standing.starred ? 'i-hugeicons-star' : 'i-hugeicons-star',
    title: standing.starred ? 'You have starred this repository' : 'Star this repository',
  }
}

/** What a watch control offers, in the order it offers them. */
export const WATCH_CHOICES = [
  { value: 'all', label: 'All activity', detail: 'Every issue, pull request and release.' },
  { value: 'participating', label: 'Participating', detail: 'Only threads you are in. The default.' },
  { value: 'ignore', label: 'Ignore', detail: 'Nothing, even threads you are in.' },
  { value: 'none', label: 'Not watching', detail: 'Back to whatever the defaults would say.' },
] as const

/**
 * How the watch control describes the reader's current answer.
 *
 * Four states rather than a toggle, because there are four and the middle one
 * is the one people want. A two-state watch button makes everybody choose
 * between silence and every issue anyone opens, and what they choose is
 * silence - which is `WatchAction`'s own reasoning, restated here so the
 * control cannot disagree with the endpoint.
 *
 * `ignore` and "never decided" are deliberately different. Only the first
 * survives being mentioned in a thread.
 */
export function watchLabel(subscription: Subscription): string {
  switch (subscription) {
    case 'all':
      return 'Watching'
    case 'participating':
      return 'Participating'
    case 'ignore':
      return 'Ignoring'
    default:
      return 'Watch'
  }
}

/** One option in the watch control. */
export interface WatchChoice {
  value: string
  label: string
  detail: string
  selected: boolean
}

/** Everything the header's controls need, already decided. */
export interface RepositoryActions {
  signedIn: boolean
  owner: string
  repository: string
  /** Where the form comes back to, checked again by the action before it is used. */
  next: string
  signInHref: string
  star: StandingButton
  watchers: string
  watchLabel: string
  watching: boolean
  watchTitle: string
  choices: WatchChoice[]
}

/**
 * The header's controls, shaped once.
 *
 * Here rather than in the template for this file's opening reason, and for one
 * more: `next` is a URL that a signed-in POST will be redirected to, so where
 * it comes from is a security question. It is **built from what the page
 * already knows** - the owner, the name, the path being looked at - rather than
 * read from the request, so there is no untrusted input in it at all. The
 * actions still put it through `safeRedirect`, because two checks on a redirect
 * is the right number.
 */
export function repositoryActions(
  standing: RepositoryStanding,
  options: { owner: string, repository: string, path?: string, signedIn: boolean },
): RepositoryActions {
  const owner = String(options.owner ?? '')
  const repository = String(options.repository ?? '')
  const suffix = String(options.path ?? '').replace(/^\/+/, '')
  const next = `/${owner}/${repository}${suffix ? `/${suffix}` : ''}`

  return {
    signedIn: Boolean(options.signedIn),
    owner,
    repository,
    next,
    // The reader lands back where they were, which is the whole point of
    // signing in from here rather than from the nav.
    signInHref: `/login?next=${encodeURIComponent(next)}`,
    star: starButton(standing),
    watchers: formatCount(standing.watchers),
    watchLabel: watchLabel(standing.subscription),
    // `ignore` is watching in the sense that a row exists and not in the sense
    // the button means, so it is not tinted as something already done.
    watching: standing.subscription === 'all' || standing.subscription === 'participating',
    watchTitle: standing.subscription
      ? WATCH_CHOICES.find(choice => choice.value === standing.subscription)?.detail ?? 'Change what you hear about'
      : 'Choose what you hear about this repository',
    choices: WATCH_CHOICES.map(choice => ({
      value: choice.value,
      label: choice.label,
      detail: choice.detail,
      // "Never decided" selects `none`, which is what it is: no row.
      selected: choice.value === (standing.subscription ?? 'none'),
    })),
  }
}

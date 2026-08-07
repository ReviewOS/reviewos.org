import type { EventSubject, NotificationEvent } from '../Notifications/definitions'

/**
 * What each domain event looks like in a feed.
 *
 * The third rendering of the same nine events, and the three are deliberately
 * separate. A notification says "chris requested your review" - second person,
 * because it is addressed to you. A webhook payload says `{action: "opened"}` -
 * a contract another program parses. A feed says "chris opened acme/api#12" -
 * third person, past tense, about somebody else.
 *
 * Merging them is tempting and wrong in a specific way: the notification's
 * "your" becomes a lie the moment the same sentence is shown to a bystander,
 * and a feed that says "your pull request" on somebody else's profile is the
 * kind of error that makes people distrust the whole page.
 *
 * Pure over plain values. The listener writes rows; this decides what they say.
 */

/** Not every event is worth a feed row. */
export type Verb =
  | 'opened_pull_request'
  | 'merged_pull_request'
  | 'closed_pull_request'
  | 'reviewed'
  | 'opened_issue'
  | 'closed_issue'
  | 'commented'
  | 'published_release'

/**
 * The verb for a domain event, or null when it does not belong in a feed.
 *
 * `review:requested` is deliberately absent. Asking somebody for a review is a
 * message to that person, not a public act - and a feed listing "chris
 * requested a review from ada" is a feed that reports who is behind on what to
 * anybody who scrolls it.
 */
export function verbFor(event: NotificationEvent | string): Verb | null {
  switch (event) {
    case 'pr:opened': return 'opened_pull_request'
    case 'pr:merged': return 'merged_pull_request'
    case 'pr:closed': return 'closed_pull_request'
    case 'review:submitted': return 'reviewed'
    case 'issue:opened': return 'opened_issue'
    case 'issue:closed': return 'closed_issue'
    case 'comment:created': return 'commented'
    case 'release:published': return 'published_release'
    default: return null
  }
}

/** How each verb reads, with the actor already named beside it. */
const PHRASES: Record<Verb, string> = {
  opened_pull_request: 'opened',
  merged_pull_request: 'merged',
  closed_pull_request: 'closed',
  reviewed: 'reviewed',
  opened_issue: 'opened',
  closed_issue: 'closed',
  commented: 'commented on',
  published_release: 'released',
}

export interface FeedEntry {
  /** The verb phrase: "opened", "commented on". */
  phrase: string
  /** What it happened to: `acme/api#12`, or `acme/api v1.2.0`. */
  target: string
  /** Where the reader goes. A path, never absolute. */
  url: string
}

/**
 * One row, as a sentence with a link in it.
 *
 * The actor is not included. A profile page has already said whose feed this is
 * and repeating the handle on every line is noise; a dashboard feed renders it
 * separately. Baking it in would make one of those two wrong.
 */
export function describeEntry(entry: {
  verb: string
  repository: string
  number: number | null
  detail: string
  subjectType: string
}): FeedEntry | null {
  const phrase = PHRASES[entry.verb as Verb]

  // An unrecognised verb renders nothing rather than breaking the page. A feed
  // that refused to load because one row named a verb a later deploy removed
  // is a feed a single revert can take down.
  if (!phrase)
    return null

  const [owner, name] = entry.repository.split('/')

  if (!owner || !name)
    return null

  // A release has a tag rather than a number, and saying "released acme/api"
  // without it is the one thing somebody reading a release entry wants.
  if (entry.verb === 'published_release') {
    return {
      phrase,
      target: entry.detail ? `${entry.repository} ${entry.detail}` : entry.repository,
      url: `/${owner}/${name}/releases`,
    }
  }

  if (entry.number === null)
    return { phrase, target: entry.repository, url: `/${owner}/${name}` }

  return {
    phrase,
    target: `${entry.repository}#${entry.number}`,
    url: entry.subjectType === 'pull_request'
      ? `/${owner}/${name}/pull/${entry.number}`
      : `/${owner}/${name}/issue/${entry.number}`,
  }
}

/**
 * The row to write for an event, or null to write nothing.
 *
 * Takes the same payload the notification listener gets, so an event has one
 * shape inside the product and the translation happens in one place per
 * audience rather than at nine call sites per audience.
 */
export function activityFor(
  event: NotificationEvent | string,
  subject: EventSubject & { detail?: string },
): { verb: Verb, detail: string } | null {
  const verb = verbFor(event)

  if (!verb || !subject.actorId)
    return null

  return {
    verb,
    // Everything the sentence needs, so rendering a page of twenty is one
    // query rather than twenty joins across five tables. Stored as it was:
    // an issue renamed since is still the issue somebody opened under the old
    // name, and a feed that silently updates its own history is one nobody can
    // use as a record.
    detail: JSON.stringify({
      repository: `${subject.owner ?? ''}/${subject.repository ?? ''}`,
      number: subject.number ?? null,
      title: String(subject.title ?? '').slice(0, 300),
      tag: subject.detail ?? '',
    }),
  }
}

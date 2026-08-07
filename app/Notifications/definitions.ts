/**
 * What each domain event says, and to whom.
 *
 * One file rather than one class per event, because the differences between
 * them are a sentence and a subject and nothing else. Ten near-identical
 * classes is ten places to forget the rule that matters - do not notify
 * somebody about their own action - and the tenth is always the one that
 * forgets.
 *
 * Every entry is pure: an event payload in, a notification out. Deciding *who*
 * is subscribed is a database question and lives in `recipients.ts`; deciding
 * what they are told is this, and it is testable without one.
 */

/** The events that produce a notification. */
export type NotificationEvent =
  | 'pr:opened'
  | 'pr:merged'
  | 'pr:closed'
  | 'review:requested'
  | 'review:submitted'
  | 'issue:opened'
  | 'issue:closed'
  | 'comment:created'
  | 'release:published'

/** What every domain event carries, whatever else it carries. */
export interface EventSubject {
  /** Who did the thing. Never notified about it. */
  actorId: number
  actorHandle: string
  repositoryId: number
  owner: string
  repository: string
  /** What the notification is about, and what people subscribe to. */
  subjectType: 'issue' | 'pull_request' | 'repository'
  subjectId: number
  /** The issue or pull request number, when there is one. */
  number?: number
  title?: string
  /** Free text the sentence may use: a review verdict, a release tag. */
  detail?: string
}

export interface Notification {
  /** Stored on the row, and what a reader filters an inbox by. */
  type: NotificationEvent
  /** One line. Shown in the inbox and used as an email subject. */
  title: string
  /** Where it goes when clicked. */
  url: string
}

/** `owner/repository#12`, the way people say it out loud. */
function reference(subject: EventSubject): string {
  return subject.number
    ? `${subject.owner}/${subject.repository}#${subject.number}`
    : `${subject.owner}/${subject.repository}`
}

/**
 * Where a notification points.
 *
 * A pull request notification lands on the review screen rather than the
 * conversation: somebody told about a review request is going there next, and a
 * click that needs a second click is a click that gets postponed.
 */
export function urlFor(subject: EventSubject): string {
  const base = `/${subject.owner}/${subject.repository}`

  if (subject.subjectType === 'pull_request' && subject.number)
    return `${base}/pull/${subject.number}/files`

  if (subject.subjectType === 'issue' && subject.number)
    return `${base}/issue/${subject.number}`

  return base
}

/**
 * The sentence one event produces, or null when it produces none.
 *
 * Null rather than an empty string: an event nobody should hear about is a
 * decision, and returning something falsy by accident is how a blank inbox row
 * appears.
 */
export function describe(event: NotificationEvent, subject: EventSubject): Notification | null {
  const where = reference(subject)
  const who = subject.actorHandle
  const what = subject.title ? ` ${subject.title}` : ''

  const title = ((): string | null => {
    switch (event) {
      case 'pr:opened':
        return `${who} opened ${where}:${what}`
      case 'pr:merged':
        return `${who} merged ${where}:${what}`
      case 'pr:closed':
        return `${who} closed ${where} without merging`
      case 'review:requested':
        return `${who} asked you to review ${where}`
      case 'review:submitted':
        // The verdict is the whole point. "somebody reviewed your pull request"
        // makes the reader open it to find out whether they are blocked.
        return `${who} ${subject.detail ?? 'reviewed'} ${where}`
      case 'issue:opened':
        return `${who} opened ${where}:${what}`
      case 'issue:closed':
        return `${who} closed ${where}`
      case 'comment:created':
        return `${who} commented on ${where}`
      case 'release:published':
        return `${who} published ${subject.detail ?? 'a release'} in ${subject.owner}/${subject.repository}`
      default:
        return null
    }
  })()

  return title === null ? null : { type: event, title, url: urlFor(subject) }
}

/**
 * Which subscription reasons an event is worth sending for.
 *
 * `review:requested` is the one that ignores this: it is addressed at a person
 * rather than broadcast to a thread, so it reaches the reviewer whether or not
 * they were watching. Everything else respects why somebody is subscribed -
 * a repository watcher wants to hear that a pull request opened, and does not
 * want every comment on it.
 */
export function reasonsFor(event: NotificationEvent): 'all' | string[] {
  switch (event) {
    case 'review:requested':
      return 'all'
    case 'comment:created':
      // The people in the conversation, not everybody watching the repository.
      return ['author', 'assigned', 'mentioned', 'participating', 'review_requested']
    default:
      return ['author', 'assigned', 'mentioned', 'participating', 'review_requested', 'watching', 'team_mention']
  }
}

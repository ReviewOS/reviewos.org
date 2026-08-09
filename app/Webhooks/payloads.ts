import type { EventSubject, NotificationEvent } from '../Notifications/definitions'

/**
 * What a webhook body looks like, for each event.
 *
 * **This is a public contract.** People build against these shapes and their
 * integrations break when a field moves, so this file is the one place in the
 * product where "obviously better" is not a good enough reason to change
 * anything. Adding a field is safe; renaming one, removing one, or changing a
 * type is a breaking change to somebody else's software, and it happens on a
 * version bump rather than quietly.
 *
 * Three rules the shapes follow, so a receiver can be written once:
 *
 * **Every payload has the same envelope.** `event`, `delivered_at`,
 * `repository`, `sender`, and one key named after what happened. A receiver
 * that has to guess which fields exist for which event is one that grows a
 * switch statement it will get wrong.
 *
 * **Numbers are numbers and times are ISO 8601 strings.** Both survive JSON,
 * both parse in every language, and neither depends on knowing our timezone.
 *
 * **Nothing here is a database row.** These are named fields chosen for the
 * receiver, so a column rename is not a breaking change to somebody's CI. That
 * is worth the transcription cost and it is the whole reason this file exists
 * rather than `JSON.stringify(row)`.
 *
 * Pure over plain values. Nothing here reads the database.
 */

/**
 * Every event that can carry a webhook.
 *
 * Mostly the same set the inbox knows, plus the two an agent needs and a person
 * does not. Webhooks are the supported way for a program to stay current, and a
 * program has different questions from a colleague watching a page.
 */
export const WEBHOOK_EVENTS = [
  'pr:opened',
  /*
   * The head moved: somebody pushed to an open pull request's branch.
   *
   * The single most important event for a reviewing agent and the one that was
   * missing. An agent that reviewed a change and is told nothing when the
   * author pushes a fix has two options, and both are bad: poll every open
   * pull request forever, or never look again. A person has neither problem -
   * they get a notification when somebody re-requests review, and they were
   * going to open the page anyway.
   *
   * Deliberately **not** a notification. Telling every reviewer about every
   * push is how an inbox becomes something people filter, and the thing they
   * filter is the channel that has to work.
   */
  'pr:synchronized',
  /*
   * A draft became ready.
   *
   * An agent configured to review what is ready has no way to notice the
   * transition otherwise: nothing about the pull request changes except a
   * boolean, so there is no push, no comment and no review request to observe.
   */
  'pr:ready_for_review',
  'pr:merged',
  'pr:closed',
  'review:requested',
  'review:submitted',
  'issue:opened',
  'issue:closed',
  'comment:created',
  'release:published',
] as const

export type WebhookEvent = typeof WEBHOOK_EVENTS[number]

/** The `ping` a webhook receives when it is created, so it can be verified at once. */
export const PING_EVENT = 'ping'

export interface Envelope {
  /** The event name, exactly as it appears in a webhook's `events` list. */
  event: string
  /** When this payload was built, ISO 8601. */
  delivered_at: string
  repository: {
    /** `owner/name`. The one field every receiver routes on. */
    full_name: string
    owner: string
    name: string
    id: number
  }
  /**
   * Who caused it. Null when nothing did - a scheduled action, a system event.
   * A receiver that assumes a sender will crash on the day one is missing.
   */
  sender: { handle: string, id: number } | null
}

/**
 * The body for one event.
 *
 * `subject` carries what the event is about and is deliberately the same shape
 * for all nine: a receiver that only cares about "something happened to
 * pull request 42" should not have to know nine field names to find the 42.
 */
export interface WebhookPayload extends Envelope {
  subject: {
    type: 'pull_request' | 'issue' | 'repository'
    id: number
    /** The number people use. Null for a repository-level event. */
    number: number | null
    title: string
    /** A path on this host, not a full URL: the host is the receiver's to know. */
    url: string
  }
  /**
   * What specifically happened, when the event name is not enough.
   *
   * `opened`, `merged`, `closed`, `approved`, `changes_requested`,
   * `commented`, `published`. Present on every payload, so a receiver can
   * switch on one field rather than on the pair.
   */
  action: string
  /** The tag, for a release. Absent otherwise rather than empty. */
  tag?: string
}

/** What `action` each event means. */
const ACTIONS: Record<string, string> = {
  'pr:opened': 'opened',
  'pr:synchronized': 'synchronized',
  'pr:ready_for_review': 'ready_for_review',
  'pr:merged': 'merged',
  'pr:closed': 'closed',
  'review:requested': 'review_requested',
  'review:submitted': 'reviewed',
  'issue:opened': 'opened',
  'issue:closed': 'closed',
  'comment:created': 'commented',
  'release:published': 'published',
}

/**
 * Build the body for one event.
 *
 * Takes the same payload the notification listener gets, so an event has one
 * shape inside the product and one shape on the wire, and the translation
 * between them lives here rather than at nine call sites.
 */
export function webhookPayload(
  event: NotificationEvent | string,
  subject: EventSubject & { detail?: string },
  at: string,
): WebhookPayload {
  const owner = String(subject.owner ?? '')
  const name = String(subject.repository ?? '')
  const type = subject.subjectType === 'issue'
    ? 'issue'
    : subject.subjectType === 'pull_request' ? 'pull_request' : 'repository'

  return {
    event: String(event),
    delivered_at: at,
    repository: {
      full_name: `${owner}/${name}`,
      owner,
      name,
      id: Number(subject.repositoryId ?? 0),
    },
    sender: subject.actorId
      ? { handle: String(subject.actorHandle ?? ''), id: Number(subject.actorId) }
      : null,
    subject: {
      type,
      id: Number(subject.subjectId ?? 0),
      number: subject.number == null ? null : Number(subject.number),
      title: String(subject.title ?? ''),
      url: urlFor(owner, name, type, subject.number),
    },
    action: ACTIONS[String(event)] ?? String(event),
    ...(subject.detail ? { tag: String(subject.detail) } : {}),
  }
}

/**
 * The `ping`, sent when a webhook is created.
 *
 * The same envelope with no subject, because there is nothing it happened to.
 * A receiver that handles the envelope handles this for free, which is the
 * point: verifying an endpoint should exercise the real path, not a special
 * one.
 */
export function pingPayload(
  repository: { id: number, owner: string, name: string },
  sender: { handle: string, id: number } | null,
  at: string,
): Envelope & { zen: string } {
  return {
    event: PING_EVENT,
    delivered_at: at,
    repository: {
      full_name: `${repository.owner}/${repository.name}`,
      owner: repository.owner,
      name: repository.name,
      id: repository.id,
    },
    sender,
    // Present so a receiver has something to log that proves the body arrived
    // intact, and because a ping with an empty body is one people mistake for a
    // failure.
    zen: 'A review is the product. Everything else serves it.',
  }
}

/** A path on this host. The receiver knows its own base URL; we do not. */
function urlFor(owner: string, name: string, type: string, number: unknown): string {
  if (type === 'repository' || number == null)
    return `/${owner}/${name}`

  return type === 'pull_request'
    ? `/${owner}/${name}/pull/${number}`
    : `/${owner}/${name}/issue/${number}`
}

/**
 * Whether a webhook subscribed to this event.
 *
 * `*` means everything, which is what the interface offers as "send me
 * everything" and what most integrations actually want. An empty list means
 * nothing rather than everything: a webhook created with no events selected
 * should be silent, not a firehose.
 */
export function subscribes(events: string, event: string): boolean {
  const list = String(events ?? '')
    .split(',')
    .map(entry => entry.trim())
    .filter(Boolean)

  if (list.includes('*'))
    return true

  return list.includes(event)
}

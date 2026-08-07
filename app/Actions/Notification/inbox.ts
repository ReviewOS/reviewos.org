/**
 * The inbox: what arrived, why, and whether it has been read.
 *
 * `recipients.ts` decides who hears about something and `delivery.ts` decides
 * when. This is the part somebody actually opens, and it has one job the other
 * two do not: it has to be readable when there are four hundred rows in it,
 * because that is the state every real inbox is in by the second week.
 *
 * Pure over plain rows. The action reads the database and hands the rows here,
 * so every rule below can be tested against a literal rather than a fixture.
 *
 * **Nothing here throws on a bad row.** A notification whose `data` will not
 * parse is a notification that already failed once, and dropping the whole page
 * because one row of four hundred is malformed turns a cosmetic defect into an
 * outage of the channel that is supposed to work when the others do not. A row
 * that cannot be read renders as its type, unread, and still links nowhere
 * worse than the inbox itself.
 */

/** Why a notification arrived, in the order the interface offers them. */
export const REASONS = [
  'review_requested',
  'mentioned',
  'assigned',
  'author',
  'participating',
  'team_mention',
  'watching',
] as const

export type Reason = typeof REASONS[number]

/**
 * What each reason means, in the second person.
 *
 * Written as the end of the sentence "you are seeing this because ...", so the
 * inbox can say why a row is there without a legend somebody has to go find.
 * A notification that cannot explain itself is one people mute rather than
 * investigate.
 */
const REASON_LABELS: Record<string, string> = {
  review_requested: 'your review was requested',
  mentioned: 'you were mentioned',
  assigned: 'it is assigned to you',
  author: 'you opened it',
  participating: 'you commented on it',
  team_mention: 'a team you are in was mentioned',
  watching: 'you watch this repository',
}

export function reasonLabel(reason: string): string {
  return REASON_LABELS[reason] ?? 'you are subscribed'
}

/** A row from `notifications`, as the database returns it. */
export interface NotificationRow {
  id: number | string
  type: string
  data: string | null
  read_at?: string | Date | null
  created_at?: string | Date | null
}

/** One line in the inbox, ready to render. */
export interface Entry {
  id: number
  type: string
  title: string
  /** Where the row points. Never empty: a notification nobody can open is noise. */
  url: string
  reason: string
  reasonLabel: string
  /** `owner/name`, or an empty string when the row predates carrying it. */
  repository: string
  number: number | null
  read: boolean
  createdAt: number
}

/** Milliseconds since the epoch, from whatever the driver returned. */
function toEpoch(value: unknown): number {
  if (value instanceof Date)
    return value.getTime()

  if (typeof value === 'number')
    return value

  const parsed = Date.parse(String(value ?? ''))

  return Number.isNaN(parsed) ? 0 : parsed
}

/**
 * A stored row as a line somebody can read.
 *
 * The type is the fallback title rather than a placeholder like "Notification":
 * `pull_request.merged` is ugly but it is true, and a reader can act on it.
 */
export function parseEntry(row: NotificationRow): Entry {
  let data: any = {}

  try {
    data = row.data ? JSON.parse(row.data) : {}
  }
  catch {
    data = {}
  }

  const reason = typeof data.reason === 'string' ? data.reason : 'participating'

  return {
    id: Number(row.id),
    type: String(row.type ?? ''),
    title: typeof data.title === 'string' && data.title ? data.title : String(row.type ?? 'Notification'),
    url: typeof data.url === 'string' && data.url ? data.url : '/notifications',
    reason,
    reasonLabel: reasonLabel(reason),
    repository: typeof data.repository === 'string' ? data.repository : '',
    number: Number.isFinite(Number(data.number)) && data.number !== null ? Number(data.number) : null,
    read: Boolean(row.read_at),
    createdAt: toEpoch(row.created_at),
  }
}

export interface InboxFilter {
  /** One of `REASONS`, or anything else to mean no filter. */
  reason?: string | null
  /** Hide what has been read. */
  unreadOnly?: boolean
  /** `owner/name`. */
  repository?: string | null
}

/**
 * The rows a filter leaves.
 *
 * An unrecognised reason is ignored rather than matched against nothing. A
 * hand-typed query string should not be able to produce an inbox that looks
 * convincingly empty.
 */
export function filterInbox(entries: readonly Entry[], filter: InboxFilter = {}): Entry[] {
  const reason = filter.reason && (REASONS as readonly string[]).includes(filter.reason) ? filter.reason : null
  const repository = filter.repository || null

  return entries.filter((entry) => {
    if (filter.unreadOnly && entry.read)
      return false

    if (reason && entry.reason !== reason)
      return false

    if (repository && entry.repository !== repository)
      return false

    return true
  })
}

export function unreadCount(entries: readonly Entry[]): number {
  return entries.reduce((total, entry) => total + (entry.read ? 0 : 1), 0)
}

/**
 * Repeated notifications about one thing, collapsed to the newest.
 *
 * Six comments on a pull request are six rows and one thing to go and read. The
 * others are counted rather than deleted, so the inbox can say "and 5 more"
 * instead of pretending they did not arrive - and the count is what tells
 * somebody whether the conversation moved on without them.
 *
 * Collapsed by URL rather than by subject id, because the URL is what the
 * reader is being sent to and two rows that lead to the same screen are one
 * trip. Read state is per row, so a group counts as unread if anything in it
 * is: a group that hid one unread row behind five read ones would lose exactly
 * the notification worth keeping.
 */
export interface Group extends Entry {
  /** How many rows this stands for, including itself. */
  count: number
}

export function collapse(entries: readonly Entry[]): Group[] {
  const groups = new Map<string, Group>()

  for (const entry of entries) {
    const key = entry.url
    const existing = groups.get(key)

    if (!existing) {
      groups.set(key, { ...entry, count: 1 })
      continue
    }

    existing.count += 1
    existing.read = existing.read && entry.read

    // The newest row supplies the sentence, because it describes the state the
    // reader is about to find. "review submitted" over "review requested" is
    // the whole point: the older line would send them to do work already done.
    if (entry.createdAt > existing.createdAt) {
      existing.title = entry.title
      existing.type = entry.type
      existing.createdAt = entry.createdAt
      existing.id = entry.id
      existing.reason = entry.reason
      existing.reasonLabel = entry.reasonLabel
    }
  }

  return [...groups.values()].sort((a, b) => b.createdAt - a.createdAt)
}

/**
 * The repositories represented, with how many unread each has.
 *
 * Offered as a filter rather than as a fixed grouping. Somebody with one noisy
 * repository wants to read around it, and somebody on call wants to read only
 * it; a layout that hard-groups serves the first and fights the second.
 */
export function repositoriesIn(entries: readonly Entry[]): { repository: string, unread: number, total: number }[] {
  const counts = new Map<string, { repository: string, unread: number, total: number }>()

  for (const entry of entries) {
    if (!entry.repository)
      continue

    const found = counts.get(entry.repository) ?? { repository: entry.repository, unread: 0, total: 0 }

    found.total += 1
    if (!entry.read)
      found.unread += 1

    counts.set(entry.repository, found)
  }

  return [...counts.values()].sort((a, b) => b.unread - a.unread || a.repository.localeCompare(b.repository))
}

/**
 * How long ago, in the shortest form that is still true.
 *
 * An inbox is scanned rather than read, so "3h" beats "3 hours ago" beside
 * forty other rows. Anything older than a week gets a date, because "9d" stops
 * being a useful answer at about the point somebody has to count on their
 * fingers.
 */
export function shortAge(createdAt: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - createdAt) / 1000))

  if (seconds < 60)
    return 'now'

  const minutes = Math.floor(seconds / 60)
  if (minutes < 60)
    return `${minutes}m`

  const hours = Math.floor(minutes / 60)
  if (hours < 24)
    return `${hours}h`

  const days = Math.floor(hours / 24)
  if (days < 7)
    return `${days}d`

  return new Date(createdAt).toISOString().slice(0, 10)
}

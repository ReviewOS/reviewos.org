/**
 * Writing and reading an issue's history.
 *
 * The shapes are here rather than in each action so every one of them records
 * the same thing the same way: a timeline where "closed" sometimes carries the
 * actor and sometimes does not is worse than one that never carried it, because
 * the gaps look like facts.
 *
 * Recording never fails the thing it describes. An entry is a note about work
 * that already happened, so a failed insert must not turn a successful close
 * into an error - the issue really is closed, and saying otherwise is the one
 * outcome that would be wrong.
 */

export type TimelineKind =
  | 'closed'
  | 'reopened'
  | 'renamed'
  | 'labeled'
  | 'unlabeled'
  | 'assigned'
  | 'unassigned'
  | 'milestoned'
  | 'demilestoned'
  | 'locked'
  | 'unlocked'
  | 'referenced'
  | 'mentioned'
  | 'merged'

export interface TimelineSubject {
  type: 'issue' | 'pull_request'
  id: number
}

export interface TimelineDetail {
  /** A label's name, a milestone's title, the handle assigned. */
  text?: string | null
  /** The old title, on a rename. */
  previous?: string | null
  /** The issue or pull request that caused this, on a cross reference. */
  reference?: number | null
}

/** The row an entry becomes. Pure, so the shape can be tested without a database. */
export function entryRow(
  subject: TimelineSubject,
  kind: TimelineKind,
  actorId: number | null,
  detail: TimelineDetail = {},
): Record<string, unknown> {
  return {
    subject_type: subject.type,
    subject_id: subject.id,
    kind,
    actor_id: actorId,
    external_actor: null,
    // Trimmed and bounded here rather than at each call site: a label name
    // arrives from a form and a title from a request body, and the column is
    // 255 characters wide.
    subject_text: bounded(detail.text),
    previous_text: bounded(detail.previous),
    reference_number: detail.reference ?? null,
  }
}

function bounded(value: string | null | undefined): string | null {
  if (value === undefined || value === null)
    return null

  const text = String(value).trim()

  return text ? text.slice(0, 255) : null
}

/**
 * Record one entry.
 *
 * Swallows its own failure on purpose - see the note at the top of this file.
 * The entry is lost, which costs a line of history; the alternative costs the
 * caller a false error about work that succeeded.
 */
export async function record(
  subject: TimelineSubject,
  kind: TimelineKind,
  actorId: number | null,
  detail: TimelineDetail = {},
): Promise<void> {
  try {
    await db.insertInto('timeline_entries').values(entryRow(subject, kind, actorId, detail)).execute()
  }
  catch {
    // Deliberately silent.
  }
}

/**
 * Several entries at once, for a change that touched a set.
 *
 * One insert rather than one per item: labelling eight issues in bulk should
 * not be eight round trips per issue.
 */
export async function recordMany(entries: Array<{
  subject: TimelineSubject
  kind: TimelineKind
  actorId: number | null
  detail?: TimelineDetail
}>): Promise<void> {
  if (entries.length === 0)
    return

  try {
    await db
      .insertInto('timeline_entries')
      .values(entries.map(entry => entryRow(entry.subject, entry.kind, entry.actorId, entry.detail)))
      .execute()
  }
  catch {
    // Deliberately silent.
  }
}

/**
 * How an entry reads, as a sentence fragment following the actor's name.
 *
 * Kept out of the template so it can be tested, and so the pull request
 * timeline cannot word the same event differently from the issue one.
 */
export function entrySentence(kind: TimelineKind, detail: TimelineDetail = {}): string {
  const text = detail.text ?? ''

  switch (kind) {
    case 'closed': return 'closed this'
    case 'reopened': return 'reopened this'
    case 'merged': return 'merged this'
    case 'locked': return 'locked the conversation'
    case 'unlocked': return 'unlocked the conversation'
    case 'renamed': return `renamed this from ${detail.previous ?? 'its previous title'}`
    case 'labeled': return `added the ${text} label`
    case 'unlabeled': return `removed the ${text} label`
    case 'assigned': return `assigned ${text}`
    case 'unassigned': return `unassigned ${text}`
    case 'milestoned': return `added this to ${text}`
    case 'demilestoned': return `removed this from ${text}`
    // The two ends of a cross reference read from where the reader is standing:
    // on the thing referred to, something else is about it; on the thing that
    // did the referring, it is about something else.
    //
    // The thing doing the referring is an issue most of the time and a commit
    // when the reference came off a push. A commit has no number, so it travels
    // as text - `reference_number` only ever holds a number in this repository,
    // and a column that sometimes holds a sha is a column that gets read wrong.
    case 'referenced': return detail.reference
      ? `referenced this in #${detail.reference}`
      : `referenced this in ${text || 'a commit'}`
    case 'mentioned': return `mentioned #${detail.reference ?? ''}`
    default: return 'changed something'
  }
}

/** The icon for an entry, from the set the layout already ships. */
export function entryIcon(kind: TimelineKind): string {
  switch (kind) {
    case 'closed': return 'i-hugeicons-checkmark-circle-02'
    case 'reopened': return 'i-hugeicons-record'
    case 'merged': return 'i-hugeicons-git-merge'
    case 'locked': return 'i-hugeicons-lock'
    case 'unlocked': return 'i-hugeicons-square-unlock-01'
    case 'renamed': return 'i-hugeicons-pencil-edit-02'
    case 'labeled':
    case 'unlabeled': return 'i-hugeicons-tag-01'
    case 'assigned':
    case 'unassigned': return 'i-hugeicons-user-01'
    case 'milestoned':
    case 'demilestoned': return 'i-hugeicons-flag-02'
    case 'referenced':
    case 'mentioned': return 'i-hugeicons-link-02'
    default: return 'i-hugeicons-circle'
  }
}

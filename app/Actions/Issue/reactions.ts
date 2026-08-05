/**
 * Reading and writing reactions.
 *
 * Kept out of the action for the usual reason - the issue page and the pull
 * request page both need to *read* them, and neither goes through the action to
 * do it - and because the shape a reader wants is a decision worth testing: a
 * row of eight buttons in a fixed order, each with a count and a flag saying
 * whether the person looking has already pressed it.
 */

import type { Reaction } from '../Markdown/emoji'
import { emojiFor, REACTIONS } from '../Markdown/emoji'

/** What a reaction can be attached to. */
export type ReactionSubjectType = 'issue' | 'issue_comment' | 'review_comment'

export interface ReactionSubject {
  type: ReactionSubjectType
  id: number
}

/** One button, as the template needs it. */
export interface ReactionSummary {
  content: Reaction
  emoji: string
  count: number
  /** Whether the person looking at the page has already reacted this way. */
  mine: boolean
}

/** One row, as it comes back from the database. */
export interface ReactionRow {
  subject_type?: unknown
  subject_id?: unknown
  content?: unknown
  user_id?: unknown
}

/**
 * Rows into the row of buttons, for one subject.
 *
 * Every one of the eight comes back, including the ones with a count of zero,
 * because whether a button is *shown* is the template's decision and it differs
 * by place: the picker shows all eight, the summary under a comment shows only
 * the ones somebody has pressed. Deciding it here would mean the picker and the
 * summary read from two different functions.
 */
export function summarize(rows: readonly ReactionRow[], viewerId: number | null): ReactionSummary[] {
  return REACTIONS.map(content => ({
    content,
    emoji: emojiFor(content) ?? '',
    count: rows.filter(row => row.content === content).length,
    mine: viewerId !== null && rows.some(row => row.content === content && Number(row.user_id) === viewerId),
  }))
}

/**
 * The same, for a page full of subjects at once.
 *
 * The issue page has one body and up to a few hundred comments, and asking the
 * database once per comment is the shape of query that makes a conversation
 * page slow in exactly the repositories where it matters. One read for the
 * whole page, grouped here.
 */
export function summarizeAll(
  rows: readonly ReactionRow[],
  viewerId: number | null,
): Map<string, ReactionSummary[]> {
  const grouped = new Map<string, ReactionRow[]>()

  for (const row of rows) {
    const key = subjectKey(String(row.subject_type), Number(row.subject_id))
    const existing = grouped.get(key)
    if (existing)
      existing.push(row)
    else
      grouped.set(key, [row])
  }

  const summaries = new Map<string, ReactionSummary[]>()
  for (const [key, group] of grouped)
    summaries.set(key, summarize(group, viewerId))

  return summaries
}

/** The key `summarizeAll` groups by, so a caller can look one subject up. */
export function subjectKey(type: string, id: number): string {
  return `${type}:${id}`
}

/** Only the buttons somebody has actually pressed, in the fixed order. */
export function pressed(summaries: readonly ReactionSummary[]): ReactionSummary[] {
  return summaries.filter(summary => summary.count > 0)
}

/**
 * Toggle one reaction, and say which way it went.
 *
 * A reaction is a switch rather than a counter, so one endpoint serves both
 * directions: pressing a button you have already pressed takes it back. Two
 * endpoints would mean the page has to know the current state to pick one, and
 * a page that is a moment out of date would pick wrong.
 *
 * The unique index is what makes this safe under a double click. The insert
 * either lands or collides, and a collision means somebody already reacted -
 * which is the state the caller was asking for anyway.
 */
export async function toggleReaction(
  subject: ReactionSubject,
  userId: number,
  content: Reaction,
): Promise<{ reacted: boolean }> {
  const existing = await db
    .selectFrom('reactions')
    .select(['id'])
    .where('subject_type', '=', subject.type)
    .where('subject_id', '=', subject.id)
    .where('user_id', '=', userId)
    .where('content', '=', content)
    .executeTakeFirst()

  if (existing) {
    await db.deleteFrom('reactions').where('id', '=', Number(existing.id)).execute()

    return { reacted: false }
  }

  try {
    await db
      .insertInto('reactions')
      .values({
        subject_type: subject.type,
        subject_id: subject.id,
        user_id: userId,
        content,
      })
      .execute()
  }
  catch {
    // The index caught a duplicate, which means the reaction the caller wanted
    // is already there. Reporting an error for reaching the requested state
    // would be a lie about a click that worked.
  }

  return { reacted: true }
}

/** Every reaction on a set of subjects of one type, in one query. */
export async function reactionsFor(
  type: ReactionSubjectType,
  ids: readonly number[],
): Promise<ReactionRow[]> {
  if (ids.length === 0)
    return []

  return await db
    .selectFrom('reactions')
    .select(['subject_type', 'subject_id', 'content', 'user_id'])
    .where('subject_type', '=', type)
    .where('subject_id', 'in', [...ids])
    .execute() as ReactionRow[]
}

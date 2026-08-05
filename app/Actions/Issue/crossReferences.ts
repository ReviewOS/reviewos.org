/**
 * Cross references: writing `#12` somewhere records it on issue 12.
 *
 * The point is the reader on the *other* end. Somebody looking at issue 12 has
 * no way to discover that a pull request three weeks later was opened because
 * of it, and that link is usually the most useful thing on the page. The
 * reference is already visible where it was written, so the entry that matters
 * is the one on the thing referred to; the outgoing entry is recorded too,
 * which is what makes a body edited long after the fact leave a mark in its own
 * history rather than only in somebody else's.
 *
 * ## Same repository only
 *
 * A reference to `owner/repo#12` is not followed, for the same reason a closing
 * keyword is not: whoever wrote it has permission *here*, and nothing checks
 * that they may write on the timeline over there. A forge where anyone can
 * append a line to any issue's history by opening an issue on a repository they
 * control is a forge with a spam problem, and the cost of the restriction is
 * that a genuine cross-repository link is a plain link instead of an entry.
 *
 * ## Recorded once
 *
 * Bodies get edited, and comments get edited, and the same reference passing
 * through this function twice must not appear twice. What is already recorded
 * is read first, and only what is new is written. That makes the function
 * idempotent, which is what lets every write path call it without any of them
 * having to know whether the text is new.
 */

import type { TimelineSubject } from './timeline'
import { scanIssueReferences } from '../Markdown/references'
import { recordMany } from './timeline'

export interface CrossReferenceSource {
  /** The issue or pull request the text was written on. */
  subject: TimelineSubject
  /** Its number, which is what the entry on the other side names. */
  number: number
  repositoryId: number
}

/**
 * The numbers a piece of text refers to, in this repository.
 *
 * Pure, so the rules can be tested against the ways text lies. Deduplicated,
 * ordered, and stripped of the reference an issue makes to itself: `#7` written
 * inside issue 7 is somebody quoting their own number, and an entry saying it
 * referenced itself is noise on every one of them.
 */
export function referencedNumbers(body: string, ownNumber: number): number[] {
  const numbers = scanIssueReferences(body)
    .filter(found => found.value.owner === null && found.value.repository === null)
    .map(found => found.value.number)
    .filter(number => number !== ownNumber)

  return [...new Set(numbers)].sort((a, b) => a - b)
}

/**
 * Record what one piece of text refers to.
 *
 * Never throws and never fails the write it describes, the same rule the rest
 * of the timeline follows: a lost cross reference costs a line of history, and
 * an error would tell somebody their comment did not post when it did.
 *
 * Returns the numbers it recorded, which is what a caller reports back and what
 * a test asserts on.
 */
export async function recordCrossReferences(
  source: CrossReferenceSource,
  actorId: number | null,
  body: string,
): Promise<number[]> {
  const numbers = referencedNumbers(body, source.number)
  if (numbers.length === 0)
    return []

  try {
    // Only issues and pull requests that exist here. A reference to a number
    // nobody has opened yet is a typo far more often than it is a prediction.
    const targets: any[] = await db
      .selectFrom('issues')
      .select(['id', 'number', 'is_pull_request'])
      .where('repository_id', '=', source.repositoryId)
      .where('number', 'in', numbers)
      .execute()

    if (targets.length === 0)
      return []

    // What is already on record, so an edited body does not say the same thing
    // twice. Two queries rather than one with an `OR`, because the query builder
    // rejects its expression-callback form of `where` - see the note on the
    // pageable sorts in `listing.ts`. Two indexed reads is a fine price for not
    // building the condition out of string fragments.
    const outgoing: any[] = await db
      .selectFrom('timeline_entries')
      .select(['reference_number'])
      .where('kind', '=', 'mentioned')
      .where('subject_type', '=', source.subject.type)
      .where('subject_id', '=', source.subject.id)
      .execute()

    const incoming: any[] = await db
      .selectFrom('timeline_entries')
      .select(['subject_id'])
      .where('kind', '=', 'referenced')
      .where('subject_id', 'in', targets.map(row => Number(row.id)))
      .where('reference_number', '=', source.number)
      .execute()

    const alreadyMentioned = new Set(outgoing.map(row => Number(row.reference_number)))
    const alreadyReferenced = new Set(incoming.map(row => Number(row.subject_id)))

    const entries: Parameters<typeof recordMany>[0] = []
    const recorded: number[] = []

    for (const target of targets) {
      const targetId = Number(target.id)
      const targetNumber = Number(target.number)
      const targetType = target.is_pull_request ? 'pull_request' as const : 'issue' as const

      if (alreadyReferenced.has(targetId) && alreadyMentioned.has(targetNumber))
        continue

      recorded.push(targetNumber)

      // The incoming half, and the reason this exists: a reader on the other
      // issue learns that something over here is about it.
      if (!alreadyReferenced.has(targetId)) {
        entries.push({
          subject: { type: targetType, id: targetId },
          kind: 'referenced',
          actorId,
          detail: { reference: source.number },
        })
      }

      // The outgoing half. Redundant next to the comment that caused it, and
      // not redundant at all when the reference was edited into a body three
      // weeks after it was written.
      if (!alreadyMentioned.has(targetNumber)) {
        entries.push({
          subject: source.subject,
          kind: 'mentioned',
          actorId,
          detail: { reference: targetNumber },
        })
      }
    }

    await recordMany(entries)

    return recorded
  }
  catch {
    // Deliberately silent, as everywhere else in the timeline.
    return []
  }
}

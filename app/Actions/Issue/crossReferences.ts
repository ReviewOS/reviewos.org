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
 * Record what a pushed commit refers to.
 *
 * Only the incoming half. The outgoing entry that an issue gets - "mentioned
 * #12" - has nowhere to live for a commit: a commit is not a subject with a
 * timeline, and inventing one would mean a second history nobody opens.
 *
 * The actor is nobody, deliberately. A commit carries an author and a
 * committer, both free-text email addresses that anybody can set to anything,
 * so attributing the entry to a local account on the strength of one would put
 * words in somebody's mouth. With no actor the line reads as the repository
 * having recorded it, which is what happened.
 *
 * The short sha travels in `subject_text` rather than in `reference_number`,
 * which only ever holds a number in this repository. `entrySentence` reads
 * whichever is present, so a commit reference and an issue reference render as
 * the same kind of line without the column having to hold two kinds of thing.
 */
export async function recordCommitReferences(
  repositoryId: number,
  sha: string,
  message: string,
): Promise<number[]> {
  // No self-reference to exclude: a commit has no number of its own.
  const numbers = referencedNumbers(message, Number.NaN)
  if (numbers.length === 0)
    return []

  const short = sha.slice(0, 7)

  try {
    const targets = await targetsFor(repositoryId, numbers)

    if (targets.length === 0)
      return []

    // Already recorded, so a retried job does not say it twice. Matched on the
    // sha rather than on the pair, because the same commit reaching the same
    // subject is the only duplicate this can produce.
    const existing = await db
      .selectFrom('timeline_entries')
      .select(['subject_type', 'subject_id'])
      .where('kind', '=', 'referenced')
      .where('subject_id', 'in', targets.map(row => row.id))
      .where('subject_text', '=', short)
      .execute()

    const already = new Set(existing.map(row => subjectKey(String(row.subject_type), row.subject_id)))
    const entries: Parameters<typeof recordMany>[0] = []
    const recorded: number[] = []

    for (const target of targets) {
      if (already.has(subjectKey(target.type, target.id)))
        continue

      entries.push({
        subject: { type: target.type, id: target.id },
        kind: 'referenced',
        actorId: null,
        detail: { text: short },
      })

      recorded.push(target.number)
    }

    await recordMany(entries)

    return recorded
  }
  catch {
    return []
  }
}

/**
 * The issues and pull requests a set of numbers names, in this repository.
 *
 * Both tables, because a number is allocated from one sequence per repository
 * and either kind can hold it. This used to read `issues` alone and branch on
 * `issues.is_pull_request`, which is the GitHub shape - there a pull request
 * *is* an issue row - and is not this schema: a pull request is a row in
 * `pull_requests`, nothing writes an `issues` row for one, and
 * `is_pull_request` is false on every row in the database. So a reference
 * naming a pull request found no target and recorded nothing, silently, on
 * every write path that scans text.
 *
 * The table a row came from is the answer, so nothing has to branch on a
 * column to decide what it is looking at.
 */
async function targetsFor(
  repositoryId: number,
  numbers: readonly number[],
): Promise<{ id: number, number: number, type: 'issue' | 'pull_request' }[]> {
  const [issues, pulls] = await Promise.all([
    db
      .selectFrom('issues')
      .select(['id', 'number'])
      .where('repository_id', '=', repositoryId)
      .where('number', 'in', numbers)
      .execute(),
    db
      .selectFrom('pull_requests')
      .select(['id', 'number'])
      .where('repository_id', '=', repositoryId)
      .where('number', 'in', numbers)
      .execute(),
  ])

  return [
    ...issues.map(row => ({ id: Number(row.id), number: Number(row.number), type: 'issue' as const })),
    ...pulls.map(row => ({ id: Number(row.id), number: Number(row.number), type: 'pull_request' as const })),
  ]
}

/**
 * A timeline subject as one comparable string.
 *
 * `subject_id` is polymorphic, so an id on its own does not identify a row:
 * issue 5 and pull request 5 are different things. Every dedupe below keys on
 * the pair. It was keyed on the id alone, which was safe only while every
 * target was an issue - the moment both kinds can be returned, an issue id
 * matching a pull request id would suppress a reference that was never
 * recorded.
 */
function subjectKey(type: string, id: number | string): string {
  return `${type}:${Number(id)}`
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
    const targets = await targetsFor(source.repositoryId, numbers)

    if (targets.length === 0)
      return []

    // What is already on record, so an edited body does not say the same thing
    // twice. Two queries rather than one with an `OR`, because the query builder
    // rejects its expression-callback form of `where` - see the note on the
    // pageable sorts in `listing.ts`. Two indexed reads is a fine price for not
    // building the condition out of string fragments.
    const outgoing = await db
      .selectFrom('timeline_entries')
      .select(['reference_number'])
      .where('kind', '=', 'mentioned')
      .where('subject_type', '=', source.subject.type)
      .where('subject_id', '=', source.subject.id)
      .execute()

    const incoming = await db
      .selectFrom('timeline_entries')
      .select(['subject_type', 'subject_id'])
      .where('kind', '=', 'referenced')
      .where('subject_id', 'in', targets.map(row => row.id))
      .where('reference_number', '=', source.number)
      .execute()

    const alreadyMentioned = new Set(outgoing.map(row => Number(row.reference_number)))
    const alreadyReferenced = new Set(incoming.map(row => subjectKey(String(row.subject_type), row.subject_id)))

    const entries: Parameters<typeof recordMany>[0] = []
    const recorded: number[] = []

    for (const target of targets) {
      const targetId = target.id
      const targetNumber = target.number
      const targetType = target.type

      if (alreadyReferenced.has(subjectKey(targetType, targetId)) && alreadyMentioned.has(targetNumber))
        continue

      recorded.push(targetNumber)

      // The incoming half, and the reason this exists: a reader on the other
      // issue learns that something over here is about it.
      if (!alreadyReferenced.has(subjectKey(targetType, targetId))) {
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

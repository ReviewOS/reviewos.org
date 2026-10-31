/**
 * What a job's log keeps once it reaches its ceiling: the start and the end.
 *
 * The ceiling used to keep the first bytes and drop everything after them.
 * That is the wrong end. A build's head is checkout, install and setup; its
 * tail is the test summary, the stack trace and the line that says what
 * failed. HQ's unit job (run 2443, job 6809) failed past two megabytes and the
 * only stored copy stopped before the reason.
 *
 * So the log keeps a fixed head - a quarter of the ceiling - and treats the
 * rest as a ring of the newest chunks. When a chunk would cross the ceiling,
 * the oldest chunks after the head are deleted to make room, and the first
 * surviving chunk after the head carries one marker line saying how many bytes
 * were dropped there. The marker moves forward as more is dropped and carries
 * the running total, so there is always exactly one, at the gap.
 *
 * Pure: the planner sees sizes and markers and says what to delete, where the
 * marker goes and what it says. `logs.ts` does the writing.
 */

/** The share of the ceiling kept from the start of a job's output. */
export const HEAD_SHARE = 0.25

/** Room left for the marker line when deciding what fits. */
export const MARKER_ROOM = 256

const MARKER_PATTERN = /^\n?\[log truncated: (\d+) bytes dropped here\b[^\n]*\]\n/

/** The marker line, as it appears in the stored text. */
export function droppedMarker(dropped: number, ceiling: number): string {
  return `\n[log truncated: ${dropped} bytes dropped here - this job wrote more than its ${ceiling}-byte log ceiling, so the start and the most recent output are kept]\n`
}

/** The bytes a chunk's marker says were dropped before it, or 0. */
export function markerOf(content: string): { dropped: number, length: number } {
  const match = MARKER_PATTERN.exec(content)

  return match ? { dropped: Number(match[1]), length: new TextEncoder().encode(match[0]).length } : { dropped: 0, length: 0 }
}

/** A chunk's content without its marker. */
export function withoutMarker(content: string): string {
  return content.replace(MARKER_PATTERN, '')
}

export interface StoredChunk {
  sequence: number
  /** Bytes as stored, marker included. */
  bytes: number
  /** What its marker says was dropped before it; 0 when it carries none. */
  dropped: number
  /** The marker's own bytes, so they are not counted as dropped output. */
  markerBytes: number
}

export type CeilingPlan =
  /** It fits, or it is a resend the unique index will answer. */
  | { action: 'store' }
  /** A resend of a chunk that was already dropped from the middle. */
  | { action: 'drop' }
  | {
    action: 'rotate'
    /** Sequences to delete, oldest first. */
    remove: number[]
    /** The chunk that carries the marker; the incoming one when nothing after the head survives. */
    markerOn: number
    /** The running total the marker states. */
    dropped: number
    /** Bytes the incoming chunk must lose from its front to fit; 0 nearly always. */
    clipIncoming: number
  }

/**
 * Decide what one append does to a job's stored chunks.
 *
 * `chunks` are this attempt's rows in sequence order.
 */
export function planCeiling(
  chunks: readonly StoredChunk[],
  incoming: { sequence: number, bytes: number },
  ceiling: number,
): CeilingPlan {
  if (chunks.some(chunk => chunk.sequence === incoming.sequence))
    return { action: 'store' }

  /*
   * Where the gap is. Once something was dropped the marker says so, and
   * everything before it is the head - which is never touched again. Before
   * that, the head is the longest prefix inside its share.
   */
  let gap = chunks.findIndex(chunk => chunk.dropped > 0)

  if (gap >= 0 && incoming.sequence < chunks[gap]!.sequence)
    return { action: 'drop' }

  if (gap < 0) {
    const headBudget = Math.floor(ceiling * HEAD_SHARE)
    let used = 0
    gap = 0

    while (gap < chunks.length && used + chunks[gap]!.bytes <= headBudget) {
      used += chunks[gap]!.bytes
      gap++
    }
  }

  const total = chunks.reduce((sum, chunk) => sum + chunk.bytes, 0)

  if (total + incoming.bytes <= ceiling)
    return { action: 'store' }

  const tail = chunks.slice(gap)
  const remove: number[] = []
  let kept = total
  let dropped = 0

  for (const chunk of tail) {
    if (kept + incoming.bytes + MARKER_ROOM <= ceiling)
      break

    remove.push(chunk.sequence)
    kept -= chunk.bytes
    dropped += chunk.dropped + chunk.bytes - chunk.markerBytes
  }

  const survivor = tail.find(chunk => !remove.includes(chunk.sequence))
  // Only when everything after the head went and the chunk still does not fit,
  // which a ceiling near its 64 KiB floor can produce.
  const clipIncoming = Math.max(0, kept + incoming.bytes + MARKER_ROOM - ceiling)

  return {
    action: 'rotate',
    remove,
    markerOn: survivor ? survivor.sequence : incoming.sequence,
    dropped: dropped + clipIncoming,
    clipIncoming,
  }
}

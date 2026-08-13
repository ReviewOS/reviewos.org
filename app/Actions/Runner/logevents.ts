/**
 * A job's output as events rather than as bytes.
 *
 * The plain-text form works and will keep working: a runner that writes what
 * its build printed is doing the honest thing, and requiring structure to say
 * "here is a line" would be a protocol nobody could write in an afternoon.
 *
 * But four of the things a person wants from a log cannot be recovered from
 * text afterwards, and guessing at them is worse than not having them:
 *
 * - **Groups.** GitHub Actions marks them with `::group::`, Buildkite with
 *   `---`, and a build that happens to print either is not opening a group.
 *   Parsing them out of plain text is a guess about somebody's output that is
 *   wrong exactly when their output is interesting.
 * - **Timestamps.** The time this server *received* a chunk is not the time the
 *   job printed it. A runner batching a hundred lines for a network round trip
 *   would have them all arrive in the same millisecond, which makes a duration
 *   nobody can read anything into.
 * - **Colour.** ANSI escapes survive being stored as text, but only because
 *   nothing is trying to make sense of them; kept as an event field they can be
 *   rendered or ignored per reader.
 * - **Streams per line.** A chunk carries one `stream`, so a runner
 *   interleaving stdout and stderr must either split every chunk or lie.
 *
 * So an append may carry events instead of text. Everything here is parsing and
 * validation of what a machine running hostile code sent: nothing is trusted,
 * anything unrecognised is dropped rather than stored, and the result is a
 * shape the renderer can rely on.
 */

export type LogEventType = 'line' | 'group' | 'endgroup'

export interface LogEvent {
  type: LogEventType
  /** The text of a line, or the name of a group. Empty is legal - builds print blank lines. */
  text: string
  /** When the *job* printed it, ISO 8601, or empty when the runner did not say. */
  at: string
  /** Which stream this line came from. `stdout` unless the runner says otherwise. */
  stream: 'stdout' | 'stderr'
}

/** The most events one append may carry, so a single request cannot be unbounded. */
export const MAX_EVENTS_PER_APPEND = 2000

/** And the most one line may be, because a line is a thing a person reads. */
export const MAX_EVENT_TEXT = 8192

/**
 * Read what a runner sent, keeping only what this server understands.
 *
 * **Unrecognised events are dropped, not refused.** A newer runner sending an
 * event type this server has not learned is the ordinary state of a fleet
 * mid-upgrade, and refusing the whole append would lose the lines around it -
 * which are the ones somebody is waiting to read. The protocol version is what
 * tells a runner it is talking to an older server; this is what keeps the
 * conversation useful while it does.
 *
 * A timestamp that is not a date is dropped rather than replaced with now:
 * inventing one would make a duration that nobody can tell from a real one.
 */
export function parseEvents(sent: unknown): LogEvent[] {
  if (!Array.isArray(sent))
    return []

  const events: LogEvent[] = []

  for (const raw of sent.slice(0, MAX_EVENTS_PER_APPEND)) {
    if (!raw || typeof raw !== 'object')
      continue

    const candidate = raw as Record<string, unknown>
    const type = String(candidate.type ?? 'line').trim().toLowerCase()

    if (type !== 'line' && type !== 'group' && type !== 'endgroup')
      continue

    events.push({
      type: type as LogEventType,
      text: String(candidate.text ?? '').slice(0, MAX_EVENT_TEXT),
      at: timestampOf(candidate.at),
      stream: String(candidate.stream ?? '') === 'stderr' ? 'stderr' : 'stdout',
    })
  }

  return events
}

/** An ISO timestamp, or empty. Never invented. */
function timestampOf(sent: unknown): string {
  const raw = String(sent ?? '').trim()
  if (!raw)
    return ''

  const parsed = Date.parse(raw)

  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : ''
}

/**
 * Events as the text they would have been.
 *
 * Stored alongside the structured form, so everything that reads a log as text
 * - the API's plain answer, the ceiling arithmetic, a person running `curl` -
 * keeps working without knowing this exists. A group becomes its name on a
 * line, which is what a plain-text reader would have seen anyway.
 */
export function eventsAsText(events: readonly LogEvent[]): string {
  return events.map((event) => {
    if (event.type === 'group')
      return `${event.text}\n`

    if (event.type === 'endgroup')
      return ''

    return `${event.text}\n`
  }).join('')
}

export interface LogGroup {
  /** Empty for the lines that came before any group was opened. */
  name: string
  lines: LogEvent[]
  /** Whether a group was actually opened, or these are loose lines. */
  grouped: boolean
}

/**
 * Events, folded into the groups the job asked for.
 *
 * **An unclosed group is closed at the end**, because a build that fails inside
 * one never gets to close it - and that is precisely the group somebody wants
 * to read. Treating it as malformed and flattening it would hide the failure
 * inside a wall of lines.
 *
 * **A stray `endgroup` is ignored.** It means the job closed something it never
 * opened, which is a bug in their script and not a reason to lose the output
 * around it.
 *
 * Nesting is deliberately flat: one level, like every CI product that has this.
 * A tree of groups is a tree somebody has to navigate, and the case it serves -
 * a build that groups its groups - is rarer than the confusion it causes.
 */
export function groupEvents(events: readonly LogEvent[]): LogGroup[] {
  const groups: LogGroup[] = []
  let current: LogGroup | null = null

  const loose = (): LogGroup => {
    const last = groups.at(-1)

    if (last && !last.grouped)
      return last

    const made: LogGroup = { name: '', lines: [], grouped: false }
    groups.push(made)

    return made
  }

  for (const event of events) {
    if (event.type === 'group') {
      current = { name: event.text, lines: [], grouped: true }
      groups.push(current)
      continue
    }

    if (event.type === 'endgroup') {
      current = null
      continue
    }

    if (current)
      current.lines.push(event)
    else
      loose().lines.push(event)
  }

  return groups.filter(group => group.grouped || group.lines.length > 0)
}

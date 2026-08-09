/**
 * The shape every long-running thing wears.
 *
 * One pattern, so a client that can follow a mirror sync can follow an import
 * and a batch merge without learning anything new:
 *
 * 1. **Create with an idempotency key.** A retried start joins the operation it
 *    already started rather than beginning a second one.
 * 2. **Receive a resource and a status URL.** Not a bare `202`, which tells the
 *    caller nothing they can act on.
 * 3. **Poll it cheaply.** The status carries an `ETag`, and polling is what the
 *    API asks clients to do, so it has to be free.
 * 4. **Cancel with the same token authority that created it.** Anything less is
 *    one agent stopping another's work.
 *
 * The status shape is deliberately independent of the work. A field named after
 * what a sync does is a field an import has to leave null, and a client reading
 * `result` cannot tell "no result" from "not that kind of operation".
 */

import { etagFrom } from './etag'

export type OperationStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'

/** The three ways an operation stops. Nothing changes after one of these. */
export const TERMINAL: readonly OperationStatus[] = ['succeeded', 'failed', 'cancelled'] as const

export function isTerminal(status: string): boolean {
  return (TERMINAL as readonly string[]).includes(status)
}

/**
 * The public shape of an operation.
 *
 * `url` is a path rather than an absolute URL, for the reason the webhook
 * payloads are: the receiver knows its own origin and we may be behind a proxy
 * that has a different opinion about ours.
 */
export interface OperationView {
  id: string
  kind: string
  status: OperationStatus
  url: string
  created_at: string | null
  started_at: string | null
  finished_at: string | null
  /** Set only once it has succeeded. */
  result: unknown
  /** Set only once it has failed, in words a caller can act on. */
  error: string | null
  /** Whether a stop has been asked for but not yet taken effect. */
  cancelling: boolean
}

/** One row, as the API reports it. */
export function view(row: any): OperationView {
  const status = String(row?.status ?? 'queued') as OperationStatus

  return {
    // The uuid, never the primary key. A sequential id in a URL tells a
    // stranger how much work this instance has done and lets them walk it.
    id: String(row?.uuid ?? ''),
    kind: String(row?.kind ?? ''),
    status,
    url: `/api/operations/${String(row?.uuid ?? '')}`,
    created_at: row?.created_at ? String(row.created_at) : null,
    started_at: row?.started_at ? String(row.started_at) : null,
    finished_at: row?.finished_at ? String(row.finished_at) : null,
    result: readResult(row?.result),
    error: row?.error ? String(row.error) : null,
    // Only meaningful while it is still going. A finished operation that says
    // it is cancelling is describing a request that no longer matters.
    cancelling: Boolean(row?.cancel_requested_at) && !isTerminal(status),
  }
}

/**
 * The tag for an operation's status.
 *
 * From the fields that change rather than the body, because the body is built
 * from them and hashing it would cost the same as sending it. `cancel_requested_at`
 * is in the tag: a client watching for its cancel to take effect is watching for
 * exactly that field.
 */
export function etagForOperation(row: any): string {
  return etagFrom([
    'operation',
    String(row?.uuid ?? ''),
    String(row?.status ?? ''),
    String(row?.finished_at ?? ''),
    String(row?.cancel_requested_at ?? ''),
  ])
}

/**
 * How long a client should wait before asking again.
 *
 * Sent as `Retry-After` on a status that is not finished, so a client does not
 * have to guess and does not hammer. Queued work is polled more slowly than
 * running work: something that has not started is unlikely to finish in the
 * next second, and something running might.
 *
 * A terminal status gets nothing. There is no point coming back.
 */
export function retryAfterFor(status: string): number | null {
  if (isTerminal(status))
    return null

  return status === 'running' ? 2 : 5
}

/** `result`, parsed, or null. */
function readResult(raw: unknown): unknown {
  if (raw === null || raw === undefined || raw === '')
    return null

  if (typeof raw !== 'string')
    return raw

  try {
    return JSON.parse(raw)
  }
  catch {
    // Kept verbatim. A result that is not JSON was written by something that
    // did not follow the rule, and showing it is how somebody finds out.
    return raw
  }
}

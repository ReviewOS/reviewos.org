/**
 * Starting a long-running operation, the same way every time.
 *
 * The half of the pattern that lives on the server: create the row, honour an
 * idempotency key, and answer with the resource and its status URL. Every
 * endpoint that kicks off background work calls this instead of answering
 * `202 Accepted` with a body of its own invention.
 */

import { view } from '../../Api/operations'
import { tokenIdFor } from '../Git/audit'

export interface StartInput {
  /** What kind of work, e.g. `mirror.sync`. Stable, and part of the client contract. */
  kind: string
  subject: { type: string, id: number }
  actorId?: number | null
  request: any
}

export interface Started {
  /** The row, for a caller that needs its id to enqueue the work. */
  row: any
  /** Whether this call created it, or found the one an earlier identical call made. */
  fresh: boolean
}

/**
 * Find or create the operation for this request.
 *
 * **The idempotency key is scoped to the token and the kind and the subject.**
 * A key is chosen by the client and two clients will eventually choose the same
 * one, so an unscoped lookup would join one caller's retry to another caller's
 * work - a disclosure rather than a duplicate.
 *
 * With no key, every call starts a new operation. That is the honest default:
 * inferring one from the subject would silently deduplicate two deliberate
 * requests, and a caller that wants that behaviour can ask for it in one header.
 */
export async function startOperation(input: StartInput): Promise<Started> {
  const tokenId = await tokenIdFor(input.request)
  const key = keyFrom(input.request)

  const scope = [
    input.kind,
    input.subject.type,
    input.subject.id,
    tokenId ? `token:${tokenId}` : `user:${input.actorId ?? 0}`,
  ].join(':')

  if (key) {
    const existing = await db
      .selectFrom('operations')
      .selectAll()
      .where('idempotency_scope', '=', scope)
      .where('idempotency_key', '=', key)
      .executeTakeFirst()

    // The one it already started, whatever state it is in. A retry that arrived
    // after the work finished gets the finished operation, which is the answer
    // it was going to poll for anyway.
    if (existing)
      return { row: existing, fresh: false }
  }

  const created = await db
    .insertInto('operations')
    .values({
      kind: input.kind,
      status: 'queued',
      subject_type: input.subject.type,
      subject_id: input.subject.id,
      actor_id: input.actorId ?? null,
      access_token_id: tokenId,
      idempotency_scope: key ? scope : null,
      idempotency_key: key,
      uuid: crypto.randomUUID(),
    })
    .returning(['id', 'uuid', 'kind', 'status', 'created_at'])
    .executeTakeFirst()

  return { row: created, fresh: true }
}

/**
 * The response that starts an operation.
 *
 * `202` with the resource and a `Location`. Not `200`: the work has not
 * happened, and a client that treats the answer as the result would report
 * success for something still queued. Not a bare `202` either - that is the
 * shape this pattern exists to replace.
 */
export function accepted(row: any, extra: Record<string, unknown> = {}): Response {
  const operation = view(row)

  /*
   * `{ status, headers }`, not positional. `response.json` takes an options
   * object (or a bare status number) - a third argument is silently ignored,
   * which is how a `Location` header goes missing while everything still
   * answers 202 and every test that only checks the body passes.
   */
  return response.json({ operation, ...extra }, {
    status: 202,
    headers: {
      // Both the header and the body. A client on a generic HTTP layer follows
      // `Location`; one written against this API reads `operation.url`.
      Location: operation.url,
    },
  })
}

/** The idempotency key on this request, or null. */
function keyFrom(request: RequestInstance): string | null {
  const header = String(
    request?.headers?.get?.('idempotency-key') ?? request?.header?.('idempotency-key') ?? '',
  ).trim()

  // Bounded, because it is stored and indexed. A key longer than this is not a
  // key, it is a payload.
  return header ? header.slice(0, 120) : null
}

/**
 * The two things every runner request has in common: a version, and an answer
 * that says what this server speaks.
 *
 * Written once because four endpoints need it and a check that four files each
 * do slightly differently is one that three of them stop doing.
 */

import type { ProtocolDecision } from './protocol'
import { negotiate, PROTOCOL_HEADER, protocolHeaders } from './protocol'

/** The protocol version on a request, from the header a runner sends. */
export function protocolOf(request: RequestInstance): ProtocolDecision {
  const header = String(
    request?.headers?.get?.(PROTOCOL_HEADER)
    ?? request?.headers?.get?.(PROTOCOL_HEADER.toLowerCase())
    ?? request?.header?.(PROTOCOL_HEADER)
    ?? '',
  )

  return negotiate(header)
}

/**
 * A JSON answer that carries what this server speaks.
 *
 * On every response, not only the refusals. A runner about to be retired should
 * be able to learn that from an ordinary poll rather than from the first
 * request that fails, and an operator diagnosing a fleet should be able to read
 * both ends' opinion out of one response.
 */
export function runnerJson(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...protocolHeaders(), ...extra },
  })
}

/**
 * Refuse a runner this server cannot speak to.
 *
 * **426 Upgrade Required**, which is the one status that means exactly this and
 * is the reason it exists. A 400 would read as a malformed request and send
 * somebody looking at their payload; a 401 would send them to their token. The
 * body says which way the mismatch runs and what to do about it, because an
 * operator reading this is holding a machine they can upgrade or a server they
 * can, and the two are different afternoons.
 */
export function refuseProtocol(decision: ProtocolDecision): Response {
  return runnerJson({ error: decision.reason, protocol: decision.version || null }, 426)
}

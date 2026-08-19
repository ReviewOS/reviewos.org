/**
 * Caching the one clone shape a fleet asks for over and over.
 *
 * A runner fleet starting fifty jobs on one commit sends fifty identical
 * `upload-pack` requests, and each one makes git walk the object graph and
 * compress a packfile that is byte-for-byte the answer it just computed. That
 * is the most expensive thing this server does, repeated, for a result that
 * cannot differ.
 *
 * ## Only the shape that is safe to cache
 *
 * A `want`-only request - no `have`, no `shallow`, no `deepen`, no `filter` -
 * asks for "everything reachable from these tips", and the answer depends on
 * nothing but those tips. That is a fresh clone, which is exactly the shape a
 * fleet produces, and it is the only shape cached here.
 *
 * Anything else falls through to git untouched. A negotiated fetch depends on
 * what the client already has, a partial clone on a filter, a shallow one on a
 * depth - caching any of those means eventually serving somebody a pack that
 * does not contain what they asked for, which is a corruption bug wearing a
 * performance bug's clothes.
 *
 * **The parser fails open in exactly one direction.** Anything it does not
 * completely understand produces `null`, and a null key means git runs. There
 * is no input that can make this serve the wrong pack; the worst it can do is
 * fail to save work.
 */

import { createHash } from 'node:crypto'

/** What a parsed request turned out to be. */
export interface ClonePlan {
  /** The object ids the client wants, sorted, deduplicated. */
  wants: string[]
  /** The capabilities line, kept out of the key deliberately - see `packCacheKey`. */
  capabilities: string
}

const PKT_FLUSH = '0000'

/**
 * Read a pkt-line stream into its payloads.
 *
 * git's framing: four hex digits of length (including the four), then the
 * payload. `0000` is a flush, `0001` a delimiter, `0002` a response-end. A
 * length this cannot read at all ends the parse rather than guessing.
 */
export function readPacketLines(body: Uint8Array): string[] | null {
  const lines: string[] = []
  let at = 0

  while (at < body.length) {
    if (at + 4 > body.length)
      return null

    const header = new TextDecoder().decode(body.subarray(at, at + 4))

    if (!/^[0-9a-f]{4}$/i.test(header))
      return null

    const length = Number.parseInt(header, 16)

    // Flush, delimiter and response-end carry no payload.
    if (length === 0 || length === 1 || length === 2) {
      at += 4
      lines.push(header === PKT_FLUSH ? '' : header)

      continue
    }

    if (length < 4 || at + length > body.length)
      return null

    lines.push(new TextDecoder().decode(body.subarray(at + 4, at + length)))
    at += length
  }

  return lines
}

/**
 * What this request is, when it is a plain clone.
 *
 * Null for everything else, including anything unparseable. Handles both
 * protocol v0/v1 (`want <oid> <capabilities>` then flush then `done`) and v2
 * (`command=fetch`, then `want` lines inside the argument section).
 */
export function parseClone(body: Uint8Array): ClonePlan | null {
  const lines = readPacketLines(body)

  if (!lines)
    return null

  const wants: string[] = []
  let capabilities = ''

  for (const raw of lines) {
    const line = raw.replace(/\n$/, '')

    if (line.length === 0)
      continue

    /*
     * Anything that makes the answer depend on more than the wanted tips.
     * `have` is a negotiation, `shallow`/`deepen` change the graph that is
     * sent, `filter` removes objects from it, and `wait-for-done` changes the
     * exchange. Each of these is a correct reason not to cache.
     */
    if (/^(have|shallow|deepen|deepen-since|deepen-not|filter|wait-for-done)\b/.test(line))
      return null

    const want = /^want ([0-9a-f]{40,64})\s?(.*)$/.exec(line)

    if (want) {
      wants.push(want[1]!)

      if (want[2] && capabilities.length === 0)
        capabilities = want[2]

      continue
    }

    // Protocol v2's argument section carries the same capabilities as
    // key=value lines; they do not change which objects are sent.
    if (/^(command|agent|object-format|thin-pack|ofs-delta|no-progress|include-tag|done|packfile-uris|session-id)\b/.test(line))
      continue

    if (/^0{3}[12]$/.test(line))
      continue

    // Something this parser does not know. Fall through to git rather than
    // guess what it means for the answer.
    return null
  }

  if (wants.length === 0)
    return null

  return {
    wants: [...new Set(wants)].sort(),
    capabilities,
  }
}

/**
 * The cache key for a clone.
 *
 * The repository and the wanted tips, and nothing else.
 *
 * **Capabilities are deliberately excluded**, and that is the one judgement
 * call in this file. They change the *encoding* - `ofs-delta` versus
 * `ref-delta`, whether a thin pack is allowed, whether progress is written to
 * the sideband - rather than which objects are sent, and a client that
 * negotiated a capability it then receives a pack without still reads that
 * pack correctly. The exception is `object-format`, which changes the hash
 * algorithm; a repository is one format, and it is part of the repository
 * rather than the request.
 *
 * If that judgement is ever wrong, the symptom is a client that cannot read a
 * cached pack, which is loud. The alternative - keying on the whole
 * capabilities string - makes the cache miss for every client version, which
 * is silent and useless.
 */
export function packCacheKey(repositoryId: number, plan: ClonePlan): string {
  const digest = createHash('sha256').update(plan.wants.join('\n')).digest('hex')

  return `packs/${repositoryId}/${digest.slice(0, 2)}/${digest}.pack`
}

/**
 * How large a cached pack may be.
 *
 * A cache is an optimisation, and one that fills a disk is a worse problem
 * than the latency it removed. Past this the pack is served and not stored.
 */
export const MAX_CACHED_PACK_BYTES = 2 * 1024 * 1024 * 1024

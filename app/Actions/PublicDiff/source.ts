/**
 * A patch already in memory, as the thing `streamManifest` reads.
 *
 * `ManifestSource` is `{ chunks, done }` and nothing more - it was written
 * against `git diff`'s stdout and never assumed one. That is what lets the
 * public viewer reuse the whole manifest pipeline rather than growing a second
 * one: the patch arrives over the network instead of out of a pipe, and
 * everything downstream is unchanged.
 *
 * Handed over in pieces rather than as one string, because the splitter and the
 * parser are written for a stream and a single enormous chunk would make the
 * first file wait for the last byte - which on a forty-three megabyte patch is
 * the difference between a page that fills and a page that appears all at once,
 * late.
 */

import type { ManifestSource } from '../Pull/manifest'

/**
 * How much patch text is handed over at a time.
 *
 * A megabyte is large enough that the loop is not the cost and small enough
 * that the first records come out promptly. It is also roughly what a socket
 * read gives, so the downstream code sees the shape it was written for.
 */
export const SOURCE_CHUNK_BYTES = 1024 * 1024

export function patchAsSource(patch: string): ManifestSource {
  async function* chunks(): AsyncIterable<string> {
    for (let at = 0; at < patch.length; at += SOURCE_CHUNK_BYTES) {
      yield patch.slice(at, at + SOURCE_CHUNK_BYTES)

      // A patch this size is parsed on the same thread that is serving every
      // other request. Yielding between chunks is what keeps one large diff
      // from being a stall for everybody else.
      await Promise.resolve()
    }
  }

  return {
    chunks: chunks(),
    done: Promise.resolve({ ok: true, code: 0, stderr: '' }),
  }
}

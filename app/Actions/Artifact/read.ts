/**
 * Reading a stored artifact, wherever it actually lives.
 *
 * Four places serve artifact bytes - a runner fetching a previous job's
 * output, a person downloading one, a set being tarred, an image rendered
 * inline in a log - and each had its own `Bun.file(artifactPath(digest))`.
 * That was four places to change when the bytes moved off local disk, and four
 * chances to get the precedence between the recorded key and the derived one
 * subtly different.
 *
 * So there is one function each for the two shapes callers need: a stream, and
 * the whole thing. Both answer null when the bytes are gone, which is a real
 * state - the sweep removes rows before blobs, so a row whose blob is missing
 * means something went wrong, and every caller here says so with a 410 rather
 * than a 404.
 */

import type { BlobStore } from '../Git/blobs'
import { blobStore } from '../Git/blobs'
import { artifactKeyFor } from './storage'

/** What the readers need off a row: where the bytes are. */
export interface ArtifactLocation {
  digest?: unknown
  blob_key?: unknown
}

/** The artifact as a stream, or null when the store does not have it. */
export async function openArtifact(row: ArtifactLocation, store?: BlobStore): Promise<ReadableStream<Uint8Array> | null> {
  try {
    const blobs = store ?? await blobStore()

    return await blobs.get(artifactKeyFor(row))
  }
  catch {
    // An unreadable key is a missing artifact from the caller's point of view.
    // `artifactKeyFor` throws on a row whose digest is not a digest, which is
    // corruption rather than something a download should 500 on.
    return null
  }
}

/**
 * The artifact as bytes.
 *
 * For the two callers that genuinely need all of it in memory: the tar builder
 * and the inline image renderer. Both already bound what they will accept
 * before calling - the set has a 200 MB ceiling and an inline image a much
 * smaller one - which is why this does not take a budget of its own.
 */
export async function readArtifactBytes(row: ArtifactLocation, store?: BlobStore): Promise<Uint8Array | null> {
  const stream = await openArtifact(row, store)

  if (!stream)
    return null

  return new Uint8Array(await new Response(stream).arrayBuffer())
}

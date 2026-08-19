/**
 * Taking an uploaded file and turning it into something a body can reference.
 *
 * Shared, because two forms and one endpoint all do it: the new-issue form, the
 * comment form, and `UploadAttachmentAction` for anything driving this over the
 * API. Written once so the checks cannot differ between them - a size limit
 * enforced on two of the three paths is a size limit that is not enforced.
 */

import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { AttachmentKind } from './storage'
import {
  attachmentBlobKey, attachmentUrl,
  kindFor,
  markdownFor,
  MAX_ATTACHMENT_BYTES,
  newAttachmentKey,
  safeFilename,
  sniff,
} from './storage'

/** What a request hands over. Narrower than the router's type, so this is testable. */
export interface UploadedFile {
  originalName?: string
  filename?: string
  mimetype?: string
  size?: number
  buffer?: ArrayBuffer
}

export type UploadResult =
  | { ok: true, key: string, url: string, markdown: string, filename: string, kind: AttachmentKind, bytes: number }
  | { ok: false, error: string, status: number }

/**
 * Decide what a file is, and whether it may be stored.
 *
 * Pure, and the whole policy: the bytes are read before the claim is believed,
 * and where the two disagree the bytes win. That is what stops an HTML document
 * being uploaded as `image/png` and later served with a content type a browser
 * is willing to render.
 */
export function inspect(file: UploadedFile): { ok: true, kind: AttachmentKind, bytes: Uint8Array } | { ok: false, error: string, status: number } {
  const buffer = file.buffer
  if (!buffer)
    return { ok: false, error: 'No file was uploaded', status: 422 }

  const bytes = new Uint8Array(buffer)

  if (bytes.byteLength === 0)
    return { ok: false, error: 'That file is empty', status: 422 }

  if (bytes.byteLength > MAX_ATTACHMENT_BYTES)
    return { ok: false, error: 'That file is too large', status: 413 }

  const sniffed = sniff(bytes)
  const claimed = String(file.mimetype ?? '')

  const kind = kindFor(sniffed ?? claimed)
  if (!kind)
    return { ok: false, error: 'That kind of file cannot be attached here', status: 415 }

  // Every format served in place has a signature to read, so a file that claims
  // to be one and does not begin like one is lying. This is the check that
  // matters: without it an HTML document uploaded as `image/png` is stored as
  // `image/png`, and later served with a content type the browser is happy to
  // render from this origin. The claim is believed only where there is nothing
  // to read - text, JSON, SVG - and all of those are downloads either way.
  if (kind.inline && sniffed === null)
    return { ok: false, error: 'That file is not the kind of image it says it is', status: 415 }

  return { ok: true, kind, bytes }
}

/**
 * Store a file and record it.
 *
 * Written to disk before the row exists, and the row is what makes it
 * reachable: a failed insert leaves bytes nobody can name, which is a cleanup
 * job. The other order leaves a row pointing at nothing, which is a broken
 * image in somebody's issue forever.
 */
export async function storeAttachment(
  file: UploadedFile,
  repositoryId: number,
  uploaderId: number | null,
): Promise<UploadResult> {
  const inspected = inspect(file)
  if (!inspected.ok)
    return inspected

  const { kind, bytes } = inspected
  const key = newAttachmentKey()
  const filename = safeFilename(String(file.originalName ?? file.filename ?? ''), key, kind.extension)

  // Through the store, which for a local instance writes exactly where
  // attachments have always been - `attachments/aa/bb/key` under the store's
  // `storage` root is the same file `attachmentPath` names.
  const { blobStore } = await import('../Git/blobs')
  const store = await blobStore()
  await store.put(attachmentBlobKey(key)!, bytes)

  await db
    .insertInto('attachments')
    .values({
      key,
      repository_id: repositoryId,
      uploader_id: uploaderId,
      filename,
      content_type: kind.contentType,
      byte_size: bytes.byteLength,
    })
    .execute()

  return {
    ok: true,
    key,
    url: attachmentUrl(key),
    markdown: markdownFor(kind, key, filename),
    filename,
    kind,
    bytes: bytes.byteLength,
  }
}

/**
 * Store the files that came in with a form, and return the markdown for them.
 *
 * The page runs no client-side JavaScript, so there is no editor to insert a
 * link into: a file picked next to a comment box is stored when the comment is
 * submitted and appended to what was written. That is the whole flow, and it
 * works with the keyboard, without scripting, and on a phone.
 *
 * A file that is refused does not fail the comment. Somebody who wrote three
 * paragraphs and attached the wrong kind of file should not lose the
 * paragraphs, so the body is saved and the refusal is reported alongside it.
 */
export async function appendAttachments(
  body: string,
  files: readonly UploadedFile[],
  repositoryId: number,
  uploaderId: number | null,
): Promise<{ body: string, attached: string[], refused: string[] }> {
  const attached: string[] = []
  const refused: string[] = []
  let out = body

  for (const file of files) {
    if (!file?.buffer || (file.size ?? 0) === 0)
      continue

    const stored = await storeAttachment(file, repositoryId, uploaderId)

    if (!stored.ok) {
      refused.push(stored.error)
      continue
    }

    attached.push(stored.key)
    // A blank line before it, so an image lands under the text rather than
    // running into the last sentence.
    out = out.trimEnd() ? `${out.trimEnd()}\n\n${stored.markdown}` : stored.markdown
  }

  return { body: out, attached, refused }
}

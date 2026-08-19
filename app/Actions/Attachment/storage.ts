/**
 * Where uploaded files live, and what is allowed to be one.
 *
 * The layout is `storage/attachments/{aa}/{bb}/{key}`, keyed by a random
 * identifier rather than by the name somebody typed. Two reasons, and the
 * second is the one that matters:
 *
 * - A filename is attacker-controlled. `../../config/app.ts` and a name that a
 *   case-insensitive filesystem folds onto an existing one are both ordinary
 *   uploads as far as a browser is concerned.
 * - Attachments outlive the things they are attached to, get quoted into other
 *   issues, and end up in mirrors. A key that never changes survives a
 *   repository being renamed; a path built from the repository's name does not.
 *
 * The two-level fan-out keeps any one directory to a few thousand entries,
 * which matters on filesystems that walk a directory linearly to open a file
 * in it.
 *
 * ## Serving is the security boundary
 *
 * Nothing here is served statically. Every read goes through the action, which
 * checks the repository's visibility first, because an attachment on a private
 * repository's issue is as private as the issue. Beyond that, the rule is that
 * a file uploaded by one person and opened by another must never be *executed*
 * by the browser: same-origin HTML is stored cross-site scripting, and so is an
 * SVG, which is a document with scripting in it that happens to look like an
 * image. So only a short list of formats is served inline, and everything else
 * is a download with `nosniff` on it.
 */

/** Root of every attachment on disk, relative to the project. */
export const ATTACHMENT_ROOT = 'storage/attachments'

/** Bytes. Generous for a screenshot, small enough that nobody stores a release here. */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024

/**
 * The formats a browser may render in place, and the extension each one gets.
 *
 * An allowlist keyed by what the *file* is rather than by what its name claims,
 * so a `.png` full of HTML is stored as whatever it really is and served as a
 * download. SVG is deliberately absent: it is a document that can carry script,
 * and an image tag is not a safe place to put one.
 */
export const INLINE_TYPES: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
}

/**
 * Everything else somebody might reasonably attach to a bug report.
 *
 * These are served as downloads, never inline, so the list is about being
 * honest with the reader about what they are opening rather than about safety:
 * safety comes from the disposition header, which does not consult this table.
 */
export const DOWNLOAD_TYPES: Record<string, string> = {
  'image/svg+xml': 'svg',
  'application/pdf': 'pdf',
  'application/zip': 'zip',
  'application/gzip': 'gz',
  'text/plain': 'txt',
  'text/markdown': 'md',
  'text/csv': 'csv',
  'application/json': 'json',
  'application/x-tar': 'tar',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
}

export interface AttachmentKind {
  contentType: string
  extension: string
  /** Whether a browser may render it in place. */
  inline: boolean
}

/** What a content type means here, or null when it is not accepted. */
export function kindFor(contentType: string): AttachmentKind | null {
  // A browser sends `image/png; charset=…` more often than it should, and the
  // parameters are never part of the decision.
  const type = contentType.split(';')[0]!.trim().toLowerCase()

  const inline = INLINE_TYPES[type]
  if (inline)
    return { contentType: type, extension: inline, inline: true }

  const download = DOWNLOAD_TYPES[type]
  if (download)
    return { contentType: type, extension: download, inline: false }

  return null
}

/**
 * What the file actually is, read from its first bytes.
 *
 * The content type on an upload is whatever the client felt like sending, so it
 * is a hint and not a fact. Where the bytes disagree with the claim, the bytes
 * win: that is what stops an HTML document being stored as `image/png` and
 * later served with a content type somebody's browser is willing to render.
 *
 * Only the formats that can be recognised this way are checked. A `.txt` has no
 * signature, and the answer for those is the claim, which is safe because they
 * are served as downloads either way.
 */
export function sniff(bytes: Uint8Array): string | null {
  const starts = (...signature: number[]): boolean =>
    signature.every((byte, index) => bytes[index] === byte)

  if (starts(0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A))
    return 'image/png'

  if (starts(0xFF, 0xD8, 0xFF))
    return 'image/jpeg'

  if (starts(0x47, 0x49, 0x46, 0x38))
    return 'image/gif'

  if (starts(0x25, 0x50, 0x44, 0x46))
    return 'application/pdf'

  // A zip, which is also every format built on one.
  if (starts(0x50, 0x4B, 0x03, 0x04) || starts(0x50, 0x4B, 0x05, 0x06))
    return 'application/zip'

  if (starts(0x1F, 0x8B))
    return 'application/gzip'

  // RIFF containers name their format in bytes 8 to 11.
  if (starts(0x52, 0x49, 0x46, 0x46)) {
    const form = String.fromCharCode(...bytes.slice(8, 12))

    return form === 'WEBP' ? 'image/webp' : null
  }

  // ISO base media: `ftyp` at offset 4, then the brand.
  if (String.fromCharCode(...bytes.slice(4, 8)) === 'ftyp') {
    const brand = String.fromCharCode(...bytes.slice(8, 12))

    if (brand.startsWith('avif') || brand.startsWith('avis'))
      return 'image/avif'

    return 'video/mp4'
  }

  return null
}

/**
 * A key, and the path it lives at.
 *
 * 32 hex characters from the system's random source. Long enough that a key
 * cannot be found by trying, which matters because the key is the whole name of
 * the file on disk; it is not, on its own, the access control, which is the
 * visibility check in the serving action.
 */
export function newAttachmentKey(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('hex')
}

/** Whether a string could be a key this module generated. */
export function isAttachmentKey(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{32}$/.test(value)
}

/**
 * Where a key's bytes are, relative to the project.
 *
 * Rejects anything that is not a key rather than sanitizing it, so nothing
 * derived from a URL can name a path. There is nothing to escape: a key is 32
 * hex characters or it is not a key.
 */
export function attachmentBlobKey(key: string): string | null {
  if (!isAttachmentKey(key))
    return null

  // The same fan-out as the path below, minus the `storage/` the blob store's
  // own root supplies - so an attachment already on disk is exactly where the
  // store looks for it.
  return `attachments/${key.slice(0, 2)}/${key.slice(2, 4)}/${key}`
}

export function attachmentPath(key: string): string | null {
  if (!isAttachmentKey(key))
    return null

  return `${ATTACHMENT_ROOT}/${key.slice(0, 2)}/${key.slice(2, 4)}/${key}`
}

/** The public URL for a key. One place, so a template never builds one. */
export function attachmentUrl(key: string): string {
  return `/attachments/${key}`
}

/**
 * A name safe to hand back in `Content-Disposition`, or a fallback.
 *
 * The original name is worth keeping - somebody who downloads four logs wants
 * to be able to tell them apart - but it is user text going into a header, so
 * anything that is not an ordinary filename character is dropped rather than
 * escaped. A name that survives to nothing becomes the key plus its extension,
 * which is at least unique.
 */
export function safeFilename(original: string, key: string, extension: string): string {
  const base = original
    .split(/[\\/]/)
    .pop()!
    .replace(/[^\w.\- ]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100)

  // A leading dot hides the file, and a name that is only dots is not a name.
  const cleaned = base.replace(/^\.+/, '')

  return cleaned || `${key}.${extension}`
}

/**
 * How an attachment is written into a body.
 *
 * An image goes in as an image so it shows; everything else goes in as a link
 * with the name somebody uploaded, because a reader deciding whether to open a
 * 14 megabyte tarball wants to see what it is called.
 */
export function markdownFor(kind: AttachmentKind, key: string, filename: string): string {
  const label = filename.replaceAll('[', '\\[').replaceAll(']', '\\]')
  const url = attachmentUrl(key)

  return kind.inline ? `![${label}](${url})` : `[${label}](${url})`
}

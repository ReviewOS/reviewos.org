/**
 * The one exception to "nothing from a repository is served as its own type".
 *
 * `download.ts` explains the rule and why it exists: a file somebody pushed,
 * served as `text/html` from this origin, runs script with this application's
 * cookies. That rule is what makes raw URLs safe, and it is also why an image
 * in a README could not be shown - a browser will not paint an `<img>` whose
 * response says `application/octet-stream` and `nosniff`.
 *
 * So this module is deliberately narrow. It answers one question - *do these
 * bytes begin like an image of a kind we are willing to serve?* - and it
 * answers it from the **bytes**, never from the filename. The filename is what
 * every version of this mistake has been built on: the moment a type is decided
 * by an extension, `logo.png.html` is one rename away from being a page.
 *
 * The allowlist is closed and every entry is a raster format a browser decodes
 * into pixels and nothing else, plus SVG, which is not - see below.
 */

export type MediaType =
  | 'image/png'
  | 'image/jpeg'
  | 'image/gif'
  | 'image/webp'
  | 'image/avif'
  | 'image/bmp'
  | 'image/x-icon'
  | 'image/svg+xml'

/**
 * As large as an image in a README is allowed to be.
 *
 * This endpoint buffers, unlike raw, because sniffing means looking at the
 * bytes before deciding the header - and a response whose status is already
 * sent cannot be taken back. Eight megabytes is far past any diagram and far
 * short of anything worth holding in memory per request; a larger file is still
 * reachable through raw as a download.
 */
export const MAX_MEDIA_BYTES = 8 * 1024 * 1024

/** How much of the file is enough to recognise every format below. */
const SNIFF_BYTES = 64

function startsWith(bytes: Uint8Array, signature: readonly number[], at = 0): boolean {
  if (bytes.length < at + signature.length)
    return false

  for (let index = 0; index < signature.length; index++) {
    if (bytes[at + index] !== signature[index])
      return false
  }

  return true
}

function ascii(bytes: Uint8Array, from: number, to: number): string {
  let out = ''
  for (let index = from; index < to && index < bytes.length; index++)
    out += String.fromCharCode(bytes[index]!)

  return out
}

/** ISO base media brands that are AVIF rather than video. */
const AVIF_BRANDS = new Set(['avif', 'avis'])

/**
 * What these bytes are, or null for anything not on the list.
 *
 * Null is the safe answer and the common one: a `.pdf`, a font, a video, a
 * corrupt file, and a text file with an image's name all come back null and are
 * refused. The caller does not get to override it.
 */
export function sniffImageType(bytes: Uint8Array): MediaType | null {
  // 89 'P' 'N' 'G' CR LF SUB LF - eight bytes chosen by PNG itself to survive
  // being mangled by a text-mode transfer, which makes it a very good signature.
  if (startsWith(bytes, [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]))
    return 'image/png'

  if (startsWith(bytes, [0xFF, 0xD8, 0xFF]))
    return 'image/jpeg'

  if (ascii(bytes, 0, 6) === 'GIF87a' || ascii(bytes, 0, 6) === 'GIF89a')
    return 'image/gif'

  // RIFF container, WEBP payload. The four bytes between them are the length,
  // so they are skipped rather than matched.
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WEBP')
    return 'image/webp'

  // ISO base media: a length, then `ftyp`, then the brand. Only the still-image
  // brands are accepted - the same container holds MP4, and serving that as an
  // image would be serving a media type nobody asked this endpoint for.
  if (ascii(bytes, 4, 8) === 'ftyp' && AVIF_BRANDS.has(ascii(bytes, 8, 12)))
    return 'image/avif'

  if (ascii(bytes, 0, 2) === 'BM')
    return 'image/bmp'

  // Windows icon: reserved zero, type 1, and a non-zero image count. The first
  // four bytes alone match too much to be worth trusting on their own.
  if (startsWith(bytes, [0x00, 0x00, 0x01, 0x00]) && (bytes[4] ?? 0) + (bytes[5] ?? 0) > 0)
    return 'image/x-icon'

  return looksLikeSvg(bytes) ? 'image/svg+xml' : null
}

/**
 * Whether the file opens as an SVG document.
 *
 * **SVG is the one entry on the list that is a document rather than a
 * decoder.** It can carry `<script>`, and a forge that serves it from its own
 * origin as `image/svg+xml` has handed anyone who can push a file a page on
 * that origin. It is on the list anyway because architecture diagrams and
 * generated charts in READMEs are overwhelmingly SVG, and the two things that
 * make it safe are in the response rather than here:
 *
 * - `Content-Security-Policy: default-src 'none'; sandbox`, which denies the
 *   document every subresource *and* puts it in an opaque origin, so script
 *   cannot run and could reach nothing if it did;
 * - `nosniff`, so the type this module chose is the type the browser uses.
 *
 * Inside an `<img>` - which is the only reason this endpoint exists - script in
 * SVG never runs at all. The CSP is for the person who pastes the URL into the
 * address bar.
 *
 * Recognised by scanning past a BOM, whitespace, an XML declaration, comments
 * and a doctype to the first real tag, because all five are ordinary in a file
 * exported by a drawing tool.
 */
export function looksLikeSvg(bytes: Uint8Array): boolean {
  // Only the head is decoded: this is a shape check, and a megabyte of path
  // data says nothing the first line does not.
  const head = new TextDecoder('utf-8', { fatal: false })
    .decode(bytes.subarray(0, 1024))
    .replace(/^﻿/, '')

  let rest = head.trimStart()

  // `<?xml …?>`, `<!-- … -->`, `<!DOCTYPE …>`, in any order and any number.
  for (let guard = 0; guard < 8; guard++) {
    const before = rest

    if (rest.startsWith('<?')) {
      const end = rest.indexOf('?>')
      rest = end === -1 ? '' : rest.slice(end + 2).trimStart()
    }
    else if (rest.startsWith('<!--')) {
      const end = rest.indexOf('-->')
      rest = end === -1 ? '' : rest.slice(end + 3).trimStart()
    }
    else if (/^<!doctype/i.test(rest)) {
      const end = rest.indexOf('>')
      rest = end === -1 ? '' : rest.slice(end + 1).trimStart()
    }

    if (rest === before)
      break
  }

  // A tag name ends at whitespace or `>`; `<svgfoo` is not an SVG.
  return /^<svg[\s/>]/i.test(rest)
}

/** Everything a media response needs, decided together. */
export interface MediaHeaders {
  contentType: MediaType
  /**
   * Inline, because the whole point is an `<img>`. Safe only because the type
   * came from the bytes and `nosniff` is set beside it.
   */
  disposition: string
  /**
   * Inert: no subresources, no script, opaque origin. Applies to every type
   * here rather than only to SVG, because a policy with an exception is a
   * policy somebody will extend the exception of.
   */
  contentSecurityPolicy: string
}

export function mediaHeaders(type: MediaType): MediaHeaders {
  return {
    contentType: type,
    disposition: 'inline',
    contentSecurityPolicy: 'default-src \'none\'; style-src \'unsafe-inline\'; sandbox',
  }
}

/** How many bytes are worth looking at to decide. */
export const MEDIA_SNIFF_BYTES = SNIFF_BYTES

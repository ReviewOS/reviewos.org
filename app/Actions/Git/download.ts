/**
 * Serving bytes out of a repository.
 *
 * The rules are here, pure, because two of them are security decisions and a
 * security decision inside a request handler is a security decision nobody
 * tests.
 *
 * **Nothing served from a repository is served as its own type.** A repository
 * is somebody else's content: a file called `x.html` that a stranger pushed is
 * a page, and served as `text/html` from this origin it runs script with this
 * application's cookies. Every forge that got this wrong got it wrong the same
 * way. So the content type is decided by *this* module rather than by the
 * file's extension, `nosniff` is always set so a browser does not overrule it,
 * and anything that is not plainly text is sent as an attachment.
 *
 * The other is the filename. It goes into a `Content-Disposition` header, where
 * a quote or a newline in a repository name would let the pusher write headers.
 */

/** Types that may be shown inline, because a browser renders them as text. */
const PLAIN_TEXT = 'text/plain; charset=utf-8'

export interface DownloadHeaders {
  contentType: string
  disposition: string
  /** Always set. A browser that sniffs undoes every decision above. */
  nosniff: true
}

/**
 * How a raw file is served.
 *
 * Text inline, everything else as a download. `inline` is what makes a raw URL
 * useful - somebody links to a file and expects to read it - and it is only
 * safe because the type is `text/plain` no matter what the file is called.
 *
 * An image is the one thing people miss here. Serving `logo.png` as
 * `image/png` would be convenient and is deliberately not done: it means
 * deciding a type from a repository's own filename, and the moment that
 * mechanism exists somebody extends it to a type that executes.
 */
export function rawHeaders(path: string, binary: boolean): DownloadHeaders {
  return {
    contentType: binary ? 'application/octet-stream' : PLAIN_TEXT,
    disposition: `${binary ? 'attachment' : 'inline'}; filename="${headerSafeName(basename(path))}"`,
    nosniff: true,
  }
}

export type ArchiveFormat = 'zip' | 'tar.gz'

/**
 * The archive format a request is asking for.
 *
 * Two, because `git archive` produces exactly these two usefully and a third
 * would be a format nobody asked for that still has to be maintained. Null for
 * anything else, so the caller answers rather than guessing.
 */
export function archiveFormat(raw: unknown): ArchiveFormat | null {
  const value = String(raw ?? '').trim().toLowerCase()

  if (value === 'zip')
    return 'zip'

  if (value === 'tar.gz' || value === 'targz' || value === 'tgz' || value === 'tar')
    return 'tar.gz'

  return null
}

/** What `git archive --format` is given. */
export function gitArchiveFormat(format: ArchiveFormat): string {
  // `tar.gz` is a real format name to git, which gzips for us rather than
  // needing the output piped through anything.
  return format === 'zip' ? 'zip' : 'tar.gz'
}

export function archiveContentType(format: ArchiveFormat): string {
  return format === 'zip' ? 'application/zip' : 'application/gzip'
}

/**
 * What the downloaded file is called.
 *
 * `repository-ref.zip`, with anything a filesystem or a header would object to
 * replaced. A ref may contain slashes (`release/1.0`), which would make the
 * name look like a path.
 */
export function archiveFilename(repository: string, ref: string, format: ArchiveFormat): string {
  return `${slugForFilename(repository)}-${slugForFilename(ref)}.${format}`
}

/**
 * The directory every entry in the archive sits under.
 *
 * Without it the archive unpacks into whatever directory somebody happened to
 * be in - the tar bomb - and the difference between a repository and a hundred
 * loose files in a home directory is one trailing slash here.
 */
export function archivePrefix(repository: string, ref: string): string {
  return `${slugForFilename(repository)}-${slugForFilename(ref)}/`
}

/** The last segment of a path, with no assumption that there is one. */
export function basename(path: string): string {
  const segments = String(path).split('/').filter(Boolean)

  return segments[segments.length - 1] ?? 'file'
}

/**
 * A name that cannot break out of a quoted header value.
 *
 * Quotes, backslashes and control characters go. This is the only thing
 * standing between a repository name somebody chose and a response header they
 * wrote, so it is an allowlist of what survives rather than a list of what is
 * removed.
 */
export function headerSafeName(name: string): string {
  const cleaned = [...String(name)]
    .filter(character => character >= ' ' && character !== '' && character !== '"' && character !== '\\')
    .join('')
    .trim()

  return cleaned.slice(0, 120) || 'file'
}

/** A name safe in a filename: one run of anything unusual becomes one dash. */
export function slugForFilename(value: string): string {
  const slug = String(value).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')

  // A ref called `..` would otherwise produce a filename of dots.
  return /^\.+$/.test(slug) || !slug ? 'archive' : slug.slice(0, 80)
}

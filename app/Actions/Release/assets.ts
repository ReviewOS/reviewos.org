/**
 * Files attached to a release: a built binary, a checksum file, a signature.
 *
 * The rules are simpler than the ones for an issue attachment, and deliberately
 * stricter. An attachment is often a screenshot somebody wants to see inline,
 * so that module has to decide which types are safe to render. A release asset
 * is never rendered: it is a compiled artefact that somebody downloads and
 * runs. So there is no allowlist to get wrong and no inline case to reason
 * about - **every asset is served as an opaque download**, whatever it is
 * called and whatever it claims to be.
 *
 * Not the source archive. That one is generated on demand by `git archive` from
 * the tag, so it cannot drift from the tag it claims to be and costs no
 * storage. What lives here is what could not be produced from the repository.
 */

/** Where the bytes live, relative to the project. */
export const ASSET_ROOT = 'storage/release-assets'

/**
 * How large one asset may be.
 *
 * Far larger than an issue attachment, because the thing people attach to a
 * release is a compiled binary and a small one of those is fifty megabytes.
 * Still bounded: an unbounded upload endpoint is a disk-filling endpoint, and
 * the answer for something genuinely larger is a package registry rather than a
 * bigger number here.
 */
export const MAX_ASSET_BYTES = 2 * 1024 * 1024 * 1024

/**
 * A key: 32 hex characters from the system's random source.
 *
 * Long enough that it cannot be found by trying, which matters because the key
 * is the whole name of the file on disk. It is not, on its own, the access
 * control - that is the visibility check in the serving action.
 */
export function newAssetKey(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('hex')
}

/** Whether a string could be a key this module generated. */
export function isAssetKey(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{32}$/.test(value)
}

/**
 * Where a key's bytes are.
 *
 * Rejects anything that is not a key rather than sanitizing it, so nothing
 * derived from a URL can name a path. There is nothing to escape: a key is 32
 * hex characters or it is not a key.
 *
 * Fanned out two levels, because a popular project publishes a dozen assets per
 * release and a directory with a hundred thousand entries in it is a directory
 * every tool is slow to list.
 */
export function assetPath(key: string): string | null {
  if (!isAssetKey(key))
    return null

  return `${ASSET_ROOT}/${key.slice(0, 2)}/${key.slice(2, 4)}/${key}`
}

/**
 * The name an asset is downloaded as.
 *
 * Kept close to what was uploaded, because the name of a release binary is
 * meaningful - `checkout-linux-amd64.tar.gz` says which one to take - but it is
 * a stranger's text going into a header and into a filesystem, so anything that
 * is not an ordinary filename character is dropped rather than escaped.
 */
export function assetName(original: string): string | null {
  const base = String(original ?? '')
    .split(/[\\/]/)
    .pop()!
    .replace(/[^\w.+\- ]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200)

  // A leading dot hides the file, and a name that is only dots is not a name.
  const cleaned = base.replace(/^\.+/, '')

  return cleaned || null
}

/**
 * SHA-256 of the bytes, hex.
 *
 * Recorded on upload so a download can be checked without trusting the
 * transport, and so an asset that was replaced can be told from one that was
 * not. Published next to the file, which is the only reason a checksum is worth
 * anything: a checksum nobody can see is a checksum nobody can check.
 */
export function checksumOf(bytes: Uint8Array): string {
  return new Bun.CryptoHasher('sha256').update(bytes).digest('hex')
}

export type AssetRejection = { ok: false, error: string, status: number }

export type AssetDecision =
  | { ok: true, name: string, bytes: number }
  | AssetRejection

/**
 * Whether an upload may be stored, and under what name.
 *
 * The size is checked against what actually arrived rather than against a
 * declared length: a `Content-Length` is a claim, and the bytes are the fact.
 */
export function decideAsset(originalName: string, byteLength: number): AssetDecision {
  const name = assetName(originalName)

  if (!name)
    return { ok: false, error: 'That file name cannot be used', status: 422 }

  if (byteLength <= 0)
    return { ok: false, error: 'That file is empty', status: 422 }

  if (byteLength > MAX_ASSET_BYTES)
    return { ok: false, error: `A release asset may be at most ${Math.floor(MAX_ASSET_BYTES / (1024 * 1024))} MB`, status: 413 }

  return { ok: true, name, bytes: byteLength }
}

/**
 * How an asset is served.
 *
 * One shape for everything, which is the whole point. A release asset is a
 * stranger's file and it is never rendered, so it goes out as an opaque
 * download with `nosniff` - the same rule the raw file endpoint follows, minus
 * the inline case that endpoint needs and this one does not.
 */
export function assetHeaders(name: string, size: number): Record<string, string> {
  return {
    'Content-Type': 'application/octet-stream',
    'Content-Disposition': `attachment; filename="${headerSafe(name)}"`,
    'Content-Length': String(size),
    'X-Content-Type-Options': 'nosniff',
    // An asset never changes: replacing one means deleting it and uploading
    // another, which is a different key.
    'Cache-Control': 'public, max-age=31536000, immutable',
  }
}

/** A name that cannot break out of a quoted header value. */
function headerSafe(name: string): string {
  return [...name]
    .filter(character => character >= ' ' && character !== '"' && character !== '\\')
    .join('')
    .slice(0, 200) || 'download'
}

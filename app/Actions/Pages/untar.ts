/**
 * Reading a tar archive, which is the other half of `Artifact/tar.ts`.
 *
 * A published site arrives as one artifact, and one artifact is one file, so a
 * site is a tarball. Writing the reader here rather than pulling one in is the
 * same trade the writer made: tar is a 512-byte header and padded content, and
 * a dependency that extracts archives is a dependency with a directory
 * traversal CVE in its future.
 *
 * ## Everything here is a rule about hostile input
 *
 * The bytes were produced by a build of somebody's repository. Every field
 * below is attacker-controlled, and the two that matter are the name and the
 * size:
 *
 * - **A name is a name, never a path.** `../../../etc/passwd`,
 *   `/etc/passwd`, and a symlink pointing at either are the oldest archive
 *   exploit there is, and the extractor is the only place that can refuse them.
 * - **A size is a claim.** An entry claiming 8 exabytes is how a reader is made
 *   to allocate until the process dies, so the header is checked against what
 *   is actually left in the buffer.
 *
 * Only regular files and directories are extracted. Symlinks, hard links,
 * devices and FIFOs are skipped rather than refused: a `dist/` produced by a
 * real build occasionally carries a symlink, and failing the whole publish over
 * one is worse than serving the site without it.
 */

/** One file read out of an archive. */
export interface TarFile {
  /** The entry's path, already checked: relative, no `..`, no leading slash. */
  name: string
  bytes: Uint8Array
}

const BLOCK = 512

/**
 * The most one archive may expand to.
 *
 * Checked while reading rather than after, so a zip-bomb-shaped tarball is
 * refused at the entry that crosses the line instead of after the disk is full.
 * Generous for a documentation site and far below what would matter to the box.
 */
export const MAX_SITE_BYTES = 1024 * 1024 * 1024

/** And the most files, because a million empty files is the other shape of the same attack. */
export const MAX_SITE_FILES = 100_000

export interface UntarResult {
  files: TarFile[]
  /** Set when the archive was refused, naming which rule it broke. */
  error?: string
}

/**
 * Whether an entry's name may be written.
 *
 * Rejects absolute paths, any segment that is `..`, Windows drive letters, and
 * NUL bytes. `./` prefixes are stripped by the caller before this runs, because
 * `tar -C dist .` writes every name that way and refusing them would refuse
 * every archive anybody actually produces.
 */
export function isSafeEntryName(name: string): boolean {
  if (!name || name.length > 4096)
    return false

  if (name.includes('\0') || name.startsWith('/') || name.startsWith('\\'))
    return false

  // `C:\...`, which a build on a Windows runner can produce.
  if (/^[a-z]:/i.test(name))
    return false

  return !name.split('/').some(segment => segment === '..')
}

/** Read a NUL- or space-terminated field out of a header block. */
function field(block: Uint8Array, offset: number, length: number): string {
  const slice = block.subarray(offset, offset + length)
  let end = 0
  while (end < slice.length && slice[end] !== 0 && slice[end] !== 0x20) end++

  return new TextDecoder().decode(slice.subarray(0, end))
}

/** tar sizes are octal, in ASCII. A malformed one reads as zero rather than NaN. */
function octal(value: string): number {
  const parsed = Number.parseInt(value.trim(), 8)

  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0
}

/**
 * Extract every regular file from an archive.
 *
 * Returns `error` rather than throwing: a publish that fails has to record a
 * sentence somebody can read on the settings page, and an exception on the way
 * out of here would arrive there as "Error".
 */
export function untar(bytes: Uint8Array): UntarResult {
  const files: TarFile[] = []
  let total = 0
  let at = 0

  while (at + BLOCK <= bytes.length) {
    const header = bytes.subarray(at, at + BLOCK)

    // Two empty blocks end an archive; one is enough to stop reading, because
    // what follows the first is padding either way.
    if (header.every(byte => byte === 0))
      break

    const rawName = field(header, 0, 100)
    const size = octal(field(header, 124, 12))
    const type = String.fromCharCode(header[156] || 0x30)
    // The POSIX `prefix` field, which holds the leading directories of a path
    // too long for the 100-byte name. Ignoring it turns one long path into a
    // file written at the archive root, silently, on top of whatever was there.
    const prefix = field(header, 345, 155)

    at += BLOCK

    if (at + size > bytes.length)
      return { files, error: 'The archive claims a file larger than the archive itself.' }

    const payload = bytes.subarray(at, at + size)
    at += size

    // Content is padded to a block boundary.
    const remainder = size % BLOCK
    if (remainder !== 0)
      at += BLOCK - remainder

    // A regular file, and only that. Old archivers write a NUL type byte where
    // modern ones write '0', which `type` already normalised. '5' is a
    // directory and needs no entry of its own, because writing a file creates
    // its parents. Everything else - symlinks, hard links, devices, the GNU
    // long-name extension - is skipped.
    if (type !== '0')
      continue

    const joined = prefix ? `${prefix}/${rawName}` : rawName
    // `tar -C dist .` writes `./index.html`. Stripping the prefix here rather
    // than rejecting it is why the archive a person actually produces works.
    const name = joined.replace(/^\.\//, '').replace(/\/+$/, '')

    if (!name || !isSafeEntryName(name))
      continue

    total += size

    if (total > MAX_SITE_BYTES)
      return { files, error: `The site expands to more than ${Math.round(MAX_SITE_BYTES / 1024 / 1024)} MB.` }

    if (files.length >= MAX_SITE_FILES)
      return { files, error: `The site holds more than ${MAX_SITE_FILES} files.` }

    files.push({ name, bytes: new Uint8Array(payload) })
  }

  return { files }
}

/**
 * Ungzip when the bytes are gzipped, and pass them through when they are not.
 *
 * Both are accepted because both are what people produce: `tar -czf` is the
 * habit and `tar -cf` is what a workflow that already compresses per-file
 * writes. Sniffing the magic number is more reliable than trusting the artifact
 * name, which is chosen by whoever wrote the workflow.
 */
export function maybeGunzip(bytes: Uint8Array): Uint8Array {
  const gzipped = bytes.length > 2 && bytes[0] === 0x1F && bytes[1] === 0x8B

  // Copied into a plain `Uint8Array` first. The bytes arrive from the artifact
  // store as a view that may sit on a `SharedArrayBuffer`, which `gunzipSync`
  // does not accept - and the failure is a type error at the boundary rather
  // than anywhere near where the archive came from.
  return gzipped ? Bun.gunzipSync(new Uint8Array(bytes)) : bytes
}

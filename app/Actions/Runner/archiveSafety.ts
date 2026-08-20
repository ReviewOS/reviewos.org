/**
 * Whether an archive may be unpacked over a workspace.
 *
 * A cache snapshot is a tarball this instance handed a runner, and unpacking it
 * is the moment a run stops being in control of what lands on its disk. Two
 * shapes escape the directory it is aimed at:
 *
 * - an entry named `../../etc/thing`, which writes wherever the `..` reach,
 * - a **symlink** entry pointing outside, followed by an entry written *through*
 *   it - `link -> /etc` and then `link/passwd`.
 *
 * `docs/ci-security-review.md` scored this as not met, in those words:
 * *"Extraction is the runner's, unguarded and untested."* It was: the runner ran
 * `tar -xzpf` and trusted the archive.
 *
 * ## Why not rely on tar refusing it
 *
 * Because "tar" is two programs. GNU tar and bsdtar both defend against most of
 * this now, in versions that differ, with flags that differ - and this codebase
 * has already been bitten once by exactly that shape: `ulimit -S -H` meant what
 * it looked like in bash and set nothing at all in dash, so every step ceiling
 * was inert on Linux and enforced on a Mac for months.
 *
 * A boundary that depends on which tar is installed is not a boundary anybody
 * can reason about. So the archive is *inspected* first, by rules written here,
 * and refused before a single byte is extracted. If the tar underneath also
 * refuses it, good - two locks.
 *
 * ## Reading the archive without parsing columns
 *
 * `tar -tvzf` prints a mode, an owner, a size, a date, the path, and ` -> target`
 * for a link - and the columns are laid out differently by the two tars, so
 * picking the path out of that line is the fragile thing this file must not do.
 *
 * `tar -tzf` prints the paths alone, one per line, identically in both. Both
 * listings walk the archive in the same order, so they are read as a pair and
 * zipped by index: the name comes from the plain listing, and the type and link
 * target from the verbose one. Nothing has to know where a column starts.
 */

/** One entry, as the two listings together describe it. */
export interface ArchiveEntry {
  path: string
  /** Where a link points, when this entry is one. */
  target: string | null
  /** A symlink or a hard link, which are the entries that can point outside. */
  isLink: boolean
}

/**
 * The two listings, as entries.
 *
 * Zipped by index and bounded by the shorter, because a mismatch means the
 * archive changed between the two reads or a tar wrote something unexpected -
 * and in either case the safe answer is to describe fewer entries confidently
 * rather than more entries wrongly. `firstUnsafe` refuses an archive whose
 * listings disagree in length for that reason.
 */
export function zipListing(names: string, verbose: string): ArchiveEntry[] {
  const paths = lines(names)
  const detail = lines(verbose)
  const entries: ArchiveEntry[] = []

  for (let index = 0; index < Math.min(paths.length, detail.length); index += 1) {
    const path = paths[index] ?? ''
    const line = detail[index] ?? ''

    // The first character of the mode is the type, and that much both tars
    // agree on: `l` for a symbolic link, `h` for a hard link.
    const kind = line.charAt(0)
    const isLink = kind === 'l' || kind === 'h'

    // The last ` -> ` rather than the first: a file may legitimately contain
    // that sequence in its name, and the target is what follows the final one.
    const arrow = isLink ? line.lastIndexOf(' -> ') : -1

    entries.push({
      path,
      target: arrow >= 0 ? line.slice(arrow + 4).trim() : null,
      isLink,
    })
  }

  return entries
}

/**
 * Whether a path stays inside the directory it is unpacked into.
 *
 * Normalised by walking the segments rather than by asking the filesystem,
 * because the filesystem would answer about a directory that exists and this is
 * a question about a name in an archive. A `..` that pops past the root is the
 * escape; a `..` that is later cancelled by a segment is ordinary and allowed -
 * `a/../b` is `b`, which is fine.
 */
export function withinRoot(path: string): boolean {
  const cleaned = String(path ?? '').trim()

  // An absolute path ignores the destination entirely, and a Windows-style
  // drive or a UNC path is the same idea in another spelling.
  if (cleaned.startsWith('/') || cleaned.startsWith('\\') || /^[a-z]:/i.test(cleaned))
    return false

  let depth = 0

  for (const segment of cleaned.split('/')) {
    if (segment === '' || segment === '.')
      continue

    if (segment === '..') {
      depth -= 1

      // The moment it is above the root it has escaped, even if a later
      // segment would bring it back: `../../x/../workspace` reaches outside on
      // the way through, and an extraction follows the path as written.
      if (depth < 0)
        return false

      continue
    }

    depth += 1
  }

  return true
}

/**
 * Where a link lands, relative to the archive's root.
 *
 * A relative target is resolved against the *directory the link is in*, which
 * is the part that makes `node_modules/.bin/tsc -> ../typescript/bin/tsc` legal
 * and has to stay legal: those symlinks are most of what a dependency cache is
 * for, and a rule that refused every `..` in a target would refuse every real
 * snapshot.
 */
export function linkLandsWithin(path: string, target: string): boolean {
  const to = String(target ?? '').trim()

  if (to === '')
    return false

  if (to.startsWith('/') || to.startsWith('\\') || /^[a-z]:/i.test(to))
    return false

  const directory = String(path ?? '').split('/').slice(0, -1).join('/')

  return withinRoot(directory ? `${directory}/${to}` : to)
}

/** Why this entry may not be unpacked, or null when it may. */
export function refusalFor(entry: ArchiveEntry): string | null {
  if (!withinRoot(entry.path))
    return `\`${entry.path}\` is a path outside the workspace`

  if (entry.isLink) {
    const target = entry.target ?? ''

    if (!linkLandsWithin(entry.path, target))
      return `\`${entry.path}\` links to \`${target || '(nothing)'}\`, which is outside the workspace`
  }

  return null
}

/**
 * The first entry that may not be unpacked, or null for an archive that may.
 *
 * The first rather than all of them: this refuses the whole archive either way,
 * and an operator reading "one of nine hundred entries is a symlink to /etc"
 * needs the one.
 */
export function firstUnsafe(names: string, verbose: string): { path: string, reason: string } | null {
  const paths = lines(names)
  const detail = lines(verbose)

  /*
   * Listings of different lengths are refused rather than reconciled.
   *
   * They are two reads of one file and should agree. If they do not, something
   * is wrong that this code cannot name - and the entry the zip would drop is
   * exactly the one an attacker would want dropped.
   */
  if (paths.length !== detail.length)
    return { path: '', reason: 'the archive listed a different number of entries each time it was read' }

  for (const entry of zipListing(names, verbose)) {
    const reason = refusalFor(entry)

    if (reason)
      return { path: entry.path, reason }
  }

  return null
}

/** Non-empty lines, which is what both listings are. */
function lines(value: string): string[] {
  return String(value ?? '').split('\n').filter(one => one.trim() !== '')
}

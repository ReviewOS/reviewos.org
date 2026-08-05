/**
 * How long a deleted repository stays recoverable, and which repositories are
 * worth packing.
 *
 * Both decisions are here, pure, because both are the kind that read as
 * obvious and are not: one of them permanently destroys somebody's work when
 * it is wrong, and the other decides how much of the night the server spends
 * repacking.
 */

/**
 * How long a deleted repository is kept.
 *
 * Thirty days for the same reason every provider lands near it: it is longer
 * than a holiday, so somebody who deleted the wrong thing before going away can
 * still get it back when they return and find out.
 */
export const RETENTION_DAYS = 30

/** `name.2026-08-05T19-30-00-000Z.git`, as `retiredPath` writes it. */
const RETIRED = /^(.+)\.(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)\.git$/

export interface RetiredRepository {
  directory: string
  name: string
  deletedAtMs: number
}

/**
 * Read the timestamp back out of a retired repository's directory name.
 *
 * The name is the record. There is no row left for a deleted repository, which
 * is the point: this has to work from the directory alone, including for
 * somebody looking at the filesystem with the application stopped.
 *
 * Anything that does not match is not ours and is reported as such rather than
 * being given a timestamp of zero - which would place it in 1970 and make the
 * sweep below delete it immediately.
 */
export function readRetired(directory: string): RetiredRepository | null {
  const match = RETIRED.exec(directory)
  if (!match)
    return null

  // Back to the ISO form the name was built from: the colons and the decimal
  // point were replaced to keep a filesystem happy.
  const [date, time] = match[2]!.split('T')
  const parts = time!.replace('Z', '').split('-')
  if (parts.length !== 4)
    return null

  const iso = `${date}T${parts[0]}:${parts[1]}:${parts[2]}.${parts[3]}Z`
  const at = Date.parse(iso)

  if (!Number.isFinite(at))
    return null

  return { directory, name: match[1]!, deletedAtMs: at }
}

/**
 * Which retired repositories are past the window.
 *
 * A directory whose name cannot be read is **never** returned. Something that
 * is not recognised sitting in this directory is a reason for somebody to look,
 * not a reason to delete it: the whole point of this directory is that the
 * bytes in it are the last copy.
 */
export function expiredRetirements(
  directories: readonly string[],
  nowMs: number,
  retentionDays: number = RETENTION_DAYS,
): RetiredRepository[] {
  const cutoff = nowMs - retentionDays * 24 * 60 * 60 * 1000

  return directories
    .map(readRetired)
    .filter((entry): entry is RetiredRepository => entry !== null)
    .filter(entry => entry.deletedAtMs <= cutoff)
}

/**
 * How much loose material makes a repository worth packing.
 *
 * git's own `gc --auto` uses 6700 loose objects, which is tuned for a working
 * copy somebody commits to by hand. A forge receives pushes, and a push under
 * `transfer.unpackLimit` arrives as loose objects, so a busy repository
 * accumulates them faster than any person would - and every one of them is a
 * separate file that a clone has to read.
 *
 * Packs matter as much as objects. Fifty packfiles is fifty indexes to search
 * for every object lookup, which is what makes a repository that was never
 * repacked slow to clone even when it is small.
 */
export const LOOSE_OBJECT_THRESHOLD = 1000
export const PACK_THRESHOLD = 20

export function needsPacking(counts: { looseObjects: number, packs: number }): boolean {
  return counts.looseObjects >= LOOSE_OBJECT_THRESHOLD || counts.packs >= PACK_THRESHOLD
}

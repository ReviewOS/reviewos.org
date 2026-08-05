/**
 * How much disk a repository is using.
 *
 * `repositories.size_kb` exists so a listing, a quota check or an admin page can
 * answer "how big is this" without walking a directory tree per row. It is
 * refreshed after a push and after a fork, which are the only two things that
 * change it by any amount worth noticing.
 *
 * The number comes from `git count-objects -v`, not from `du`. Three reasons,
 * and the third is the one that matters:
 *
 * - It is what git itself considers the repository, so it does not drift when
 *   the on-disk layout changes.
 * - It separates loose objects from packed ones, so a repository that has just
 *   received a large push does not appear to shrink when it is later packed. It
 *   does shrink, and the number should say so.
 * - **Forks share their objects.** A fork is cloned with `--local`, which
 *   hardlinks the object store, so `du` counts the same bytes once per fork and
 *   a hundred forks of one repository appear to use a hundred times the disk
 *   they use. `count-objects` reports what the repository contains, which is the
 *   honest answer to the question a size column is asked.
 */

import { runGit } from '../Git/git'

export interface RepositorySize {
  /** Loose objects plus packs, in kibibytes, as git counts them. */
  kb: number
  looseKb: number
  packKb: number
  looseObjects: number
}

/**
 * Read `git count-objects -v` into numbers.
 *
 * Exported and pure so the parsing is testable without a repository: the
 * output is a plain `key: value` list, and the one thing that would go
 * unnoticed is reading the wrong key and recording a count of objects as a
 * number of kilobytes.
 */
export function parseCountObjects(output: string): RepositorySize {
  const values = new Map<string, number>()

  for (const line of output.split('\n')) {
    const [key, value] = line.split(':')
    if (!key || value === undefined)
      continue

    const parsed = Number(value.trim())
    if (Number.isFinite(parsed))
      values.set(key.trim(), parsed)
  }

  const looseKb = values.get('size') ?? 0
  const packKb = values.get('size-pack') ?? 0

  return {
    kb: looseKb + packKb,
    looseKb,
    packKb,
    looseObjects: values.get('count') ?? 0,
  }
}

/** Measure a repository on disk. Null when git could not answer. */
export async function measure(repositoryPath: string): Promise<RepositorySize | null> {
  const result = await runGit(repositoryPath, ['count-objects', '-v'])
  if (!result.ok)
    return null

  return parseCountObjects(result.stdout)
}

/**
 * Measure a repository and write the answer to its row.
 *
 * Never throws. A size column is a nicety, and it is never worth failing the
 * push or the fork that prompted it: the number being an hour stale is
 * invisible, and the push being refused is not.
 */
export async function recordSize(repositoryId: number, repositoryPath: string): Promise<number | null> {
  if (!Number.isFinite(repositoryId) || repositoryId <= 0)
    return null

  try {
    const size = await measure(repositoryPath)
    if (!size)
      return null

    await db
      .updateTable('repositories')
      .set({ size_kb: Math.round(size.kb) })
      .where('id', '=', repositoryId)
      .execute()

    return Math.round(size.kb)
  }
  catch {
    return null
  }
}

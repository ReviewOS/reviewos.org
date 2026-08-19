/**
 * Removing a test repository's directory, and only ever that.
 *
 * Every end-to-end test that touches git creates a bare repository under
 * `storage/repos/<owner>/<name>.git` and tears it down afterwards. The teardown
 * used to be written inline, and one file wrote it in the form that can delete
 * anything:
 *
 * ```ts
 * const created = { diskPath: '' }                 // set during setup
 * afterAll(() => {
 *   rmSync(resolve(created.diskPath, '..'), { recursive: true, force: true })
 * })
 * ```
 *
 * When setup fails before it assigns `diskPath` - a database that will not
 * connect, a port already taken, anything - the field is still `''`, and
 * `resolve('', '..')` is not "nothing". It is the *parent of the working
 * directory*. That teardown deleted `~/Code/Apps`, with this project and every
 * other project beside it in it, and `force: true` meant it did so without a
 * word.
 *
 * So teardown goes through here. It removes a path only when it is inside this
 * project's `storage/repos`, and otherwise says what it refused to do. The
 * check is cheap and the failure it prevents is unbounded.
 */

import { existsSync, readdirSync, rmdirSync, rmSync } from 'node:fs'
import { isAbsolute, resolve, sep } from 'node:path'
import process from 'node:process'

/** Where every test repository lives. Nothing outside it may be removed. */
export function repositoryRoot(cwd = process.cwd()): string {
  return resolve(cwd, 'storage', 'repos')
}

/**
 * Whether a path is inside the repository store.
 *
 * Compared with a trailing separator so `storage/repos-backup` cannot pass as
 * `storage/repos`, and the store itself is not its own child: emptying it would
 * take every other test's fixtures with it.
 */
export function insideRepositoryStore(path: string, cwd = process.cwd()): boolean {
  if (!path || !isAbsolute(path))
    return false

  const root = repositoryRoot(cwd)

  return path.startsWith(root + sep)
}

/**
 * Remove one test repository. A path outside the store is refused, loudly.
 *
 * The refusal is a thrown error rather than a silent return: a teardown that
 * quietly skipped would leave fixtures behind for the next run to trip over,
 * and the whole point here is that the surprising case gets said out loud.
 */
export function removeRepositoryDirectory(diskPath: string, cwd = process.cwd()): void {
  if (!insideRepositoryStore(diskPath, cwd)) {
    throw new Error(
      `[tests] refusing to remove ${JSON.stringify(diskPath)}: it is not under ${repositoryRoot(cwd)}. `
      + 'An empty or relative disk path usually means setup failed before it assigned one.',
    )
  }

  rmSync(diskPath, { recursive: true, force: true })
}

/**
 * Remove the owner directory a repository sat in, if the last one has gone.
 *
 * Tests share `storage/repos/<owner>` only by accident - each makes a unique
 * handle - but an owner directory that still holds something belongs to another
 * test, and removing it would break a suite running beside this one.
 */
export function removeRepositoryOwnerDirectory(diskPath: string, cwd = process.cwd()): void {
  if (!insideRepositoryStore(diskPath, cwd)) {
    throw new Error(
      `[tests] refusing to remove the parent of ${JSON.stringify(diskPath)}: it is not under ${repositoryRoot(cwd)}. `
      + 'An empty disk path resolves to the parent of the working directory, which is how this rule came to exist.',
    )
  }

  const owner = resolve(diskPath, '..')

  if (!insideRepositoryStore(owner, cwd) || !existsSync(owner))
    return

  try {
    if (readdirSync(owner).length === 0)
      rmdirSync(owner)
  }
  catch {
    // Another test's teardown got there first, or the directory is not empty.
    // Either way there is nothing here worth failing a suite over.
  }
}

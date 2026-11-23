/**
 * Which of two runs' commits is newer, by history rather than by arrival.
 *
 * A concurrency group replaces a waiting run when "a newer commit arrived",
 * and it used to decide that by run id: whichever run was created last was
 * the newer commit. That holds for pushes to one branch and for nothing else.
 * A schedule, a manual dispatch or a re-delivered event can create a run on a
 * commit the branch has long since moved past - zig-anti-virus's scheduled run
 * #18 on a stale commit cancelled push run #16 on the branch head, with the
 * reason "a newer commit arrived". The commit that arrived was older.
 *
 * So the question is asked of git: `merge-base --is-ancestor`, on the
 * repository's own bare copy, which is fast and needs nothing fetched.
 */

import { servablePathFor } from '../Git/access'
import { runGit } from '../Git/git'

/**
 * Where commit `a` stands relative to commit `b`.
 *
 * - `same`: the same commit.
 * - `older`: `a` is a strict ancestor of `b`, so `b` already contains it.
 * - `newer`: `b` is a strict ancestor of `a`.
 * - `unrelated`: neither contains the other (a rewritten branch, say).
 * - `incomparable`: one of them is not a commit id at all, so history has
 *   nothing to say and the caller keeps its old rule.
 * - `unknown`: git could not answer (a missing object, a repository that is
 *   not on this node). Callers keep the rule they had before history was
 *   consulted.
 */
export type CommitOrder = 'same' | 'older' | 'newer' | 'unrelated' | 'incomparable' | 'unknown'

const COMMIT = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i

export async function compareCommits(gitDir: string | null, a: unknown, b: unknown): Promise<CommitOrder> {
  const left = String(a ?? '').trim()
  const right = String(b ?? '').trim()

  if (!COMMIT.test(left) || !COMMIT.test(right))
    return 'incomparable'

  if (left.toLowerCase() === right.toLowerCase())
    return 'same'

  if (!gitDir)
    return 'unknown'

  const forward = await isAncestor(gitDir, left, right)
  if (forward === null)
    return 'unknown'
  if (forward)
    return 'older'

  const back = await isAncestor(gitDir, right, left)
  if (back === null)
    return 'unknown'

  return back ? 'newer' : 'unrelated'
}

/** git's answer: 0 is yes, 1 is no, anything else is not an answer. */
async function isAncestor(gitDir: string, ancestor: string, descendant: string): Promise<boolean | null> {
  const result = await runGit(gitDir, ['merge-base', '--is-ancestor', ancestor, descendant], { timeoutMs: 10_000 })

  return result.code === 0 ? true : result.code === 1 ? false : null
}

/** Anything with the query builder's `selectFrom`: the global handle or a transaction's. */
interface Reader {
  selectFrom: (table: any) => any
}

/**
 * A repository's bare copy, read through `client` so a caller inside a
 * transaction asks on the transaction's own connection. Null when it is not
 * on this node, which makes every comparison `unknown`.
 */
export async function gitDirOf(client: Reader, repositoryId: number): Promise<string | null> {
  const repository: any = await client
    .selectFrom('repositories')
    .select(['name', 'owner_type', 'owner_id'])
    .where('id', '=', repositoryId)
    .executeTakeFirst()

  if (!repository)
    return null

  const table = String(repository.owner_type) === 'organization' ? 'organizations' : 'users'
  const owner: any = await client
    .selectFrom(table)
    .select(['handle'])
    .where('id', '=', Number(repository.owner_id))
    .executeTakeFirst()

  return owner?.handle ? await servablePathFor(String(owner.handle), String(repository.name)) : null
}

/** One lookup per caller, made only when a comparison actually needs git. */
export function lazyGitDir(client: Reader, repositoryId: number): () => Promise<string | null> {
  let found: Promise<string | null> | null = null

  return () => (found ??= gitDirOf(client, repositoryId).catch(() => null))
}

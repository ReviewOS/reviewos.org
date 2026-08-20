/**
 * The page an instance shows for one of its own owners, written once.
 *
 * A profile page is `{owner}/.profile` with a `README.md` in it - see
 * `app/Actions/Profile/read.ts` - and until somebody creates that repository
 * the page renders as an owner who never wrote one. On the instance this
 * project runs, that owner is the project itself, and "somebody has to remember
 * to push a README" is the same failure the mirrors had: a step that lives in
 * whoever last ran it.
 *
 * So the content is a file in this repository and the deploy writes it.
 *
 * **Only into a repository with no commits in it.** This runs on every deploy,
 * and a step that rewrote the page each time would silently undo an edit
 * somebody made through the interface - the worst kind of automation, the kind
 * that quietly wins an argument nobody knew they were having. Once there is a
 * ref, this does nothing forever.
 *
 * Written with plumbing rather than a checkout and a push: the repository is
 * bare and sitting on the same disk, so a blob, a tree, a commit and a ref is
 * the whole job, and there is no clone, no worktree and no credential.
 */

import { db } from '@stacksjs/database'
import { initBare, runGit } from '../Git/git'
import { repositoryPath } from '../Git/storage'

/** What the seed did, in the words the command prints. */
export type SeedOutcome =
  | { done: 'seeded', repository: string, commit: string }
  | { done: 'already-written', repository: string }
  | { done: 'no-owner', repository: string }
  | { done: 'failed', repository: string, reason: string }

export interface SeedRequest {
  /** The organization or user whose page this is. */
  owner: string
  /** The markdown, as it will be committed. */
  content: string
  /** The repository name. `.profile` is the one the reader asks for first. */
  name?: string
  message?: string
}

export async function seedProfile(request: SeedRequest): Promise<SeedOutcome> {
  const owner = String(request.owner ?? '').trim().toLowerCase()
  const name = String(request.name ?? '.profile').trim()
  const label = `${owner}/${name}`

  if (!owner || !request.content?.trim())
    return { done: 'failed', repository: label, reason: 'an owner and some content are both required' }

  const resolved = await resolveOwner(owner)

  // Not an error. A declaration naming an owner this instance does not have is
  // one line of configuration being early, and this runs before the process
  // starts - see the note in `app/Actions/Mirror/declare.ts`.
  if (!resolved)
    return { done: 'no-owner', repository: label }

  const path = repositoryPath(owner, name)

  if (!path.ok || !path.path)
    return { done: 'failed', repository: label, reason: 'that name does not resolve to a safe path' }

  const diskPath = path.path
  const existing = await Bun.file(`${diskPath}/HEAD`).exists()

  if (!existing) {
    const created = await initBare(diskPath)

    if (!created.ok)
      return { done: 'failed', repository: label, reason: created.stderr || 'git init --bare failed' }
  }

  const repositoryId = await upsertRepository(resolved, name, diskPath)

  if (!repositoryId)
    return { done: 'failed', repository: label, reason: 'the repository row could not be written' }

  // Anything at all in `refs/` means somebody - a push, a mirror, an earlier
  // run of this - has already said what belongs here.
  const refs = await runGit(diskPath, ['show-ref', '--head'])

  if (refs.ok && refs.stdout.trim())
    return { done: 'already-written', repository: label }

  const commit = await writeInitialCommit(diskPath, request.content, request.message ?? 'the page this owner shows')

  if (!commit.ok)
    return { done: 'failed', repository: label, reason: commit.reason }

  /*
   * `pushed_at`, because nothing pushed. The profile page reads the file off
   * disk either way, but every list that orders repositories by when they last
   * moved reads this column, and a repository that has content and no date
   * sorts as though it were the oldest thing on the instance.
   */
  await db
    .updateTable('repositories')
    .set({ pushed_at: new Date().toISOString() })
    .where('id', '=', repositoryId)
    .execute()
    .catch(() => undefined)

  return { done: 'seeded', repository: label, commit: commit.sha }
}

/**
 * A blob, a tree, a commit and a ref.
 *
 * The four plumbing calls a first commit actually is. `commit-tree` takes the
 * identity from the environment rather than from `git config`, so a bare
 * repository nobody has configured still produces a commit with an author on
 * it instead of failing on `unable to auto-detect email address`.
 */
/**
 * Exported under a name that says what it is for: the plumbing is the half of
 * this file that can be wrong in a way nothing notices, so it is tested
 * against real git rather than through the database.
 */
export const writeInitialCommitForTest = writeInitialCommit

async function writeInitialCommit(
  diskPath: string,
  content: string,
  message: string,
): Promise<{ ok: true, sha: string } | { ok: false, reason: string }> {
  const blob = await runGit(diskPath, ['hash-object', '-w', '--stdin'], { input: content })

  if (!blob.ok)
    return { ok: false, reason: blob.stderr || 'could not write the blob' }

  const tree = await runGit(diskPath, ['mktree'], { input: `100644 blob ${blob.stdout.trim()}\tREADME.md\n` })

  if (!tree.ok)
    return { ok: false, reason: tree.stderr || 'could not write the tree' }

  const identity = {
    GIT_AUTHOR_NAME: 'ReviewOS',
    GIT_AUTHOR_EMAIL: 'noreply@reviewos.org',
    GIT_COMMITTER_NAME: 'ReviewOS',
    GIT_COMMITTER_EMAIL: 'noreply@reviewos.org',
  }

  const commit = await runGit(diskPath, ['commit-tree', tree.stdout.trim(), '-m', message], { env: identity })

  if (!commit.ok)
    return { ok: false, reason: commit.stderr || 'could not write the commit' }

  const sha = commit.stdout.trim()

  // The branch `HEAD` already points at, so the repository's default branch is
  // whatever `init --bare` was told rather than a second opinion about it.
  const head = await runGit(diskPath, ['symbolic-ref', 'HEAD'])
  const branch = head.ok && head.stdout.trim() ? head.stdout.trim() : 'refs/heads/main'
  const updated = await runGit(diskPath, ['update-ref', branch, sha])

  if (!updated.ok)
    return { ok: false, reason: updated.stderr || `could not point ${branch} at the commit` }

  return { ok: true, sha }
}

interface ResolvedOwner { id: number, type: 'organization' | 'user' }

async function resolveOwner(handle: string): Promise<ResolvedOwner | null> {
  const org = await db.selectFrom('organizations').select(['id']).where('handle', '=', handle).executeTakeFirst().catch(() => undefined)

  if (org)
    return { id: Number(org.id), type: 'organization' }

  const user = await db.selectFrom('users').select(['id']).where('handle', '=', handle).executeTakeFirst().catch(() => undefined)

  return user ? { id: Number(user.id), type: 'user' } : null
}

async function upsertRepository(owner: ResolvedOwner, name: string, diskPath: string): Promise<number | null> {
  const existing = await db
    .selectFrom('repositories')
    .select(['id'])
    .where('owner_type', '=', owner.type)
    .where('owner_id', '=', owner.id)
    .where('name', '=', name)
    .executeTakeFirst()
    .catch(() => undefined)

  if (existing)
    return Number(existing.id)

  const inserted = await db
    .insertInto('repositories')
    .values({
      owner_type: owner.type,
      owner_id: owner.id,
      name,
      // A profile page is the one repository that has to be readable by
      // everybody: it is what the owner's page renders for a stranger.
      visibility: 'public',
      default_branch: 'main',
      disk_path: diskPath,
      description: 'This owner\'s profile page',
    })
    .returning(['id'])
    .executeTakeFirst()
    .catch(() => undefined)

  return inserted ? Number(inserted.id) : null
}

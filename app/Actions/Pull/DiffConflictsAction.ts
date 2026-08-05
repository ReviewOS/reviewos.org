import { Action } from '@stacksjs/actions'
import { runGit } from '../Git/git'
import { authorizeRepository } from '../Repo/authorize'
import { renderConflictFile } from './conflictRows'
import { parseConflicts } from './conflicts'
import { checkMergeability } from './mergeability'

/** How many conflicting files are rendered before the rest are only counted. */
const MAX_CONFLICT_FILES = 50

/**
 * The files that conflict, with both versions in them.
 *
 * `git merge-tree --write-tree` already writes the merged tree into the object
 * database, conflict markers and all, and `checkMergeability` already reads
 * which paths conflicted out of it. So the conflicted content is *already in
 * the repository*: this reads it back with `cat-file` rather than checking
 * anything out, and no working tree is created at any point.
 *
 * That is the whole reason this is cheap enough to serve on a page load. A
 * forge that resolves conflicts by checking out a branch pays for a worktree
 * per request and cannot do it under load.
 */
export default new Action({
  name: 'DiffConflicts',
  description: 'The conflicting files of a pull request, with both sides',
  method: 'GET',

  async handle(request: any) {
    const auth = await authorizeRepository(request, 'repository:read')
    if (!auth.ok)
      return response.json({ error: auth.error }, auth.status)

    const { repository } = auth.context
    const number = Number(request.get('number'))

    const pullRequest = await db
      .selectFrom('pull_requests')
      .select(['id', 'base_sha', 'head_sha'])
      .where('repository_id', '=', repository.id)
      .where('number', '=', number)
      .executeTakeFirst()

    if (!pullRequest)
      return response.json({ error: 'No such pull request' }, 404)

    const baseSha = String(pullRequest.base_sha ?? '')
    const headSha = String(pullRequest.head_sha ?? '')
    if (!baseSha || !headSha)
      return response.json({ state: 'unknown', files: [] })

    const diskPath = String(repository.disk_path ?? '')
    const mergeability = await checkMergeability(diskPath, baseSha, headSha)

    if (mergeability.state !== 'conflicted' || mergeability.treeSha == null)
      return response.json({ state: mergeability.state, files: [] })

    // Bounded, because a merge can conflict in every file of a repository and
    // nobody resolves four thousand of them in a browser. The count is
    // reported so the page can say what it is not showing rather than quietly
    // showing part of the answer.
    const paths = mergeability.conflictingPaths.slice(0, MAX_CONFLICT_FILES)
    const files = []

    for (const path of paths) {
      const blob = await runGit(diskPath, ['cat-file', 'blob', `${mergeability.treeSha}:${path}`])
      if (!blob.ok)
        continue

      const regions = parseConflicts(blob.stdout)

      files.push({
        path,
        conflicts: regions.filter(region => region.type === 'conflict').length,
        html: renderConflictFile(path, regions, { resolvable: false }),
      })
    }

    return response.json({
      state: mergeability.state,
      total: mergeability.conflictingPaths.length,
      files,
    })
  },
})

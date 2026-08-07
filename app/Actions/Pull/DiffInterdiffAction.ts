import { Action } from '@stacksjs/actions'
import { diskPathFor } from '../Git/access'
import { authorizeRepository } from '../Repo/authorize'
import { isSafeRevision } from '../Git/git'
import { lastSeenHead } from './incremental'
import { interdiffFor } from './interdiff'
import { pullRequestFor } from './reviewState'
import { parseDiffFile } from './diff'
import { renderDiffRows } from './rows'

/**
 * What changed in one file since the reader last looked, at line level.
 *
 * Since-last-look names the files; this answers for one of them - the diff of
 * the two patches, rendered by the row renderer every diff already uses. The
 * outer +/- is what this round changed; the inner patch's own markers ride as
 * the first character of each line, which is `git range-diff`'s presentation
 * without its commit-pairing wrongness.
 *
 * Rendered with no tokens - syntax-highlighting patch text as the file's
 * language would be wrong - and no anchors, because these numbers are
 * positions in a patch, not lines of the file, and an anchor would be a link
 * to the wrong place and a dead comment target.
 */
export default new Action({
  name: 'DiffInterdiff',
  description: 'The diff between two versions of one file’s proposal',
  method: 'GET',

  async handle(request: any) {
    const auth = await authorizeRepository(request, 'repository:read')
    if (!auth.ok)
      return response.json({ error: auth.error }, auth.status)

    const { repository, user } = auth.context
    const owner = String(request.get('owner') ?? '').trim().toLowerCase()

    const pullRequest = await pullRequestFor(repository.id, Number(request.get('number')))
    if (!pullRequest)
      return response.json({ error: 'No such pull request' }, 404)

    const diskPath = diskPathFor(owner, repository.name)
    if (!diskPath)
      return response.json({ error: 'Repository not found' }, 404)

    const path = String(request.get('path') ?? '').trim()
    if (!path)
      return response.json({ error: 'A path is required' }, 422)

    // An explicit `since` wins; otherwise where this reader got to, exactly
    // as the file list computed it, so the two cannot disagree about what
    // "since" means.
    const asked = String(request.get('since') ?? '').trim()
    if (asked && !isSafeRevision(asked))
      return response.json({ error: 'That revision cannot be used' }, 422)

    const since = asked || (user ? await lastSeenHead(Number(pullRequest.id), Number(user.id)) : null)
    if (!since)
      return response.json({ error: 'Nothing recorded to compare against' }, 409)

    const row: any = await db
      .selectFrom('pull_requests')
      .select(['base_sha', 'head_sha'])
      .where('id', '=', Number(pullRequest.id))
      .executeTakeFirst()

    const answer = await interdiffFor({
      diskPath,
      base: String(row?.base_sha ?? ''),
      path,
      lastSeen: since,
      head: String(row?.head_sha ?? ''),
    })

    if (!answer.ok)
      return response.json({ error: answer.error }, 422)

    if (answer.unchanged)
      return response.json({ unchanged: true, html: '' })

    const file = parseDiffFile(answer.patch)
    if (!file)
      return response.json({ error: 'The comparison produced nothing readable' }, 422)

    const html = renderDiffRows(file, { layout: 'unified', anchors: false })

    return response.json({
      unchanged: false,
      html: `<table class="diff-table" data-columns="3"><tbody>${html}</tbody></table>`,
    })
  },
})

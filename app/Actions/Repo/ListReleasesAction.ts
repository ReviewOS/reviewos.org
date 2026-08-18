import { Action } from '@stacksjs/actions'
import { browseContext } from '../Browse/context'
import { isDraft, latestRelease, sortReleases } from './releases'

/**
 * A repository's releases, newest version first.
 *
 * Ordered by version rather than by publication date. Sorting by date is the
 * obvious implementation and is wrong in the case that matters: a patch
 * backported to an old branch and published today would sit at the top of the
 * list and be what the download button offers.
 *
 * Drafts are visible only to somebody who could have written them. A draft is
 * release notes being prepared, and the whole reason to have drafts is that a
 * half-written changelog on a public page is worse than no page.
 */
export default new Action({
  name: 'ListReleases',
  description: 'List a repository releases',
  method: 'GET',

  async handle(request: RequestInstance) {
    const browse = await browseContext(request)
    if (!browse.ok)
      return response.json({ error: browse.error }, browse.status)

    const { repository, viewerId } = browse.context

    const rows = await db
      .selectFrom('releases')
      .selectAll()
      .where('repository_id', '=', Number(repository.id))
      .execute()

    // Read access is not enough to see a draft, and browseContext has already
    // established that the caller can read. Asked separately rather than
    // folded into the query so the rule is legible.
    const maySeeDrafts = viewerId !== null && await canWrite(Number(repository.id), viewerId)
    const visible = maySeeDrafts ? rows : rows.filter(row => !isDraft(row))

    const releases = sortReleases(visible).map(release => ({
      id: Number(release.id),
      tag_name: release.tag_name,
      name: release.name || release.tag_name,
      // `notes` on the row, `body` in the response: the column is shared with
      // the framework's library releases, and the API word for a release's
      // text is the one the rest of this API uses for an issue or a comment.
      body: release.notes ?? '',
      target_sha: release.target_sha ?? null,
      status: release.status,
      is_draft: isDraft(release),
      is_prerelease: Boolean(release.is_prerelease),
      published_at: release.published_at ?? null,
    }))

    return response.json({
      releases,
      // Named rather than left to the caller to work out, because "the latest
      // release" is the one thing every install script asks for and the one
      // most likely to be got wrong by taking the first entry of a list.
      latest: latestRelease(releases)?.tag_name ?? null,
    })
  },
})

/**
 * Whether somebody may write to this repository, which is what seeing a draft
 * requires.
 *
 * A direct collaborator grant above read, or an organization role that carries
 * one. Deliberately narrow: this decides who sees unfinished announcements, and
 * the cost of getting it wrong is somebody's half-written changelog in public.
 */
async function canWrite(repositoryId: number, userId: number): Promise<boolean> {
  const collaborator = await db
    .selectFrom('repo_collaborators')
    .select(['permission'])
    .where('repository_id', '=', repositoryId)
    .where('user_id', '=', userId)
    .executeTakeFirst()

  if (collaborator && ['write', 'maintain', 'admin'].includes(String(collaborator.permission)))
    return true

  const repository = await db
    .selectFrom('repositories')
    .select(['owner_type', 'owner_id'])
    .where('id', '=', repositoryId)
    .executeTakeFirst()

  if (!repository)
    return false

  if (repository.owner_type === 'user')
    return Number(repository.owner_id) === userId

  const membership = await db
    .selectFrom('org_members')
    .select(['role'])
    .where('organization_id', '=', Number(repository.owner_id))
    .where('user_id', '=', userId)
    .executeTakeFirst()

  return membership ? ['admin', 'owner'].includes(String(membership.role)) : false
}

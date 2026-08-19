import { Action } from '@stacksjs/actions'
import { mkdir, rename } from 'node:fs/promises'
import { dirname } from 'node:path'
import { auditEvent } from '../../Audit/events'
import { auditFrom } from '../Git/audit'
import { runGit } from '../Git/git'
import { repositoryPath } from '../Git/storage'
import { authorizeRepository } from './authorize'
import { allowedWhileArchived, decideSettings } from './settings'

/**
 * Change a repository's settings.
 *
 * One endpoint for all of them, because they share the rule that matters: a
 * rename moves a directory, and the row and the directory have to end up
 * agreeing. Splitting rename into its own endpoint would mean two places that
 * both have to get that right.
 *
 * **The disk move happens before the row is written.** If the move fails the
 * row is untouched and the repository still works under its old name, which is
 * a repository that is fine. The other order gives a row pointing at a
 * directory that is not there, which is a repository nobody can clone and
 * nobody can find to fix.
 */
export default new Action({
  name: 'UpdateSettings',
  description: 'Rename, describe, or change the visibility of a repository',
  method: 'PUT',

  async handle(request: RequestInstance) {
    const auth = await authorizeRepository(request, 'repository:settings')
    if (!auth.ok)
      return response.json({ error: auth.error }, auth.status)

    const { repository, user } = auth.context
    const owner = String(request.get('owner') ?? '').trim().toLowerCase()

    const decision = decideSettings(repository as any, {
      name: request.get('name'),
      description: request.get('description'),
      homepage: request.get('homepage'),
      visibility: request.get('visibility'),
      default_branch: request.get('default_branch'),
      is_archived: readFlag(request.get('is_archived')),
      is_template: readFlag(request.get('is_template')),
      allow_merge_commit: readFlag(request.get('allow_merge_commit')),
      allow_squash_merge: readFlag(request.get('allow_squash_merge')),
      allow_rebase_merge: readFlag(request.get('allow_rebase_merge')),
      delete_branch_on_merge: readFlag(request.get('delete_branch_on_merge')),
      default_merge_strategy: request.get('default_merge_strategy'),
    })

    if (!decision.ok)
      return response.json({ error: decision.error }, decision.status)

    // Frozen is frozen, except for the change that unfreezes it - otherwise
    // archiving would be irreversible, which is not what anybody means by it.
    if (repository.is_archived && !allowedWhileArchived(decision.changes))
      return response.json({ error: 'This repository is archived. Unarchive it first.' }, 409)

    const changes = { ...decision.changes }

    if (decision.renamedFrom) {
      const to = repositoryPath(owner, String(changes.name))
      const from = repositoryPath(owner, decision.renamedFrom)

      if (!to.ok || !from.ok)
        return response.json({ error: 'That repository name cannot be used' }, 422)

      const clash = await db
        .selectFrom('repositories')
        .select(['id'])
        .where('owner_type', '=', repository.owner_type)
        .where('owner_id', '=', repository.owner_id)
        .where('name', '=', String(changes.name))
        .executeTakeFirst()

      if (clash)
        return response.json({ error: 'A repository with that name already exists' }, 409)

      try {
        await mkdir(dirname(to.path!), { recursive: true })
        await rename(from.path!, to.path!)
      }
      catch (error) {
        return response.json({ error: `Could not rename the repository: ${error}` }, 500)
      }

      changes.disk_path = to.relative
    }

    // The default branch has to exist, or every clone checks out nothing and
    // the repository page shows an empty tree. Set on HEAD as well as on the
    // row, because HEAD is what a clone reads.
    if (changes.default_branch) {
      const path = repositoryPath(owner, String(changes.name ?? repository.name))
      const branch = String(changes.default_branch)

      if (path.ok) {
        const exists = await runGit(path.path!, ['rev-parse', '--verify', `refs/heads/${branch}`])
        if (!exists.ok)
          return response.json({ error: `This repository has no branch called ${branch}` }, 422)

        await runGit(path.path!, ['symbolic-ref', 'HEAD', `refs/heads/${branch}`])
      }
    }

    await db.updateTable('repositories').set(changes).where('id', '=', Number(repository.id)).execute()

    /*
     * Visibility, and only visibility, out of everything this endpoint can
     * change.
     *
     * A rename or a description is a product change with a history somebody can
     * see; going public is a disclosure. Every private repository in an
     * organization was private on somebody's understanding, and the question
     * afterwards is always when it stopped being and who decided - which is not
     * a question the repositories table can answer, since it holds only the
     * state it is in now.
     *
     * Recording the whole settings payload instead would bury that one line
     * under a stream of merge-strategy toggles, and a log people scroll past is
     * a log nobody reads.
     */
    if (changes.visibility && changes.visibility !== repository.visibility) {
      await auditEvent('repository:visibility-changed', {
        subject: { type: 'repository', id: Number(repository.id) },
        actorId: user?.id ?? null,
        ...await auditFrom(request),
        repositoryId: Number(repository.id),
        organizationId: String(repository.owner_type) === 'organization' ? Number(repository.owner_id) : null,
        detail: { from: String(repository.visibility ?? ''), to: String(changes.visibility), name: repository.name },
      })
    }

    return response.json({ id: Number(repository.id), ...changes })
  },
})

/**
 * A checkbox, as a form sends it.
 *
 * Absent means "leave it alone", which is not the same as false - and an HTML
 * checkbox sends nothing at all when it is unticked, so the caller has to say
 * which it means with a hidden field. Anything unrecognised is absent.
 */
function readFlag(value: unknown): boolean | undefined {
  if (value === undefined || value === null || value === '')
    return undefined

  const text = String(value).toLowerCase()

  if (text === 'true' || text === '1' || text === 'on' || text === 'yes')
    return true

  if (text === 'false' || text === '0' || text === 'off' || text === 'no')
    return false

  return undefined
}

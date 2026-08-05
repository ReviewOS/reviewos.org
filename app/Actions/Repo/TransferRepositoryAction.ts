import { Action } from '@stacksjs/actions'
import { mkdir, rename } from 'node:fs/promises'
import { dirname } from 'node:path'
import { canInOrganization } from '../../Permissions'
import { recordAudit } from '../Git/audit'
import { repositoryPath } from '../Git/storage'
import { organizationRoleOf, resolveOwner } from '../Identity/lookup'
import { authorizeRepository } from './authorize'
import { decideTransfer } from './settings'

/**
 * Move a repository to a new owner.
 *
 * Two permissions, not one. Admin on the repository is the right to give it
 * away; the right to *receive* it belongs to the target, so somebody who
 * administers a repository cannot use a transfer to plant it in an organization
 * they are not a member of.
 *
 * Collaborator grants do not travel. They were made by the old owner, against
 * an owner structure the repository is leaving, and carrying them across would
 * mean a transfer silently hands access to people the new owner never chose.
 * The new owner's own structure applies from the moment the row moves, and
 * anybody who should keep access is re-added deliberately.
 */
export default new Action({
  name: 'TransferRepository',
  description: 'Move a repository to a new owner',
  method: 'POST',

  async handle(request: any) {
    const auth = await authorizeRepository(request, 'repository:transfer')
    if (!auth.ok)
      return response.json({ error: auth.error }, auth.status)

    const { repository, user } = auth.context
    const fromHandle = String(request.get('owner') ?? '').trim().toLowerCase()
    const toHandle = String(request.get('to') ?? request.get('new_owner') ?? '').trim().toLowerCase()

    if (!toHandle)
      return response.json({ error: 'No new owner given' }, 422)

    const target = await resolveOwner(toHandle)
    if (!target)
      return response.json({ error: 'No such owner' }, 404)

    // The receiving side. Into an organization needs membership that may create
    // repositories; onto a person, only that person.
    if (target.kind === 'organization') {
      const role = await organizationRoleOf(target.id, user!.id)
      if (!canInOrganization(role, 'repositories:create'))
        return response.json({ error: `You cannot move a repository into ${target.handle}` }, 403)
    }
    else if (target.id !== user!.id) {
      return response.json({ error: 'A repository can only be transferred to you or to an organization you are in' }, 403)
    }

    const taken = await db
      .selectFrom('repositories')
      .select(['id'])
      .where('owner_type', '=', target.kind)
      .where('owner_id', '=', target.id)
      .where('name', '=', repository.name)
      .executeTakeFirst()

    const decision = decideTransfer(repository as any, target, Boolean(taken))
    if (!decision.ok)
      return response.json({ error: decision.error }, decision.status)

    const to = repositoryPath(target.handle, repository.name)
    const from = repositoryPath(fromHandle, repository.name)

    if (!to.ok || !from.ok)
      return response.json({ error: 'That owner or repository name cannot be used' }, 422)

    // Disk first. A failed move leaves a repository that still works where it
    // was; the other order leaves a row pointing at nothing.
    try {
      await mkdir(dirname(to.path!), { recursive: true })
      await rename(from.path!, to.path!)
    }
    catch (error) {
      return response.json({ error: `Could not move the repository: ${error}` }, 500)
    }

    await db
      .updateTable('repositories')
      .set({
        owner_type: target.kind,
        owner_id: target.id,
        disk_path: to.relative!,
      })
      .where('id', '=', Number(repository.id))
      .execute()

    // The grants the old owner made, dropped on purpose. See the note above.
    await db.deleteFrom('repo_collaborators').where('repository_id', '=', Number(repository.id)).execute()

    await recordAudit({
      action: 'repository.transferred',
      subject: { type: 'repository', id: Number(repository.id) },
      actorId: user?.id ?? null,
      detail: {
        name: repository.name,
        from: { kind: repository.owner_type, id: repository.owner_id, handle: fromHandle },
        to: { kind: target.kind, id: target.id, handle: target.handle },
      },
    })

    return response.json({
      id: Number(repository.id),
      owner: target.handle,
      name: repository.name,
      moved_from: `${fromHandle}/${repository.name}`,
    })
  },
})

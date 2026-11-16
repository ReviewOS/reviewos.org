import { Action } from '@stacksjs/actions'
import { schema } from '@stacksjs/validation'
import { canInOrganization } from '../../Permissions'
import { auditFrom } from '../Git/audit'
import { organizationRoleOf, resolveOwner } from '../Identity/lookup'
import { authorizeRepository } from './authorize'
import { transferRepository } from './transfer'
import { refuse, succeed } from '../Support/forge'

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

  /*
   * Declared here so the generated reference lists them and the validator
   * enforces them from the same object. `owner` plus one of `repo` or
   * `repository` is how every repository-scoped endpoint is addressed - see
   * `authorizeRepository` - and a caller that forgets one should be told that
   * rather than shown a 404 that reads as "no such repository".
   */
  validations: {
    owner: { rule: schema.string().required() },
    repo: { rule: schema.string() },
    repository: { rule: schema.string() },
    to: { rule: schema.string() },
    new_owner: { rule: schema.string() },
  },

  responses: {
    200: { description: 'Transferred. The repository is now under the new owner, and its old path redirects.' },
    401: { description: 'Unauthenticated.' },
    403: { description: 'Not yours to transfer, or not somewhere you may transfer it to.' },
    404: { description: 'No such repository, or none this caller may see. A private repository answers this rather than 403, because a 403 confirms it exists.' },
  },

  async handle(request: RequestInstance) {
    const auth = await authorizeRepository(request, 'repository:transfer')
    if (!auth.ok)
      return refuse(request, auth.error, auth.status)

    const { repository, user } = auth.context
    const toHandle = String(request.get('to') ?? request.get('new_owner') ?? '').trim().toLowerCase()

    if (!toHandle)
      return refuse(request, 'No new owner given', 422)

    const target = await resolveOwner(toHandle)
    if (!target)
      return refuse(request, 'No such owner', 404)

    // The receiving side. Into an organization needs membership that may create
    // repositories; onto a person, only that person.
    if (target.kind === 'organization') {
      const role = await organizationRoleOf(target.id, user!.id)
      if (!canInOrganization(role, 'repositories:create'))
        return refuse(request, `You cannot move a repository into ${target.handle}`, 403)
    }
    else if (target.id !== user!.id) {
      return refuse(request, 'A repository can only be transferred to you or to an organization you are in', 403)
    }

    const result = await transferRepository(Number(repository.id), target, { actorId: user?.id ?? null, ...await auditFrom(request) })
    if (!result.ok)
      return refuse(request, result.error, result.status)

    return succeed(request, { id: result.id, owner: result.owner, name: result.name, moved_from: result.moved_from }, 'Repository transferred')
  },
})

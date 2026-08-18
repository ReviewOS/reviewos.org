import { Action } from '@stacksjs/actions'
import { auditEvent } from '../../Audit/events'
import { REPOSITORY_LEVELS, type RepositoryPermission } from '../../Permissions'
import { auditFrom } from '../Git/audit'
import { normalizeHandle } from '../Identity/handles'
import { authorizeRepository } from './authorize'

/**
 * Give somebody direct access to a repository, change it, or take it away.
 *
 * `repo_collaborators` has been read by the access checks since phase 2 and had
 * no endpoint that wrote to it, so a personal repository could not be shared
 * with anybody at all. The team grant beside this one only covers repositories
 * an organization owns, which leaves out the case a self-hosted instance is
 * mostly made of: one person's repository and one other person who needs to
 * push to it.
 *
 * **`collaborator:manage`**, which like `branch:protect` was declared in
 * `app/Permissions.ts` and `app/TokenScopes.ts` and checked by nothing, for
 * want of the endpoint it describes. It is the *admin* rung rather than
 * maintain, one above the team grant beside it, and the difference is the
 * escalation: this endpoint can hand somebody `admin` in a single request,
 * where reaching the same thing through a team takes a team to exist and
 * somebody to be put in it.
 */
export default new Action({
  name: 'ManageCollaborator',
  description: 'Grant, change, or revoke a person\'s direct access to a repository',
  method: 'POST',

  async handle(request: any) {
    const auth = await authorizeRepository(request, 'collaborator:manage')
    if (!auth.ok)
      return response.json({ error: auth.error }, auth.status)

    const { repository, user } = auth.context
    if (!user)
      return response.json({ error: 'Unauthenticated' }, 401)

    const repositoryId = Number(repository.id)
    const scope = {
      repositoryId,
      organizationId: String(repository.owner_type) === 'organization' ? Number(repository.owner_id) : null,
    }

    const handle = normalizeHandle(String(request.get('handle') ?? ''))
    const person: any = handle
      ? await db.selectFrom('users').select(['id']).where('handle', '=', handle).executeTakeFirst()
      : null

    if (!person)
      return response.json({ error: 'No such user' }, 404)

    const personId = Number(person.id)

    /*
     * The owner is not a collaborator and cannot be made one.
     *
     * A row granting `read` to the person who owns the repository would look
     * like a downgrade on the settings page and change nothing, because
     * ownership is checked first. Refused rather than accepted and ignored:
     * a control that appears to do something and does not is worse than one
     * that says no.
     */
    if (String(repository.owner_type) === 'user' && Number(repository.owner_id) === personId)
      return response.json({ error: 'That is the owner of this repository' }, 422)

    const existing = await db
      .selectFrom('repo_collaborators')
      .select(['id', 'permission'])
      .where('repository_id', '=', repositoryId)
      .where('user_id', '=', personId)
      .executeTakeFirst()

    if (String(request.get('operation') ?? 'grant') === 'revoke') {
      if (!existing)
        return response.json({ error: 'Not a collaborator on this repository' }, 404)

      await db
        .deleteFrom('repo_collaborators')
        .where('repository_id', '=', repositoryId)
        .where('user_id', '=', personId)
        .execute()

      await auditEvent('collaborator:removed', {
        subject: { type: 'user', id: personId },
        actorId: user.id,
        ...await auditFrom(request),
        ...scope,
        detail: { handle, was: String(existing.permission ?? '') },
      })

      return response.json({ revoked: true, handle })
    }

    const permission = String(request.get('permission') ?? 'read') as RepositoryPermission

    if (!(REPOSITORY_LEVELS as readonly string[]).includes(permission))
      return response.json({ error: `A permission is one of ${REPOSITORY_LEVELS.join(', ')}` }, 422)

    // Upserted rather than inserted. Granting twice is the same grant, and two
    // rows with different permissions would make the answer depend on which
    // came back first.
    if (existing) {
      await db
        .updateTable('repo_collaborators')
        .set({ permission })
        .where('id', '=', Number(existing.id))
        .execute()
    }
    else {
      await db
        .insertInto('repo_collaborators')
        .values({ repository_id: repositoryId, user_id: personId, permission })
        .execute()
    }

    // The previous permission as well as the new one. "Was made an admin" and
    // "was already an admin" are different sentences, and only one of them
    // explains what happened next.
    await auditEvent('collaborator:changed', {
      subject: { type: 'user', id: personId },
      actorId: user.id,
      ...await auditFrom(request),
      ...scope,
      detail: { handle, from: existing ? String(existing.permission ?? '') : null, to: permission },
    })

    return response.json({ handle, permission }, existing ? 200 : 201)
  },
})

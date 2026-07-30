import { Action } from '@stacksjs/actions'
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { canInOrganization } from '../../Permissions'
import { currentUser, organizationRoleOf, resolveOwner } from '../Identity/lookup'
import { initBare } from '../Git/git'
import { repositoryPath } from '../Git/storage'

/**
 * Create a repository: the row and the bare repository on disk.
 *
 * The two are one unit. A row with no repository behind it answers every clone
 * with a confusing error, and a repository on disk with no row is invisible and
 * never garbage collected. If the disk step fails the row is removed again.
 */
export default new Action({
  name: 'CreateRepository',
  description: 'Create a repository for a user or an organization',
  method: 'POST',

  async handle(request: any) {
    const user = await currentUser(request)
    if (!user)
      return response.json({ error: 'Unauthenticated' }, 401)

    const name = String(request.get('name') ?? '').trim()
    const ownerHandle = String(request.get('owner') ?? user.handle).trim().toLowerCase()

    const owner = await resolveOwner(ownerHandle)
    if (!owner)
      return response.json({ error: 'No such owner' }, 404)

    // Creating under an organization needs membership; creating under another
    // person is never allowed.
    if (owner.kind === 'organization') {
      const role = await organizationRoleOf(owner.id, user.id)
      if (!canInOrganization(role, 'repositories:create'))
        return response.json({ error: 'Forbidden' }, 403)
    }
    else if (owner.id !== user.id) {
      return response.json({ error: 'Forbidden' }, 403)
    }

    const resolved = repositoryPath(owner.handle, name)
    if (!resolved.ok)
      return response.json({ error: 'That repository name cannot be used' }, 422)

    const clash = await db
      .selectFrom('repositories')
      .select(['id'])
      .where('owner_type', '=', owner.kind)
      .where('owner_id', '=', owner.id)
      .where('name', '=', name)
      .executeTakeFirst()

    if (clash)
      return response.json({ error: 'A repository with that name already exists' }, 409)

    const visibility = String(request.get('visibility') ?? 'public')
    if (!['public', 'private', 'internal'].includes(visibility))
      return response.json({ error: 'Unknown visibility' }, 422)

    const defaultBranch = String(request.get('default_branch') ?? 'main')

    const created = await db
      .insertInto('repositories')
      .values({
        owner_type: owner.kind,
        owner_id: owner.id,
        name,
        description: String(request.get('description') ?? ''),
        visibility,
        default_branch: defaultBranch,
        disk_path: resolved.relative!,
      })
      .returning(['id'])
      .executeTakeFirst()

    const repositoryId = Number(created?.id)

    try {
      await mkdir(dirname(resolved.path!), { recursive: true })
      const init = await initBare(resolved.path!, defaultBranch)
      if (!init.ok)
        throw new Error(init.stderr || 'git init failed')
    }
    catch (error) {
      await db.deleteFrom('repositories').where('id', '=', repositoryId).execute()
      throw error
    }

    return response.json({
      id: repositoryId,
      owner: owner.handle,
      name,
      visibility,
      default_branch: defaultBranch,
      clone_url: `/${owner.handle}/${name}.git`,
    }, 201)
  },
})

import { Action } from '@stacksjs/actions'
import { canInOrganization } from '../../Permissions'
import { currentUser, organizationRoleOf } from '../Identity/lookup'

/** A team's URL segment, on the same rules a handle follows. */
const SLUG = /^[a-z0-9-]+$/

/**
 * Create, rename, or delete a team.
 *
 * One endpoint for the three, because all of them turn on the same question -
 * may this person manage members of this organization - and splitting them is
 * how that check ends up written three times and forgotten once.
 *
 * `members:manage`, not `settings:manage`. A team is how access is handed out,
 * so managing teams is the same authority as managing who is in the
 * organization; requiring the settings rung would mean an admin who can add
 * people cannot put them in a team, which is the same job in two halves.
 *
 * **Deleting a team revokes everything it granted**, through the cascade on
 * `team_repositories`. That is the point of granting through a team rather than
 * per person: it comes back in one action. It is also the reason a delete is
 * worth confirming - it can remove access for people who were never named.
 */
export default new Action({
  name: 'ManageTeam',
  description: 'Create, update, or delete a team',
  method: 'POST',

  async handle(request: RequestInstance) {
    const actor = await currentUser(request)
    if (!actor)
      return response.json({ error: 'Unauthenticated' }, 401)

    const organizationId = Number(request.get('organization_id'))
    if (!Number.isInteger(organizationId) || organizationId <= 0)
      return response.json({ error: 'An organization is required' }, 422)

    const role = await organizationRoleOf(organizationId, actor.id)
    if (!canInOrganization(role, 'members:manage'))
      return response.json({ error: 'Forbidden' }, 403)

    const operation = String(request.get('operation') ?? 'create').trim().toLowerCase()

    if (operation === 'delete') {
      const team = await teamIn(organizationId, Number(request.get('team_id')))
      if (!team)
        return response.json({ error: 'No such team' }, 404)

      /*
       * Children are re-parented, not deleted with it.
       *
       * A cascade would delete a subtree, and with it every grant those teams
       * held - removing access from people nobody in the request named. Lifting
       * them to this team's parent keeps them and narrows what they inherit,
       * which is the conservative direction: they lose the deleted team's
       * grants and keep their own.
       */
      await db
        .updateTable('teams')
        .set({ parent_team_id: team.parent_team_id ?? null })
        .where('parent_team_id', '=', Number(team.id))
        .execute()

      await db.deleteFrom('teams').where('id', '=', Number(team.id)).execute()

      return response.json({ deleted: Number(team.id) })
    }

    if (operation !== 'create' && operation !== 'update')
      return response.json({ error: 'An operation is create, update or delete' }, 422)

    const name = String(request.get('name') ?? '').trim().slice(0, 100)
    const slug = String(request.get('slug') ?? name).trim().toLowerCase().replace(/\s+/g, '-')
    const description = String(request.get('description') ?? '').trim().slice(0, 300)

    if (!name)
      return response.json({ error: 'A team needs a name' }, 422)

    if (!SLUG.test(slug))
      return response.json({ error: 'A slug can contain only letters, numbers and hyphens' }, 422)

    const parentId = request.get('parent_team_id') === undefined || String(request.get('parent_team_id') ?? '') === ''
      ? null
      : Number(request.get('parent_team_id'))

    if (parentId !== null) {
      const parent = await teamIn(organizationId, parentId)

      // A parent in another organization would grant across an organization
      // boundary through inheritance, which is the one thing team scoping
      // exists to prevent.
      if (!parent)
        return response.json({ error: 'No such parent team' }, 422)
    }

    if (operation === 'update') {
      const team = await teamIn(organizationId, Number(request.get('team_id')))
      if (!team)
        return response.json({ error: 'No such team' }, 404)

      if (parentId !== null && await wouldCycle(Number(team.id), parentId))
        return response.json({ error: 'A team cannot be its own ancestor' }, 422)

      const clash = await slugTaken(organizationId, slug, Number(team.id))
      if (clash)
        return response.json({ error: 'A team with that slug already exists' }, 422)

      await db
        .updateTable('teams')
        .set({ name, slug, description, parent_team_id: parentId })
        .where('id', '=', Number(team.id))
        .execute()

      return response.json({ id: Number(team.id), name, slug })
    }

    if (await slugTaken(organizationId, slug, null))
      return response.json({ error: 'A team with that slug already exists' }, 422)

    const created = await db
      .insertInto('teams')
      .values({ organization_id: organizationId, name, slug, description, parent_team_id: parentId })
      .returning(['id'])
      .executeTakeFirst()

    return response.json({ id: Number(created?.id), name, slug }, 201)
  },
})

/** A team, but only if it belongs to this organization. */
async function teamIn(organizationId: number, teamId: number): Promise<any> {
  if (!Number.isInteger(teamId) || teamId <= 0)
    return null

  return db
    .selectFrom('teams')
    .select(['id', 'parent_team_id'])
    .where('id', '=', teamId)
    .where('organization_id', '=', organizationId)
    .executeTakeFirst()
}

/** Whether a slug is already used by a different team here. */
async function slugTaken(organizationId: number, slug: string, exceptId: number | null): Promise<boolean> {
  let query = db
    .selectFrom('teams')
    .select(['id'])
    .where('organization_id', '=', organizationId)
    .where('slug', '=', slug)

  if (exceptId !== null)
    query = query.where('id', '!=', exceptId)

  return Boolean(await query.executeTakeFirst())
}

/**
 * Whether making `parentId` the parent of `teamId` closes a loop.
 *
 * A cycle in the team tree is not a cosmetic problem: resolution walks parents
 * to collect inherited grants, and a loop there is an infinite walk inside a
 * permission check. `resolve.ts` carries a visited set so it survives one, and
 * refusing to create one is the other half - a graph nobody can build is better
 * than a walk that copes.
 */
async function wouldCycle(teamId: number, parentId: number): Promise<boolean> {
  if (teamId === parentId)
    return true

  const seen = new Set<number>([teamId])
  let current: number | null = parentId

  while (current !== null) {
    if (seen.has(current))
      return true

    seen.add(current)

    const row = await db
      .selectFrom('teams')
      .select(['parent_team_id'])
      .where('id', '=', current)
      .executeTakeFirst()

    current = row?.parent_team_id === null || row?.parent_team_id === undefined ? null : Number(row.parent_team_id)
  }

  return false
}

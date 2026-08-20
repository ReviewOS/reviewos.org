import { Action } from '@stacksjs/actions'
import { schema } from '@stacksjs/validation'
import { canInOrganization } from '../../Permissions'
import { currentUser, organizationRoleOf } from '../Identity/lookup'

/**
 * Add somebody to a team, change their role in it, or remove them.
 *
 * **Only a member of the organization can be added.** A team grants access to
 * that organization's repositories, so adding an outsider to one would hand
 * them access without ever making them a member - a side door around the
 * membership list, and one that does not show up on the people page.
 *
 * A team `maintainer` may manage that team's own membership; `members:manage`
 * on the organization covers every team. That is the whole reason team roles
 * exist: an organization admin should not have to be the one adding people to
 * each team, and the person running a team should not need admin over the
 * organization to do it.
 */
export default new Action({
  name: 'ManageTeamMember',
  description: 'Add, change, or remove a team member',
  method: 'POST',

  // Declared so the document can publish them: every key is one the handler
  // reads, and none is required, because this describes the inputs rather than
  // changing what the endpoint accepts.
  validations: {
    operation: { rule: schema.string() },
    role: { rule: schema.string() },
    team_id: { rule: schema.string() },
    user_id: { rule: schema.number() },
  },

  async handle(request: RequestInstance) {
    const actor = await currentUser(request)
    if (!actor)
      return response.json({ error: 'Unauthenticated' }, 401)

    const teamId = Number(request.get('team_id'))
    const team: any = Number.isInteger(teamId) && teamId > 0
      ? await db.selectFrom('teams').select(['id', 'organization_id']).where('id', '=', teamId).executeTakeFirst()
      : null

    if (!team)
      return response.json({ error: 'No such team' }, 404)

    const organizationId = Number(team.organization_id)
    const organizationRole = await organizationRoleOf(organizationId, actor.id)

    // Either authority is enough, and they are genuinely different people in a
    // real organization.
    const mayManageOrganization = canInOrganization(organizationRole, 'members:manage')
    const mayManageTeam = mayManageOrganization || await isMaintainerOf(teamId, actor.id)

    if (!mayManageTeam)
      return response.json({ error: 'Forbidden' }, 403)

    const userId = Number(request.get('user_id'))
    if (!Number.isInteger(userId) || userId <= 0)
      return response.json({ error: 'A user is required' }, 422)

    if (String(request.get('operation') ?? '') === 'remove') {
      await db
        .deleteFrom('team_members')
        .where('team_id', '=', teamId)
        .where('user_id', '=', userId)
        .execute()

      // No 404 for somebody who was not in it. The desired state is "not a
      // member", and it holds either way - and reporting the difference would
      // tell a team maintainer who is in teams they cannot see.
      return response.json({ removed: true })
    }

    const role = String(request.get('role') ?? 'member')
    if (role !== 'member' && role !== 'maintainer')
      return response.json({ error: 'A team role is member or maintainer' }, 422)

    const membership = await db
      .selectFrom('org_members')
      .select(['id'])
      .where('organization_id', '=', organizationId)
      .where('user_id', '=', userId)
      .executeTakeFirst()

    if (!membership)
      return response.json({ error: 'That person is not a member of this organization' }, 422)

    const existing = await db
      .selectFrom('team_members')
      .select(['id'])
      .where('team_id', '=', teamId)
      .where('user_id', '=', userId)
      .executeTakeFirst()

    if (existing) {
      await db
        .updateTable('team_members')
        .set({ role })
        .where('id', '=', Number(existing.id))
        .execute()

      return response.json({ team_id: teamId, user_id: userId, role })
    }

    await db.insertInto('team_members').values({ team_id: teamId, user_id: userId, role }).execute()

    return response.json({ team_id: teamId, user_id: userId, role }, 201)
  },
})

/** Whether somebody runs this team. */
async function isMaintainerOf(teamId: number, userId: number): Promise<boolean> {
  const row = await db
    .selectFrom('team_members')
    .select(['role'])
    .where('team_id', '=', teamId)
    .where('user_id', '=', userId)
    .executeTakeFirst()

  return String(row?.role ?? '') === 'maintainer'
}

import { randomBytes } from 'node:crypto'
import { Action } from '@stacksjs/actions'
import { makeHash } from '@stacksjs/security'
import { canInOrganization } from '../../Permissions'
import { currentUser, handleAvailable, organizationRoleOf } from '../Identity/lookup'
import { normalizeHandle } from '../Identity/handles'

/**
 * Create a machine account: an account that holds tokens and nothing else.
 *
 * **It exists because the alternative happens anyway.** Without one, CI needs a
 * credential and somebody uses their own - which ties the deploy to one
 * person's employment - or the team makes a shared human account and puts the
 * password in a password manager. That second account then has a mailbox, a
 * review vote, and a session anybody who has ever been on the team can still
 * open. A product that does not offer this does not avoid the problem; it just
 * does not get to shape it.
 *
 * A machine account has none of that. It cannot sign in, so there is nothing to
 * share; it belongs to the organization rather than to whoever made it, so it
 * survives their leaving and is revocable by people who are still there.
 *
 * **Not signing in is enforced by the password, not by a flag.** The row gets a
 * hash of 64 random bytes that is generated here, never returned, and never
 * written down. So `Auth.attempt` fails for it the same way it fails for a
 * wrong password, through the code that already exists, rather than through a
 * second branch somebody could forget to add to a new sign-in path. A flag
 * checked in one of three entry points is how these accounts become
 * back doors.
 *
 * The handle goes through the same `handleAvailable` as a person's, because it
 * is the same namespace: a machine account appears at `/{handle}` like anything
 * else, and one called `settings` would make part of the product unreachable.
 */
export default new Action({
  name: 'CreateMachineAccount',
  description: 'Create an organization-owned account that only holds tokens',
  method: 'POST',

  async handle(request: any) {
    const user = await currentUser(request)
    if (!user)
      return response.json({ error: 'Unauthenticated' }, 401)

    const organizationId = Number(request.get('organization_id'))
    if (!Number.isInteger(organizationId) || organizationId <= 0)
      return response.json({ error: 'An organization is required' }, 422)

    const role = await organizationRoleOf(organizationId, user.id)

    // `settings:manage`, which the abilities table puts at owner. A machine
    // account is a standing credential holder in the organization, which is a
    // heavier thing than adding a member - a member can be seen leaving.
    if (!canInOrganization(role, 'settings:manage'))
      return response.json({ error: 'Forbidden' }, 403)

    const organization = await db
      .selectFrom('organizations')
      .select(['id', 'handle'])
      .where('id', '=', organizationId)
      .executeTakeFirst()

    if (!organization)
      return response.json({ error: 'No such organization' }, 404)

    const handle = normalizeHandle(String(request.get('handle') ?? ''))
    const available = await handleAvailable(handle)
    if (!available.ok)
      return response.json({ error: available.message }, 422)

    const name = String(request.get('name') ?? '').trim() || handle

    /*
     * An address that cannot receive mail, on purpose.
     *
     * `users.email` is unique and not null, so the row needs one - and a real
     * address would mean the account could be sent a password reset, which is
     * the one route back into an account that is supposed to have no way in.
     * `.invalid` is reserved by RFC 2606 for exactly this and can never resolve.
     */
    const email = `${handle}@${String(organization.handle)}.machine.invalid`

    const created = await db
      .insertInto('users')
      .values({
        handle,
        name,
        email,
        // Hashed here with the framework's `makeHash`, the same function
        // `Auth.attempt` verifies against, so this is a password that exists and
        // is simply unknown to everybody - rather than a special case in the
        // sign-in path.
        password: await makeHash(randomBytes(64).toString('hex'), { algorithm: 'bcrypt' }),
        machine_for_organization_id: organizationId,
        // Nothing to verify, and marking it verified keeps it out of every
        // "unverified accounts" sweep somebody writes later.
        email_verified_at: new Date().toISOString(),
      })
      .returning(['id'])
      .executeTakeFirst()

    const userId = Number(created?.id)
    if (!userId)
      return response.json({ error: 'Could not create the machine account' }, 500)

    /*
     * A member of the organization, at `member`.
     *
     * It has to be one for its tokens to reach anything - `organizationRoleOf`
     * is what every check goes through - and `member` is the floor, which
     * grants no repository access on its own. Whatever it should reach is
     * granted deliberately, through a team or as a collaborator, like anybody
     * else. A machine that can read everything by existing is the shared
     * account again with a better name.
     */
    await db
      .insertInto('org_members')
      .values({
        organization_id: organizationId,
        user_id: userId,
        role: 'member',
        invited_by_id: user.id,
        // Joined immediately. There is nobody to accept an invitation.
        joined_at: new Date().toISOString(),
      })
      .execute()

    return response.json({
      id: userId,
      handle,
      name,
      organization_id: organizationId,
      // Said out loud in the response, because the next thing the caller does
      // is look for a password to put somewhere.
      note: 'This account cannot sign in. Issue it an access token to give it access.',
    }, 201)
  },
})

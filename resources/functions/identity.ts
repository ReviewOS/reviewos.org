/**
 * Identity, exposed to views.
 *
 * Re-exported one name at a time rather than with `export … from`, which stx
 * cannot parse.
 */

import { viewerFromCookies as viewerFromCookiesImpl } from '../../app/Actions/Identity/lookup'

export const viewerFromCookies = viewerFromCookiesImpl

/**
 * A raw `Cookie` header, parsed into the jar `viewerFromCookies` reads.
 * For pages served without `__stxServeContext`: see the note in
 * `app/Actions/Identity/lookup.ts`.
 */
import { cookieJarFromHeader as cookieJarFromHeaderImpl } from '../../app/Actions/Identity/lookup'

export const cookieJarFromHeader = cookieJarFromHeaderImpl

/**
 * The owners somebody may create a repository under: their own account, then
 * the organizations they belong to. The same rule the create endpoint enforces.
 */
import { ownersForCreate as ownersForCreateImpl } from '../../app/Actions/Identity/lookup'

export const ownersForCreate = ownersForCreateImpl

/**
 * Somebody's role in one organization, or null. Null for a pending invitation
 * too, which is the whole reason it goes through here rather than a query.
 */
import { organizationRoleOf as organizationRoleOfImpl } from '../../app/Actions/Identity/lookup'

export const organizationRoleOf = organizationRoleOfImpl

/** Every organization somebody is in or has been invited to. */
import { organizationsFor as organizationsForImpl } from '../../app/Actions/Org/read'

export const organizationsFor = organizationsForImpl

/** Everybody in one organization, invitations included and marked. */
import { peopleIn as peopleInImpl } from '../../app/Actions/Org/read'

export const peopleIn = peopleInImpl

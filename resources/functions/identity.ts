/**
 * Identity, exposed to views.
 *
 * Re-exported one name at a time rather than with `export … from`, which stx
 * cannot parse.
 */

import { viewerFromCookies as viewerFromCookiesImpl } from '../../app/Actions/Identity/lookup'

export const viewerFromCookies = viewerFromCookiesImpl

/**
 * The owners somebody may create a repository under: their own account, then
 * the organizations they belong to. The same rule the create endpoint enforces.
 */
import { ownersForCreate as ownersForCreateImpl } from '../../app/Actions/Identity/lookup'

export const ownersForCreate = ownersForCreateImpl

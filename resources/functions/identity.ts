/**
 * Identity, exposed to views.
 *
 * Re-exported one name at a time rather than with `export … from`, which stx
 * cannot parse.
 */

import { viewerFromCookies as viewerFromCookiesImpl } from '../../app/Actions/Identity/lookup'

export const viewerFromCookies = viewerFromCookiesImpl

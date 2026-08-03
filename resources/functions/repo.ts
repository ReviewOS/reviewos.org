/**
 * Repository storage, exposed to views.
 *
 * Re-exported one name at a time rather than with `export … from`, which stx
 * cannot parse.
 */

import { repositoryPath as repositoryPathImpl } from '../../app/Actions/Git/storage'

export const repositoryPath = repositoryPathImpl

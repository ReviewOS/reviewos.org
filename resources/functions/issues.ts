/**
 * Issue rules, exposed to views.
 *
 * Re-exported one name at a time rather than with `export … from`, which stx
 * cannot parse.
 */

import { issueStateLabel as issueStateLabelImpl, issueStatePill as issueStatePillImpl } from '../../app/Actions/Issue/state'
import { labelTextColor as labelTextColorImpl } from '../../app/Actions/Issue/labels'

export const issueStateLabel = issueStateLabelImpl
export const issueStatePill = issueStatePillImpl
export const labelTextColor = labelTextColorImpl

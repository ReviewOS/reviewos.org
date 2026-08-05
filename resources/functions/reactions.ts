/**
 * Reactions, exposed to views.
 *
 * Re-exported one name at a time rather than with `export … from`, which stx
 * cannot parse.
 */

import {
  pressed as pressedImpl,
  subjectKey as subjectKeyImpl,
  summarize as summarizeImpl,
  summarizeAll as summarizeAllImpl,
} from '../../app/Actions/Issue/reactions'

export const summarize = summarizeImpl
export const summarizeAll = summarizeAllImpl
export const subjectKey = subjectKeyImpl
export const pressed = pressedImpl

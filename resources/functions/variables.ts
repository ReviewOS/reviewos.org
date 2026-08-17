/**
 * Workflow variables, for the views.
 *
 * A view imports explicitly and on one line; a component imports nothing at
 * all. The settings screen reaches the resolution through here, and it is the
 * same resolution a run uses - two implementations of "narrowest wins" would be
 * two answers to why a value is what it is.
 */

import { resolveVariables as resolveVariablesImpl, settingsFor as settingsForImpl } from '../../app/Actions/Workflow/variables'

/** Every level's settings for one repository. */
export const settingsFor = settingsForImpl

/** Those settings as effective values, each carrying what it overrode. */
export const resolveVariables = resolveVariablesImpl

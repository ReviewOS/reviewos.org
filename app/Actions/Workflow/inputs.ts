/**
 * Checking what somebody typed against what the workflow asked for.
 *
 * `workflow_dispatch` inputs are the one place a person hands values straight
 * to a pipeline, so this is the boundary where "the workflow said choice, and
 * they sent `producton`" has to become a message rather than a run that fails
 * twelve minutes later on a typo.
 *
 * Every value that survives is a string, because that is what a runner
 * receives: Actions passes inputs as environment variables, and a boolean input
 * arrives as `"true"`. Coercing here and stringifying there would be two places
 * to disagree.
 */

import type { WorkflowDispatchInput } from './parse'

export interface InputCheck {
  ok: boolean
  /** The values to run with, defaults filled in. Empty when `ok` is false. */
  values: Record<string, string>
  /** One message per problem, addressed to whoever typed it. */
  errors: string[]
}

/** The strings Actions accepts for a boolean input, and nothing else. */
const TRUE = new Set(['true', '1', 'yes', 'on'])
const FALSE = new Set(['false', '0', 'no', 'off', ''])

/**
 * The values a dispatch should run with, or the reasons it should not run.
 *
 * Unknown inputs are refused rather than dropped. Silently discarding one is
 * how somebody spends an afternoon wondering why `enviroment: production` did
 * nothing - and it is nearly always a typo for a real input rather than
 * something the sender meant.
 */
export function checkInputs(
  declared: readonly WorkflowDispatchInput[],
  supplied: Record<string, unknown>,
): InputCheck {
  const errors: string[] = []
  const values: Record<string, string> = {}
  const known = new Map(declared.map(input => [input.name, input]))

  for (const name of Object.keys(supplied ?? {})) {
    if (!known.has(name))
      errors.push(`this workflow has no input called "${name}"`)
  }

  for (const input of declared) {
    const raw = supplied?.[input.name]
    const given = raw === undefined || raw === null ? null : String(raw)

    /*
     * A default satisfies `required`.
     *
     * Actions works this way and it reads as wrong until you see the file it
     * comes from: `required: true` with a default means "this always has a
     * value", not "the caller must always type one".
     */
    const value = given !== null && given !== '' ? given : input.default

    if ((value === null || value === '') && input.required) {
      errors.push(`"${input.name}" is required`)
      continue
    }

    if (value === null) {
      // Not required, not supplied, no default. Absent rather than empty: a
      // step testing `if: inputs.thing != ''` should see nothing.
      continue
    }

    if (input.type === 'boolean') {
      const normalized = value.trim().toLowerCase()

      if (!TRUE.has(normalized) && !FALSE.has(normalized)) {
        errors.push(`"${input.name}" is a boolean, and "${value}" is not one`)
        continue
      }

      values[input.name] = TRUE.has(normalized) ? 'true' : 'false'
      continue
    }

    if (input.type === 'choice') {
      /*
       * A choice input with no options is the workflow's mistake, not the
       * sender's. Refusing every value would make the workflow undispatchable
       * over a line its author probably meant to fill in; accepting the value
       * runs what they asked for.
       */
      if (input.options.length > 0 && !input.options.includes(value)) {
        errors.push(`"${input.name}" must be one of: ${input.options.join(', ')}`)
        continue
      }
    }

    values[input.name] = value
  }

  return errors.length > 0
    ? { ok: false, values: {}, errors }
    : { ok: true, values, errors: [] }
}

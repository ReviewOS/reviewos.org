/**
 * Reusable workflows: a job that `uses:` another workflow.
 *
 * A calling job has no steps of its own. What runs is the called workflow's
 * jobs, copied into the same run under the caller's name - `deploy / build`,
 * the way Actions names them - so one run still shows everything that happened,
 * which is the property a person reading a failed pipeline needs.
 *
 * **Only workflows registered on this repository can be called, and only the
 * version this instance holds.** A caller resolves against the called
 * workflow's *registered definition*, never against whatever its file says on
 * some other branch. That is the same rule the fork policy applies to a pull
 * request, for the same reason: the tree a run's instructions come from must be
 * one somebody with write access put there.
 */

import { db } from '@stacksjs/database'
import { checkInputs } from './inputs'

export interface CallTarget {
  /** The workflow version whose jobs should be copied in. */
  versionId: number
  /** The path it was found at, for the interface. */
  path: string
}

export interface CallResolution {
  ok: boolean
  target: CallTarget | null
  /** The values the called workflow will see, defaults filled in. */
  inputs: Record<string, string>
  /** Why it cannot be called, in words for the person who wrote the file. */
  error: string | null
}

/**
 * How deep a chain of calls may go.
 *
 * Actions allows four levels. The limit exists for the same reason a stack has
 * one: a workflow calling itself is a run that never stops being created, and
 * the failure without a limit is not a slow pipeline but an instance filling
 * its database. Cycles are caught by the trail as well, so this is the backstop
 * rather than the rule.
 */
export const MAX_CALL_DEPTH = 4

/**
 * Resolve a `uses:` to a workflow version on this repository.
 *
 * Local paths only, for now: `./.github/workflows/build.yml`. A cross-repository
 * call needs a policy about which repositories may be called and a way to read
 * a version this instance may not hold, and answering that badly is worse than
 * refusing it clearly - so it is refused with a reason rather than half done.
 */
export async function resolveCall(
  repositoryId: number,
  uses: string,
  suppliedInputs: Record<string, unknown>,
): Promise<CallResolution> {
  const reference = String(uses ?? '').trim()

  if (!reference)
    return { ok: false, target: null, inputs: {}, error: 'this job has no `uses:`' }

  if (!reference.startsWith('./')) {
    return {
      ok: false,
      target: null,
      inputs: {},
      error: `\`${reference}\` is a workflow in another repository, which this instance does not call yet`,
    }
  }

  const path = reference.slice(2).split('@')[0] ?? ''

  const workflow: any = await db
    .selectFrom('workflows')
    .select(['id', 'path', 'state'])
    .where('repository_id', '=', repositoryId)
    .where('path', '=', path)
    .executeTakeFirst()

  if (!workflow)
    return { ok: false, target: null, inputs: {}, error: `no workflow is registered at \`${path}\`` }

  if (String(workflow.state) !== 'active')
    return { ok: false, target: null, inputs: {}, error: `the workflow at \`${path}\` is ${workflow.state}` }

  const version: any = await db
    .selectFrom('workflow_versions')
    .select(['id', 'reusable', 'call_inputs'])
    .where('workflow_id', '=', Number(workflow.id))
    .orderBy('id', 'desc')
    .limit(1)
    .executeTakeFirst()

  if (!version)
    return { ok: false, target: null, inputs: {}, error: `the workflow at \`${path}\` has no readable version` }

  /*
   * A workflow that did not say `workflow_call` cannot be called, even though
   * its jobs would copy in perfectly well. Calling one would run a pipeline its
   * author never offered as an interface, and the first time that matters is
   * the day somebody's `deploy.yml` is called by a workflow they have not read.
   */
  if (version.reusable !== true)
    return { ok: false, target: null, inputs: {}, error: `the workflow at \`${path}\` does not accept \`workflow_call\`` }

  const declared = parseDeclared(version.call_inputs)
  const checked = checkInputs(declared, suppliedInputs)

  if (!checked.ok) {
    return {
      ok: false,
      target: null,
      inputs: {},
      error: `the inputs passed to \`${path}\` do not match what it declares: ${checked.errors.join('; ')}`,
    }
  }

  return {
    ok: true,
    target: { versionId: Number(version.id), path: String(workflow.path) },
    inputs: checked.values,
    error: null,
  }
}

/** The inputs a called workflow declares, or none when it stored nothing readable. */
function parseDeclared(stored: unknown): any[] {
  const text = String(stored ?? '').trim()

  if (!text)
    return []

  try {
    const parsed = JSON.parse(text)

    return Array.isArray(parsed) ? parsed : []
  }
  catch {
    return []
  }
}

/**
 * What a called workflow may read from the caller's secrets.
 *
 * Recorded, not resolved. `inherit` means "everything the caller had", a
 * mapping means "these, renamed", and both are answers the execution plane
 * needs *after* the fork check - a fork's pull request gets no secrets at all,
 * whatever any `secrets:` line says.
 */
export function secretsPolicy(stored: unknown): { inherit: boolean, named: string[] } {
  const value = typeof stored === 'string' ? tryParse(stored) : stored

  if (typeof value === 'string')
    return { inherit: value.trim().toLowerCase() === 'inherit', named: [] }

  if (value && typeof value === 'object' && !Array.isArray(value))
    return { inherit: false, named: Object.keys(value as Record<string, unknown>) }

  return { inherit: false, named: [] }
}

function tryParse(text: string): unknown {
  const trimmed = text.trim()

  if (!trimmed)
    return null

  try {
    return JSON.parse(trimmed)
  }
  catch {
    // A bare `inherit` was stored as a JSON string; anything else unreadable is
    // no policy at all, which grants nothing.
    return trimmed
  }
}

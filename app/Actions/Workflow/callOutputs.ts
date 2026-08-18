/**
 * What a called workflow hands back, and the `jobs` context that produces it.
 *
 * `on.workflow_call.outputs.<name>.value` is the one place an expression reads
 * the **`jobs`** context - `${{ jobs.build.outputs.version }}` - and it is the
 * called workflow's own view of itself: the jobs it declared, whatever names the
 * caller gave them. That is why the prefix is stripped here rather than left in
 * place: a called workflow cannot know it was called `deploy / build`, and an
 * expression written against `jobs.build` has to keep working when it is.
 *
 * Resolved when the call's barrier is released, because that is the moment every
 * job in it has finished - the same moment Actions resolves them, and the only
 * one at which the values exist.
 */

import { db } from '@stacksjs/database'
import { interpolate } from './expression'

/** A declared output, as the version stored it. */
interface DeclaredOutput {
  name: string
  value: string
}

/** What a job left behind, out of its `outputs` column. */
function outputsOf(stored: unknown): Record<string, string> {
  try {
    const parsed = JSON.parse(String(stored ?? '{}'))

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      return {}

    return Object.fromEntries(Object.entries(parsed).map(([key, value]) => [key, String(value)]))
  }
  catch {
    return {}
  }
}

/**
 * The `jobs` context of one called workflow: `jobs.<id>.outputs.<name>`.
 *
 * Built from the rows of this run whose names carry the call's prefix, with the
 * prefix removed. `result` travels with it, because a called workflow that
 * declares `value: ${{ jobs.build.result }}` is asking a reasonable question.
 */
export function jobsContext(
  rows: ReadonlyArray<Record<string, unknown>>,
  prefix: string,
): Record<string, { outputs: Record<string, string>, result: string }> {
  const context: Record<string, { outputs: Record<string, string>, result: string }> = {}
  const marker = `${prefix}/`

  for (const row of rows) {
    const id = String(row.job_id ?? '')

    if (!id.startsWith(marker))
      continue

    /*
     * Only the called workflow's own jobs, not a workflow it called in turn:
     * `deploy/build` belongs to this one and `deploy/build/inner` does not, and
     * a nested call's jobs are that workflow's `jobs` context rather than this
     * one's.
     */
    const own = id.slice(marker.length)

    if (own.includes('/'))
      continue

    const existing = context[own]
    const outputs = { ...(existing?.outputs ?? {}), ...outputsOf(row.outputs) }

    /*
     * A matrix job is several rows under one name. The outputs merge, last row
     * winning per key, which is Actions' behaviour and worth naming as a
     * limitation rather than a design: two combinations that set the same output
     * to different values leave one answer and no record of the other.
     */
    context[own] = { outputs, result: String(row.state ?? '') }
  }

  return context
}

/** The declared outputs of a called version, or none when it declared any badly. */
function declaredOutputs(stored: unknown): DeclaredOutput[] {
  try {
    const parsed = JSON.parse(String(stored ?? '[]'))

    if (!Array.isArray(parsed))
      return []

    return parsed
      .filter((one): one is { name: string, value?: unknown } =>
        Boolean(one) && typeof (one as { name?: unknown }).name === 'string')
      .map(one => ({ name: String(one.name), value: String(one.value ?? '') }))
  }
  catch {
    return []
  }
}

/**
 * Resolve one call's outputs, for the barrier that represents it.
 *
 * Answers an object to store on the call's row, so the caller reads them the way
 * it reads any other job's: `needs.<call>.outputs.<name>`. Empty when the called
 * workflow declared none, which is most of them.
 */
export async function resolveCallOutputs(input: {
  runId: number
  /** The call job's own name, which is the prefix its jobs carry. */
  prefix: string
  /** The called workflow's version, which declared the outputs. */
  versionId: number
}): Promise<Record<string, string>> {
  const version = await db
    .selectFrom('workflow_versions')
    .select(['call_outputs'])
    .where('id', '=', input.versionId)
    .executeTakeFirst()
    .catch(() => null)

  const declared = declaredOutputs(version?.call_outputs)

  if (declared.length === 0)
    return {}

  const rows = await db
    .selectFrom('workflow_jobs')
    .select(['job_id', 'state', 'outputs'])
    .where('workflow_run_id', '=', input.runId)
    .execute()

  const jobs = jobsContext(rows, input.prefix)
  const resolved: Record<string, string> = {}

  for (const output of declared) {
    /*
     * `interpolate` rather than `evaluateExpression`, because these are written
     * as templates - `v${{ jobs.build.outputs.version }}` is ordinary - and an
     * expression it cannot resolve is left as written rather than becoming an
     * empty string. A caller that reads `${{ ... }}` back knows the value did
     * not arrive; one that reads nothing cannot tell that from an empty answer.
     */
    resolved[output.name] = interpolate(output.value, { jobs })
  }

  return resolved
}

/** The `call` marker a barrier carries, when it represents a workflow call. */
export function callMarkerOf(settings: unknown): { versionId: number, prefix: string } | null {
  try {
    const parsed = typeof settings === 'string' ? JSON.parse(settings) : settings
    const call = (parsed as { call?: { versionId?: unknown, prefix?: unknown } } | null)?.call

    if (!call || !Number(call.versionId) || typeof call.prefix !== 'string')
      return null

    return { versionId: Number(call.versionId), prefix: String(call.prefix) }
  }
  catch {
    return null
  }
}

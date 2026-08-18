/**
 * The policy rows, read at the two moments they are needed.
 *
 * Dispatch can ask about the instance and the owner; the pool is not known
 * until a machine claims the job, because which pool a job runs in is a fact
 * about the runner rather than about the workflow. So the check happens twice,
 * on purpose, and the pool's half is enforced at the claim.
 */

import type { PluginPolicy } from './policy'
import { db } from '@stacksjs/database'

/** One row, in the shape the pure policy functions take. */
function toPolicy(row: any): PluginPolicy {
  return {
    allowlist: lines(row?.allowlist),
    requirePinned: row?.require_pinned === true || row?.require_pinned === 1,
    capabilities: lines(row?.capabilities),
  }
}

/** A newline or comma separated list, however an operator typed it. */
function lines(value: unknown): string[] {
  return String(value ?? '')
    .split(/[\n,]/)
    .map(one => one.trim())
    .filter(one => one.length > 0)
}

/** The instance's policy, and the owner's, in the order they narrow. */
export async function policyLevels(input: { ownerType?: string, ownerId?: number, poolId?: number }): Promise<PluginPolicy[]> {
  const rows: any[] = await db
    .selectFrom('plugin_policies')
    .select(['scope_type', 'scope_id', 'allowlist', 'require_pinned', 'capabilities'])
    .execute()
    .catch(() => [])

  const found: PluginPolicy[] = []

  const instance = rows.find(row => String(row.scope_type) === 'instance')

  if (instance)
    found.push(toPolicy(instance))

  if (input.ownerId && input.ownerType) {
    // `user` and `organization` rather than one `owner`, because the two
    // namespaces share an id space: `owner 3` would be two different subjects
    // depending on which table somebody looked in.
    const owner = rows.find(row => String(row.scope_type) === String(input.ownerType) && Number(row.scope_id) === Number(input.ownerId))

    if (owner)
      found.push(toPolicy(owner))
  }

  if (input.poolId) {
    const pool = rows.find(row => String(row.scope_type) === 'pool' && Number(row.scope_id) === Number(input.poolId))

    if (pool)
      found.push(toPolicy(pool))
  }

  return found
}

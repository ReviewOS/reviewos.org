import { db } from '@stacksjs/database'

/**
 * Variables at four levels, and the answer to "where did this value come
 * from?"
 *
 * Four places can set `REGISTRY`: the instance, the owner, the repository, and
 * the workflow file. That is not complexity for its own sake - an operator sets
 * a proxy once, an organization sets its registry, a repository overrides for
 * one project, and a workflow overrides for one run - but it means a value can
 * be *wrong in a place nobody is looking*, and the afternoon that costs is why
 * the resolution says where every value came from rather than only what it is.
 *
 * **Narrowest wins.** The workflow file beats the repository, which beats the
 * owner, which beats the instance. The rule is the one every configuration
 * system uses and the one people already expect; what they do not expect is
 * being unable to find out which level answered, so that is the part this
 * module is built around.
 *
 * These are **variables, not secrets.** They are readable by anybody who can
 * read the repository, they appear in logs, and they are handed to every job -
 * including one from a fork. Anything that must not be is a secret, and there
 * is no secret store here yet, which the documentation says plainly rather than
 * leaving somebody to guess from the absence.
 */

export type VariableScope = 'instance' | 'owner' | 'repository' | 'workflow'

/** How much a level beats the one below it. Narrowest wins. */
export const PRECEDENCE: Record<VariableScope, number> = {
  instance: 0,
  owner: 1,
  repository: 2,
  workflow: 3,
}

export interface VariableSetting {
  key: string
  value: string
  scope: VariableScope
  /** The owner handle or repository name that set it, for the screen. */
  from: string
}

export interface ResolvedVariable {
  key: string
  value: string
  scope: VariableScope
  from: string
  /**
   * The settings this one beat, widest last.
   *
   * Kept rather than discarded, because "the value is `eu-west-1`" and "the
   * value is `eu-west-1`, and the organization's `us-east-1` is being
   * overridden here" are different sentences, and only the second one ends the
   * conversation about why a deploy went to the wrong region.
   */
  shadowed: VariableSetting[]
}

/**
 * Resolve a set of settings into the values a run sees.
 *
 * Pure, and deliberately takes the settings rather than reading them: the
 * precedence is the part that must be right, and a rule that can only be tested
 * against a database is one nobody tests against the awkward cases.
 */
export function resolveVariables(settings: readonly VariableSetting[]): ResolvedVariable[] {
  const byKey = new Map<string, VariableSetting[]>()

  for (const setting of settings) {
    const key = String(setting.key ?? '').trim()

    if (!key)
      continue

    byKey.set(key, [...(byKey.get(key) ?? []), setting])
  }

  const resolved: ResolvedVariable[] = []

  for (const [key, group] of byKey) {
    const ordered = [...group].sort((left, right) => PRECEDENCE[right.scope] - PRECEDENCE[left.scope])
    const winner = ordered[0]!

    resolved.push({
      key,
      value: winner.value,
      scope: winner.scope,
      from: winner.from,
      shadowed: ordered.slice(1),
    })
  }

  // By name, because this is read as a list by a person far more often than it
  // is read by a program, and a list that reorders itself between two loads is
  // one nobody can scan.
  return resolved.sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0))
}

/** Every level's settings for one repository, in one query per level. */
export async function settingsFor(repositoryId: number, workflowEnv: Record<string, string> = {}): Promise<VariableSetting[]> {
  const repository = await db
    .selectFrom('repositories')
    .select(['id', 'name', 'owner_type', 'owner_id'])
    .where('id', '=', repositoryId)
    .executeTakeFirst()
    .catch(() => null)

  if (!repository)
    return []

  const rows = await db
    .selectFrom('workflow_variables')
    .select(['scope_type', 'scope_id', 'key', 'value'])
    .execute()
    .catch(() => [])

  const owner: any = String(repository.owner_type) === 'user'
    ? await db.selectFrom('users').select(['handle']).where('id', '=', Number(repository.owner_id)).executeTakeFirst().catch(() => null)
    : await db.selectFrom('organizations').select(['handle']).where('id', '=', Number(repository.owner_id)).executeTakeFirst().catch(() => null)

  const ownerHandle = String(owner?.handle ?? '')
  const settings: VariableSetting[] = []

  for (const row of rows) {
    const scope = String(row.scope_type)

    if (scope === 'instance') {
      settings.push({ key: String(row.key), value: String(row.value ?? ''), scope: 'instance', from: 'this instance' })
      continue
    }

    if (scope === 'owner' && Number(row.scope_id) === Number(repository.owner_id)) {
      settings.push({ key: String(row.key), value: String(row.value ?? ''), scope: 'owner', from: ownerHandle })
      continue
    }

    if (scope === 'repository' && Number(row.scope_id) === repositoryId)
      settings.push({ key: String(row.key), value: String(row.value ?? ''), scope: 'repository', from: String(repository.name) })
  }

  /*
   * The workflow's own `env:`, at the top of the order.
   *
   * It is in the file rather than in a table, and that is exactly why it wins:
   * a value written next to the job it applies to is the most specific
   * statement anybody made about it.
   */
  for (const [key, value] of Object.entries(workflowEnv))
    settings.push({ key, value: String(value ?? ''), scope: 'workflow', from: 'the workflow file' })

  return settings
}

/** What a run sees: the resolved values, flattened for the expression context. */
export async function variablesFor(repositoryId: number, workflowEnv: Record<string, string> = {}): Promise<Record<string, string>> {
  const resolved = resolveVariables(await settingsFor(repositoryId, workflowEnv))

  return Object.fromEntries(resolved.map(one => [one.key, one.value]))
}

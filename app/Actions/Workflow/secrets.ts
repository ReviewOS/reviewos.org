import { db } from '@stacksjs/database'
import { decrypt, encrypt } from '@stacksjs/security'

/**
 * Secrets: encrypted at rest, released to one job at a time, and never read
 * back by a person.
 *
 * The design is three rules, and each of them is a decision somebody could
 * reasonably make differently - so each is written down here rather than
 * spread across the endpoints that enforce it.
 *
 * **Write-only.** There is no endpoint that returns a value. A listing gives
 * names, and the only consumer is a job on a machine an operator provided. A
 * "reveal" button is the feature that turns one compromised session into every
 * credential the organization has, and its absence is worth more than the
 * convenience of not opening a password manager.
 *
 * **A fork's pull request gets none.** That is the fork policy in the threat
 * model and it is checked at the claim, where the trust flag lives, rather than
 * left to the runner. A fork's job runs; it runs with nothing.
 *
 * **An environment's secrets are released only to a job that is deploying to
 * it, after its gate opened.** Build and test jobs in the same run get the
 * repository's secrets and not the environment's, which is the whole reason
 * environment-scoped secrets exist: the deploy credential is the one that must
 * not be reachable from a step somebody added to the test job.
 */

export type SecretScope = 'instance' | 'owner' | 'repository' | 'environment'

/** Narrowest wins, and an environment beats everything - it is the most specific ask. */
export const SECRET_PRECEDENCE: Record<SecretScope, number> = {
  instance: 0,
  owner: 1,
  repository: 2,
  environment: 3,
}

export interface SecretRow {
  key: string
  scope: SecretScope
  scopeId: number
  /** The encrypted value, exactly as stored. */
  sealed: string
}

/** Names only. What a listing may say. */
export interface SecretName {
  key: string
  scope: SecretScope
  updatedAt: string | null
}

/**
 * Which secrets a job may see, by name, before anything is decrypted.
 *
 * Split out and pure because it is the rule that must not be got wrong, and a
 * rule that can only be tested through a database and a claim is one nobody
 * tests against the awkward cases - which here are a fork, and a job that names
 * an environment it has not been approved for.
 */
export function selectSecrets(input: {
  rows: readonly SecretRow[]
  /** False for a fork's pull request. */
  trusted: boolean
  /** The environment this job deploys to, if any. */
  environment: string | null
  /** The environment's id, when the repository has one by that name. */
  environmentId: number | null
  /** Whether the environment's gate has been opened for this job. */
  approved: boolean
  /**
   * The names this job asked for, when it asked.
   *
   * `null` means it named none, and then it gets what it would have got before
   * this existed: everything in scope. That default is backwards compatibility
   * rather than a recommendation - a job that names what it needs is a job
   * whose compromised dependency cannot read the deploy key it never asked
   * for, and the documentation says so.
   *
   * An empty list is *not* the same as `null`. `secrets: []` is a job saying it
   * wants none, which is a thing somebody may mean and a thing this must not
   * quietly read as "all of them".
   */
  only?: readonly string[] | null
}): SecretRow[] {
  /*
   * A fork's job gets nothing at all, before any other rule is considered.
   * Every other check here is about *which* secrets; this one is about
   * whether the question is being asked by code the repository wrote.
   */
  if (!input.trusted)
    return []

  const byKey = new Map<string, SecretRow>()
  const wanted = input.only === null || input.only === undefined ? null : new Set(input.only.map(String))

  for (const row of input.rows) {
    // Narrowed before anything else about the row is considered, because "this
    // job never asked for it" is a simpler answer than any of the scope rules
    // below and it holds whatever they say.
    if (wanted && !wanted.has(row.key))
      continue

    if (row.scope === 'environment') {
      /*
       * An environment's secret needs three things to be true: the job named
       * that environment, this row belongs to it, and the gate has opened.
       *
       * The third is what makes "released only after protection passes" real.
       * Without it the deploy credential would be sitting in the job's
       * environment while it waits for a reviewer, which is the window
       * somebody would use.
       */
      if (!input.environment || !input.environmentId || Number(row.scopeId) !== Number(input.environmentId) || !input.approved)
        continue
    }

    const held = byKey.get(row.key)

    if (!held || SECRET_PRECEDENCE[row.scope] > SECRET_PRECEDENCE[held.scope])
      byKey.set(row.key, row)
  }

  return [...byKey.values()].sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0))
}

/** Store one. The value is encrypted here and never written anywhere in the clear. */
export async function putSecret(input: {
  scope: SecretScope
  scopeId: number
  key: string
  value: string
  userId?: number | null
}): Promise<void> {
  const sealed = await encrypt(input.value)

  const existing = await db
    .selectFrom('workflow_secrets')
    .select(['id'])
    .where('scope_type', '=', input.scope)
    .where('scope_id', '=', input.scopeId)
    .where('key', '=', input.key)
    .executeTakeFirst()

  if (existing) {
    await db
      .updateTable('workflow_secrets')
      .set({ sealed: String(sealed), updated_by_id: input.userId ?? null })
      .where('id', '=', Number(existing.id))
      .execute()

    return
  }

  await db
    .insertInto('workflow_secrets')
    .values({
      scope_type: input.scope,
      scope_id: input.scopeId,
      key: input.key,
      sealed: String(sealed),
      updated_by_id: input.userId ?? null,
    })
    .execute()
}

/** The names set at every level that reaches this repository. Never values. */
export async function secretNames(repositoryId: number): Promise<SecretName[]> {
  const rows = await rowsFor(repositoryId)

  return rows
    .map(row => ({ key: row.key, scope: row.scope, updatedAt: row.updatedAt }))
    .sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0))
}

/**
 * The secrets one job may read, decrypted.
 *
 * The only path in this codebase that decrypts anything, and it is reached
 * from the claim - which is the moment a specific machine has been handed a
 * specific job, and the last point at which the trust flag and the environment
 * gate are both known.
 */
export async function secretsForJob(input: {
  repositoryId: number
  trusted: boolean
  environment: string | null
  approved: boolean
  /** The names the job asked for, or null when it named none. */
  only?: readonly string[] | null
  /**
   * Values this instance minted for the job rather than stored - the automatic
   * API token, today.
   *
   * They travel with the secrets rather than beside them, which buys two
   * things: `${{ secrets.GITHUB_TOKEN }}` works the way every workflow already
   * expects, and the value is masked in the log by the same pass that masks
   * every stored secret.
   */
  extra?: Record<string, string>
}): Promise<Record<string, string>> {
  const environmentId = input.environment ? await environmentIdOf(input.repositoryId, input.environment) : null

  const chosen = selectSecrets({
    rows: await rowsFor(input.repositoryId),
    trusted: input.trusted,
    environment: input.environment,
    environmentId,
    approved: input.approved,
    only: input.only ?? null,
  })

  const values: Record<string, string> = { ...(input.extra ?? {}) }

  for (const row of chosen) {
    try {
      values[row.key] = String(await decrypt(row.sealed))
    }
    catch {
      /*
       * A value this instance cannot decrypt is one whose APP_KEY changed.
       *
       * Skipped rather than sent as an empty string: a job that receives an
       * empty credential authenticates as nobody and fails somewhere far from
       * the cause, while a missing one fails at the line that uses it.
       */
      continue
    }
  }

  return values
}

/** Every row that could apply to this repository, with its scope resolved. */
async function rowsFor(repositoryId: number): Promise<Array<SecretRow & { updatedAt: string | null }>> {
  const repository = await db
    .selectFrom('repositories')
    .select(['id', 'owner_id'])
    .where('id', '=', repositoryId)
    .executeTakeFirst()
    .catch(() => null)

  if (!repository)
    return []

  const environments = await db
    .selectFrom('environments')
    .select(['id'])
    .where('repository_id', '=', repositoryId)
    .execute()
    .catch(() => [])

  const environmentIds = new Set(environments.map(one => Number(one.id)))

  const rows = await db
    .selectFrom('workflow_secrets')
    .select(['scope_type', 'scope_id', 'key', 'sealed', 'updated_at'])
    .execute()
    .catch(() => [])

  const found: Array<SecretRow & { updatedAt: string | null }> = []

  for (const row of rows) {
    const scope = String(row.scope_type) as SecretScope
    const scopeId = Number(row.scope_id ?? 0)

    const applies = scope === 'instance'
      || (scope === 'owner' && scopeId === Number(repository.owner_id))
      || (scope === 'repository' && scopeId === repositoryId)
      || (scope === 'environment' && environmentIds.has(scopeId))

    if (!applies)
      continue

    found.push({
      key: String(row.key),
      scope,
      scopeId,
      sealed: String(row.sealed ?? ''),
      updatedAt: row.updated_at ? String(row.updated_at) : null,
    })
  }

  return found
}

/** One environment's id, by name. */
export async function environmentIdOf(repositoryId: number, name: string): Promise<number | null> {
  const row = await db
    .selectFrom('environments')
    .select(['id'])
    .where('repository_id', '=', repositoryId)
    .where('name', '=', name)
    .executeTakeFirst()
    .catch(() => null)

  return row ? Number(row.id) : null
}

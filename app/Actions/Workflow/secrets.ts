import type { SecretStore } from './secretStore'
import { db } from '@stacksjs/database'
import { configuredStores, parseReference, REFERENCE_PREFIX, resolveReference } from './secretStore'
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

export type SecretScope = 'instance' | 'pool' | 'owner' | 'repository' | 'environment'

/**
 * Narrowest wins, and an environment beats everything - it is the most specific ask.
 *
 * A pool sits just above the instance and below the owner, and that placement is
 * a decision rather than an ordering accident. A pool secret is a statement
 * about *where* work runs - these machines hold the registry credential - and a
 * repository's own secret is a statement about *what* is running. The second is
 * the more specific of the two, so a repository that sets the same key gets its
 * own value, and an operator who needs a value nothing can override sets it and
 * says so rather than relying on precedence to enforce it.
 */
export const SECRET_PRECEDENCE: Record<SecretScope, number> = {
  instance: 0,
  pool: 1,
  owner: 2,
  repository: 3,
  environment: 4,
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
   * The pool whose machine took this job, when a pool took it.
   *
   * Null for a runner that belongs to no pool, and then no pool secret applies
   * - which is the safe direction: a pool's credentials exist because those
   * machines are trusted with them, and a machine outside the pool is not.
   */
  poolId?: number | null
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

    if (row.scope === 'pool') {
      /*
       * The machine decides this one, not the workflow. A pool secret reaches a
       * job because the job is running on that pool's hardware, so a run on
       * anybody else's machines never sees it however the workflow asks.
       */
      if (!input.poolId || Number(row.scopeId) !== Number(input.poolId))
        continue
    }

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

/**
 * Store one. The value is encrypted here and never written anywhere in the clear.
 *
 * `reference: true` stores a pointer into an external store instead of a value -
 * `store://prod/secret/data/deploy#KEY` - which is the recommended path: this
 * instance then holds a path rather than a credential, and a copy of its
 * database is a list of names rather than a list of secrets. The reference is
 * still encrypted, because "which store and which path" is worth as little to
 * an attacker as it is worth to leak.
 */
export async function putSecret(input: {
  scope: SecretScope
  scopeId: number
  key: string
  value: string
  reference?: boolean
  userId?: number | null
}): Promise<void> {
  const sealed = await encrypt(input.reference ? `${REFERENCE_PREFIX}${input.value}` : input.value)

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
  /** The pool whose machine took this job, when a pool took it. */
  poolId?: number | null
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
    rows: await rowsFor(input.repositoryId, input.poolId ?? null),
    trusted: input.trusted,
    environment: input.environment,
    environmentId,
    approved: input.approved,
    poolId: input.poolId ?? null,
    only: input.only ?? null,
  })

  const detailed = await deliverSecrets(chosen, input.extra ?? {})

  return detailed.values
}

/**
 * The same delivery, with what could not be delivered.
 *
 * Two answers rather than one because the failures matter as much as the
 * values: a secret that resolves to nothing is a job that authenticates as
 * nobody and fails somewhere far from the cause, and the claim uses this list
 * to refuse the job by name instead.
 */
export async function secretsForJobDetailed(input: {
  repositoryId: number
  trusted: boolean
  environment: string | null
  approved: boolean
  poolId?: number | null
  only?: readonly string[] | null
  extra?: Record<string, string>
  /**
   * Whether this run's definition came from the owner rather than the
   * repository, which changes what it may be given.
   */
  ownerDefined?: boolean
}): Promise<{ values: Record<string, string>, problems: Array<{ key: string, reason: string }> }> {
  const environmentId = input.environment ? await environmentIdOf(input.repositoryId, input.environment) : null

  const rows = await rowsFor(input.repositoryId, input.poolId ?? null)

  /*
   * An organization's own workflow gets the organization's secrets, and not
   * this repository's.
   *
   * The trust inversion that makes owner-wide workflows safe to give a
   * credential. An ordinary run takes its definition from the repository, so
   * repository-scoped secrets are the repository trusting itself. This one
   * takes its definition from the owner and runs *over* the repository's data -
   * and if it also took repository-scoped secrets, a repository admin could
   * declare a secret with the organization's key name and read whatever the
   * licence scan was given.
   *
   * Environment secrets go with them, for the same reason and one more: an
   * environment is configured in the repository, so an owner-wide workflow
   * naming one would be reaching for a credential the repository controls.
   */
  const applicable = input.ownerDefined
    ? rows.filter(row => row.scope !== 'repository' && row.scope !== 'environment')
    : rows

  const chosen = selectSecrets({
    rows: applicable,
    trusted: input.trusted,
    environment: input.environment,
    environmentId,
    approved: input.approved,
    poolId: input.poolId ?? null,
    only: input.only ?? null,
  })

  return deliverSecrets(chosen, input.extra ?? {})
}

/** Decrypt what is stored, and resolve whatever of it is a reference. */
async function deliverSecrets(
  chosen: readonly SecretRow[],
  extra: Record<string, string>,
): Promise<{ values: Record<string, string>, problems: Array<{ key: string, reason: string }> }> {
  const values: Record<string, string> = { ...extra }
  const problems: Array<{ key: string, reason: string }> = []

  // Read once for the whole job rather than per secret: a job with six
  // references should not read the configuration six times.
  let stores: Record<string, SecretStore> | null = null

  for (const row of chosen) {
    let stored: string

    try {
      stored = String(await decrypt(row.sealed))
    }
    catch {
      /*
       * A value this instance cannot decrypt is one whose APP_KEY changed.
       *
       * Reported rather than skipped silently: it used to be skipped, which
       * meant a rotated key looked exactly like a secret nobody had set.
       */
      problems.push({ key: row.key, reason: 'this instance cannot decrypt it, which usually means APP_KEY changed since it was written' })
      continue
    }

    if (!stored.startsWith(REFERENCE_PREFIX)) {
      values[row.key] = stored
      continue
    }

    const reference = parseReference(stored.slice(REFERENCE_PREFIX.length))

    if (!reference) {
      problems.push({ key: row.key, reason: 'it is stored as a reference this instance cannot read' })
      continue
    }

    stores = stores ?? await configuredStores()

    const resolved = await resolveReference(reference, stores)

    if (!resolved.ok) {
      problems.push({ key: row.key, reason: resolved.reason })
      continue
    }

    values[row.key] = resolved.value
  }

  return { values, problems }
}

/**
 * Every row that could apply to this repository, with its scope resolved.
 *
 * `poolId` is null everywhere except the claim, and that is why the names
 * listing on the settings screen shows no pool secrets: which pool a job will
 * land on is not known until a machine takes it, so a repository page that
 * listed them would be listing credentials that may never arrive.
 */
async function rowsFor(repositoryId: number, poolId: number | null = null): Promise<Array<SecretRow & { updatedAt: string | null }>> {
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

  /*
   * Scoped in the query, not after it.
   *
   * This read used to fetch every secret on the instance and decide in
   * TypeScript which ones applied. Nothing was decrypted before the filter and
   * no secret ever crossed a scope, so it was not a disclosure - but the blast
   * radius of a mistake in that predicate was every secret the instance holds
   * rather than one scope's, and a boundary that depends on a later `continue`
   * is a boundary one refactor away from not existing.
   *
   * One indexed read per scope rather than one clause with an expression
   * builder: this builder has no `eb`, and five small queries against
   * `(scope_type, scope_id)` are cheaper than the table scan they replace
   * anyway. A scope with no ids - a repository with no environments - is not
   * queried at all, which avoids an `IN ()` that is a syntax error on one
   * engine and matches nothing on another.
   */
  const wanted: Array<{ type: SecretScope, ids: number[] }> = [
    { type: 'repository' as SecretScope, ids: [repositoryId] },
    { type: 'owner' as SecretScope, ids: [Number(repository.owner_id)] },
    { type: 'environment' as SecretScope, ids: [...environmentIds] },
    ...(poolId !== null ? [{ type: 'pool' as SecretScope, ids: [Number(poolId)] }] : []),
  ].filter(one => one.ids.length > 0 && one.ids.every(id => Number.isInteger(id) && id > 0))

  const reads = [
    db
      .selectFrom('workflow_secrets')
      .select(['scope_type', 'scope_id', 'key', 'sealed', 'updated_at'])
      .where('scope_type', '=', 'instance')
      .execute()
      .catch(() => []),
    ...wanted.map(one => db
      .selectFrom('workflow_secrets')
      .select(['scope_type', 'scope_id', 'key', 'sealed', 'updated_at'])
      .where('scope_type', '=', one.type)
      .where('scope_id', 'in', one.ids)
      .execute()
      .catch(() => [])),
  ]

  const rows = (await Promise.all(reads)).flat()

  const found: Array<SecretRow & { updatedAt: string | null }> = []

  for (const row of rows) {
    const scope = String(row.scope_type) as SecretScope
    const scopeId = Number(row.scope_id ?? 0)

    const applies = scope === 'instance'
      || (scope === 'pool' && poolId !== null && scopeId === Number(poolId))
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

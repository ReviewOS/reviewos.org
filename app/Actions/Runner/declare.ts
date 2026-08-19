/**
 * The fleet, declared rather than clicked.
 *
 * "A fleet that cannot be declared is a fleet that drifts" - and the drift is
 * not hypothetical: pools get created during an incident, a queue gets paused
 * on a Friday and stays paused, a repository is assigned to a pool by whoever
 * was awake, and six months later nobody can say what the intended shape was.
 *
 * So the intended shape is a file, and this converges the instance to it. The
 * plan is separated from the apply for the reason every tool that does this
 * eventually learns: an operator who cannot see what a change will do before it
 * happens does not run the tool on the day it matters.
 *
 * **It creates and updates; it does not delete.** A declaration that removed
 * whatever it did not mention would, on the day somebody applied a partial
 * file, drain the fleet - and the failure mode of a convergence tool has to be
 * "nothing happened" rather than "everything went away". Anything present here
 * and absent from the file is reported as drift for a person to decide about.
 */

import { db } from '@stacksjs/database'

export interface DeclaredQueue {
  name: string
  /** `active` or `paused`. A queue declared paused is one nobody has to remember to drain. */
  state?: 'active' | 'paused'
  reason?: string
}

export interface DeclaredPool {
  name: string
  slug?: string
  description?: string
  /** Whether this pool refuses work this instance did not sign. */
  requireSignedSteps?: boolean
  queues?: DeclaredQueue[]
  /** Repositories this pool serves, as `owner/name`. Empty means every one. */
  repositories?: string[]
}

export interface DeclaredFleet {
  pools: DeclaredPool[]
}

export type ChangeKind = 'create' | 'update' | 'drift'

export interface Change {
  kind: ChangeKind
  /** `pool`, `queue`, `assignment`. */
  what: string
  /** The name a person would recognise. */
  subject: string
  /** What would happen, in one sentence. */
  detail: string
}

export interface Plan {
  changes: Change[]
  /** Anything on the instance the file does not mention. Never removed. */
  drift: Change[]
}

/**
 * What applying this file would do, without doing it.
 *
 * Read-only, and that is the whole point: `plan` is what an operator runs on
 * the morning of a change, and a plan that could alter anything is one nobody
 * trusts enough to run.
 */
export async function planFleet(declared: DeclaredFleet): Promise<Plan> {
  const changes: Change[] = []
  const drift: Change[] = []

  const pools = await db.selectFrom('runner_pools').select(['id', 'name', 'slug', 'description', 'require_signed_steps']).execute().catch(() => [])
  const queues = await db.selectFrom('runner_queues').select(['id', 'runner_pool_id', 'name', 'state']).execute().catch(() => [])
  const assigned = await db.selectFrom('runner_pool_repositories').select(['runner_pool_id', 'repository_id']).execute().catch(() => [])

  const poolBySlug = new Map(pools.map(pool => [String(pool.slug), pool]))
  const declaredSlugs = new Set<string>()

  for (const wanted of declared.pools ?? []) {
    const slug = slugOf(wanted)

    declaredSlugs.add(slug)

    const existing = poolBySlug.get(slug)

    if (!existing) {
      changes.push({ kind: 'create', what: 'pool', subject: wanted.name, detail: `create the pool \`${wanted.name}\`` })

      for (const queue of wanted.queues ?? [])
        changes.push({ kind: 'create', what: 'queue', subject: `${wanted.name}/${queue.name}`, detail: `create the queue \`${queue.name}\`` })

      for (const repository of wanted.repositories ?? [])
        changes.push({ kind: 'create', what: 'assignment', subject: `${wanted.name}/${repository}`, detail: `let \`${repository}\` run on this pool` })

      continue
    }

    if (wanted.requireSignedSteps !== undefined && Boolean(existing.require_signed_steps) !== Boolean(wanted.requireSignedSteps)) {
      changes.push({
        kind: 'update',
        what: 'pool',
        subject: wanted.name,
        detail: wanted.requireSignedSteps
          ? 'require work signed by this instance'
          : 'stop requiring signed work',
      })
    }

    const theirs = queues.filter(queue => Number(queue.runner_pool_id) === Number(existing.id))
    const byName = new Map(theirs.map(queue => [String(queue.name), queue]))

    for (const queue of wanted.queues ?? []) {
      const found = byName.get(queue.name)

      if (!found) {
        changes.push({ kind: 'create', what: 'queue', subject: `${wanted.name}/${queue.name}`, detail: `create the queue \`${queue.name}\`` })
        continue
      }

      const state = queue.state ?? 'active'

      if (String(found.state) !== state) {
        changes.push({
          kind: 'update',
          what: 'queue',
          subject: `${wanted.name}/${queue.name}`,
          // Said as the effect rather than as the column: "paused" is a word
          // whose consequence - no new work goes here - is the thing an
          // operator is deciding about.
          detail: state === 'paused' ? 'stop handing out work from this queue' : 'let this queue hand out work again',
        })
      }
    }

    for (const queue of theirs) {
      if (!(wanted.queues ?? []).some(one => one.name === String(queue.name)))
        drift.push({ kind: 'drift', what: 'queue', subject: `${wanted.name}/${String(queue.name)}`, detail: 'exists here and is not in the file' })
    }

    const wantedRepositories = await repositoryIds(wanted.repositories ?? [])
    const theirRepositories = new Set(assigned.filter(one => Number(one.runner_pool_id) === Number(existing.id)).map(one => Number(one.repository_id)))

    for (const [path, id] of wantedRepositories) {
      if (!theirRepositories.has(id))
        changes.push({ kind: 'create', what: 'assignment', subject: `${wanted.name}/${path}`, detail: `let \`${path}\` run on this pool` })
    }

    for (const id of theirRepositories) {
      if (![...wantedRepositories.values()].includes(id))
        drift.push({ kind: 'drift', what: 'assignment', subject: `${wanted.name}/#${id}`, detail: 'assigned here and not in the file' })
    }
  }

  for (const pool of pools) {
    if (!declaredSlugs.has(String(pool.slug)))
      drift.push({ kind: 'drift', what: 'pool', subject: String(pool.name), detail: 'exists here and is not in the file' })
  }

  return { changes, drift }
}

/**
 * Converge the instance to the file.
 *
 * Idempotent by construction: everything here is "make sure this exists and
 * looks like this", so applying twice is applying once. That is what makes the
 * file safe to run from a pipeline, which is the point of declaring it at all.
 */
export async function applyFleet(declared: DeclaredFleet): Promise<Plan> {
  const plan = await planFleet(declared)

  for (const wanted of declared.pools ?? []) {
    const slug = slugOf(wanted)

    let pool = await db
      .selectFrom('runner_pools')
      .select(['id', 'require_signed_steps'])
      .where('slug', '=', slug)
      .executeTakeFirst()
      .catch(() => null)

    if (!pool) {
      const created = await db
        .insertInto('runner_pools')
        .values({
          name: String(wanted.name).slice(0, 100),
          slug,
          description: String(wanted.description ?? '').slice(0, 1000) || null,
          require_signed_steps: Boolean(wanted.requireSignedSteps),
        })
        .returning(['id'])
        .executeTakeFirst()

      pool = { id: Number(created?.id), require_signed_steps: Boolean(wanted.requireSignedSteps) }
    }
    else if (wanted.requireSignedSteps !== undefined && Boolean(pool.require_signed_steps) !== Boolean(wanted.requireSignedSteps)) {
      await db
        .updateTable('runner_pools')
        .set({ require_signed_steps: Boolean(wanted.requireSignedSteps) })
        .where('id', '=', Number(pool.id))
        .execute()
    }

    for (const queue of wanted.queues ?? []) {
      const existing = await db
        .selectFrom('runner_queues')
        .select(['id', 'state'])
        .where('runner_pool_id', '=', Number(pool.id))
        .where('name', '=', queue.name)
        .executeTakeFirst()
        .catch(() => null)

      const state = queue.state ?? 'active'

      if (!existing) {
        await db
          .insertInto('runner_queues')
          .values({
            runner_pool_id: Number(pool.id),
            name: String(queue.name).slice(0, 100),
            state,
            paused_reason: state === 'paused' ? (queue.reason ?? 'declared paused') : null,
          })
          .execute()

        continue
      }

      if (String(existing.state) !== state) {
        await db
          .updateTable('runner_queues')
          .set({
            state,
            // Kept only while paused: a reason on a running queue is a note
            // about something that is no longer true.
            paused_reason: state === 'paused' ? (queue.reason ?? 'declared paused') : null,
          })
          .where('id', '=', Number(existing.id))
          .execute()
      }
    }

    for (const [, id] of await repositoryIds(wanted.repositories ?? [])) {
      const existing = await db
        .selectFrom('runner_pool_repositories')
        .select(['id'])
        .where('runner_pool_id', '=', Number(pool.id))
        .where('repository_id', '=', id)
        .executeTakeFirst()
        .catch(() => null)

      if (!existing) {
        await db
          .insertInto('runner_pool_repositories')
          .values({ runner_pool_id: Number(pool.id), repository_id: id })
          .execute()
      }
    }
  }

  return plan
}

/** `owner/name` to ids, skipping the ones that are not here. */
async function repositoryIds(paths: readonly string[]): Promise<Map<string, number>> {
  const found = new Map<string, number>()

  for (const path of paths) {
    const [owner, name] = String(path).split('/')

    if (!owner || !name)
      continue

    /*
     * Resolved through the owner's handle rather than by a join on a
     * polymorphic column: a repository belongs to a user or an organization,
     * and a lookup that only knew about one of them would silently assign
     * nothing for half the instance.
     */
    const user = await db.selectFrom('users').select(['id']).where('handle', '=', owner.toLowerCase()).executeTakeFirst().catch(() => null)
    const organization = user
      ? null
      : await db.selectFrom('organizations').select(['id']).where('handle', '=', owner.toLowerCase()).executeTakeFirst().catch(() => null)

    if (!user && !organization)
      continue

    const repository = await db
      .selectFrom('repositories')
      .select(['id'])
      .where('owner_type', '=', user ? 'user' : 'organization')
      .where('owner_id', '=', Number(user?.id ?? organization?.id))
      .where('name', '=', name)
      .executeTakeFirst()
      .catch(() => null)

    if (repository)
      found.set(path, Number(repository.id))
  }

  return found
}

/** The slug a pool is addressed by, from the file or from its name. */
function slugOf(pool: DeclaredPool): string {
  const raw = String(pool.slug ?? pool.name ?? '')

  return raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 100) || 'pool'
}

/** The file, read into the shape above. Never throws: a bad file is an empty fleet plus a reason. */
export function readDeclaration(source: string): { fleet: DeclaredFleet, error: string | null } {
  try {
    const parsed = Bun.YAML.parse(String(source ?? '')) as unknown

    if (!parsed || typeof parsed !== 'object')
      return { fleet: { pools: [] }, error: 'that file does not describe a fleet' }

    const document = parsed as Record<string, unknown>
    const pools = Array.isArray(document.pools) ? document.pools : []

    return {
      fleet: {
        pools: pools.map((raw) => {
          const pool = (raw ?? {}) as Record<string, any>

          return {
            name: String(pool.name ?? ''),
            slug: pool.slug ? String(pool.slug) : undefined,
            description: pool.description ? String(pool.description) : undefined,
            requireSignedSteps: pool.require_signed_steps === undefined ? undefined : Boolean(pool.require_signed_steps),
            queues: Array.isArray(pool.queues)
              ? pool.queues.map((queue: any) => (typeof queue === 'string'
                  ? { name: queue }
                  : { name: String(queue?.name ?? ''), state: queue?.state === 'paused' ? 'paused' as const : 'active' as const, reason: queue?.reason ? String(queue.reason) : undefined }))
              : [],
            repositories: Array.isArray(pool.repositories) ? pool.repositories.map(String) : [],
          }
        }).filter(pool => pool.name),
      },
      error: null,
    }
  }
  catch (error) {
    return { fleet: { pools: [] }, error: error instanceof Error ? error.message : String(error) }
  }
}

import { Action } from '@stacksjs/actions'
import { auditEvent } from '../../Audit/events'
import { auditFrom } from '../Git/audit'
import { db } from '@stacksjs/database'
import { schema } from '@stacksjs/validation'
import { RATE_LIMIT_HEADERS, REPOSITORY_ERRORS } from '../../Api/documented'
import { authorizeRepository } from '../Repo/authorize'
import { defaultRepairPolicy, repairPolicyFor } from './repairPolicy'

/**
 * What this repository allows an automated repair to do.
 *
 * Reading takes `repository:read`; writing takes `repository:settings`, which is
 * the same split environments use and for the same reason - "what may an agent
 * change here" is a question anybody who can see the repository may ask, and
 * "an agent may push branches to this repository" is a decision an administrator
 * makes.
 *
 * **The answer is always the effective policy**, defaults merged with whatever
 * the row says, rather than the row. A caller reading their configuration
 * wants to know what will actually happen - and the row alone says nothing
 * about the fourteen paths they are protected by without having asked.
 *
 * `enabled` is deliberately not set by writing anything else. A row is created
 * the moment somebody names a forbidden path, and switching repair on as a side
 * effect of that would be the one field nobody meant to change.
 */
export default new Action({
  name: 'RepairSettings',
  description: 'Read or change what an automated repair may do in a repository',
  method: 'POST',

  validations: {
    owner: { rule: schema.string() },
    repo: { rule: schema.string() },
    /** `show` or `update`. Reading is the default, because it is the safe one. */
    operation: { rule: schema.string(), required: false },
    enabled: { rule: schema.boolean(), required: false },
    /** Paths a repair may never change, newline or comma separated. */
    forbidden_paths: { rule: schema.string(), required: false },
    /** Failed steps that may trigger one. Empty means any of them. */
    steps: { rule: schema.string(), required: false },
    max_attempts: { rule: schema.number(), required: false },
    max_minutes: { rule: schema.number(), required: false },
    max_cost: { rule: schema.number(), required: false },
  },

  responses: {
    200: {
      description: 'The effective policy: the defaults, with this repository\'s row merged over them.',
      schema: {
        type: 'object',
        properties: {
          repair: {
            type: 'object',
            properties: {
              enabled: { type: 'boolean' },
              forbidden_paths: { type: 'array', items: { type: 'string' } },
              steps: { type: 'array', items: { type: 'string' } },
              max_attempts: { type: 'integer' },
              max_minutes: { type: 'integer' },
              max_cost: { type: 'integer' },
            },
          },
          defaults: { type: 'object', description: 'What this repository would get having said nothing, so a reader can see what they changed.' },
        },
      },
    },
    ...REPOSITORY_ERRORS,
    422: { description: 'A budget below zero, which is a ceiling that can never be met.' },
  },

  responseHeaders: RATE_LIMIT_HEADERS,

  async handle(request: RequestInstance) {
    const operation = String(request.get('operation') ?? 'show').trim() || 'show'
    const writing = operation === 'update'

    const auth = await authorizeRepository(request, writing ? 'repository:settings' : 'repository:read')

    if (!auth.ok)
      return response.json({ error: auth.error }, auth.status)

    const repositoryId = Number(auth.context.repository.id)

    if (!writing)
      return response.json(await answer(repositoryId))

    const changes: Record<string, unknown> = {}

    /*
     * Only what was named. A write that filled in every column from its
     * defaults would turn "raise the attempt limit" into "and also replace the
     * forbidden list with whatever this client happened to send", which is how
     * a settings endpoint quietly undoes a decision somebody made last month.
     */
    if (request.get('enabled') !== undefined)
      changes.enabled = isYes(request.get('enabled'))

    if (request.get('forbidden_paths') !== undefined)
      changes.forbidden_paths = String(request.get('forbidden_paths')).slice(0, 4000)

    if (request.get('steps') !== undefined)
      changes.steps = String(request.get('steps')).slice(0, 2000)

    for (const [field, ceiling] of [['max_attempts', 100], ['max_minutes', 1440], ['max_cost', 1_000_000]] as Array<[string, number]>) {
      if (request.get(field) === undefined)
        continue

      const raw = Number(request.get(field))

      /*
       * A negative budget is refused rather than floored to zero, because zero
       * already means something here - no ceiling - and quietly turning "-1"
       * into "unlimited" is the wrong direction to guess in.
       */
      if (!Number.isFinite(raw) || raw < 0)
        return response.json({ error: `\`${field}\` is a number of zero or more. Zero means no ceiling.` }, 422)

      changes[field] = Math.min(Math.floor(raw), ceiling)
    }

    if (Object.keys(changes).length === 0)
      return response.json({ error: 'Nothing to change' }, 422)

    const existing = await db
      .selectFrom('repair_settings')
      .select(['id'])
      .where('repository_id', '=', repositoryId)
      .executeTakeFirst()
      .catch(() => null)

    if (existing?.id) {
      await db.updateTable('repair_settings').set(changes).where('id', '=', Number(existing.id)).execute()
    }
    else {
      await db
        .insertInto('repair_settings')
        .values({ repository_id: repositoryId, ...changes })
        .execute()
    }

    /*
     * Recorded, and the detail is what changed rather than the whole policy.
     * "Who turned automated repair on, and when" is the question asked after an
     * agent has pushed something surprising, and an entry that repeats every
     * field makes the one that moved hard to find.
     */
    await auditEvent('workflow:repair-configured', {
      subject: { type: 'repository', id: repositoryId },
      actorId: auth.context.user?.id ?? null,
      ...await auditFrom(request),
      repositoryId,
      detail: changes,
    }).catch(() => null)

    return response.json(await answer(repositoryId))
  },
})

/**
 * The effective policy, and the defaults beside it.
 *
 * Both, because a reader who cannot see the defaults cannot tell which of their
 * settings is doing anything - and the most useful thing this endpoint says to
 * somebody about to turn repair on is what they are already protected by.
 */
async function answer(repositoryId: number): Promise<Record<string, unknown>> {
  const policy = await repairPolicyFor(repositoryId)
  const defaults = defaultRepairPolicy()

  return {
    repair: {
      enabled: policy.enabled,
      forbidden_paths: policy.forbiddenPaths,
      steps: policy.steps,
      max_attempts: policy.maxAttempts,
      max_minutes: policy.maxMinutes,
      max_cost: policy.maxCost,
    },
    defaults: {
      forbidden_paths: defaults.forbiddenPaths,
      max_attempts: defaults.maxAttempts,
      max_minutes: defaults.maxMinutes,
      max_cost: defaults.maxCost,
    },
  }
}

/** A boolean as a form sends it, which is a string more often than not. */
function isYes(value: unknown): boolean {
  const said = String(value ?? '').trim().toLowerCase()

  return value === true || said === 'true' || said === '1' || said === 'on' || said === 'yes'
}

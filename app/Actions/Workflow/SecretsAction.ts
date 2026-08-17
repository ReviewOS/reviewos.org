import { Action } from '@stacksjs/actions'
import { db } from '@stacksjs/database'
import { schema } from '@stacksjs/validation'
import { RATE_LIMIT_HEADERS, REPOSITORY_ERRORS } from '../../Api/documented'
import { authorizeRepository } from '../Repo/authorize'
import { environmentIdOf, putSecret, secretNames } from './secrets'

/**
 * Setting and removing secrets. There is deliberately no way to read one.
 *
 * `list` gives names, scopes and when each was last changed. The only consumer
 * of a value is a job on a machine an operator provided, and it receives one
 * job's worth at a claim.
 *
 * **A reveal endpoint is the feature that turns one compromised session into
 * every credential an organization has**, and not having it costs somebody a
 * trip to their password manager on the day they need the value back. That is
 * the trade, made on purpose, and it is why this file is short.
 *
 * Four scopes. The fourth - `environment` - is the one that earns the feature:
 * a deploy credential attached to `production` is not reachable from the test
 * job in the same run, which is a separation a repository-wide secret cannot
 * express however carefully somebody names it.
 */
export default new Action({
  name: 'Secrets',
  description: 'Set or remove a workflow secret, and list the names that exist',
  method: 'POST',

  validations: {
    owner: { rule: schema.string() },
    repo: { rule: schema.string() },
    operation: { rule: schema.enum(['list', 'set', 'unset']) },
    scope: { rule: schema.enum(['instance', 'owner', 'repository', 'environment']) },
    environment: { rule: schema.string() },
    key: { rule: schema.string() },
    value: { rule: schema.string() },
  },

  responses: {
    200: {
      description: 'The names that exist, their scopes, and when each was last set. Never a value.',
      schema: {
        type: 'object',
        properties: {
          secrets: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                key: { type: 'string' },
                scope: { type: 'string' },
                updated_at: { type: 'string', nullable: true },
              },
            },
          },
        },
      },
    },
    ...REPOSITORY_ERRORS,
    403: { description: 'An instance-wide or owner-wide secret is not a repository administrator\'s to set.' },
    404: { description: 'No environment by that name here.' },
    422: { description: 'A name and a value are required, and the name has to be usable in a shell.' },
  },

  responseHeaders: RATE_LIMIT_HEADERS,

  async handle(request: any) {
    const operation = String(request.get('operation') ?? 'list').trim()

    /*
     * Reading the *names* is read access: a contributor wondering why a deploy
     * step fails should be able to see whether the credential exists at all.
     * Setting one is administration.
     */
    const auth = await authorizeRepository(request, operation === 'list' ? 'repository:read' : 'repository:settings')

    if (!auth.ok)
      return response.json({ error: auth.error }, auth.status)

    const repository = auth.context.repository
    const repositoryId = Number(repository.id)

    if (operation === 'list') {
      const names = await secretNames(repositoryId)

      return response.json({
        secrets: names.map(one => ({ key: one.key, scope: one.scope, updated_at: one.updatedAt })),
        // Said in the answer rather than only in the documentation, because
        // this is the endpoint somebody reaches for when they want the value.
        note: 'Values are never returned. A job receives them at a claim.',
      })
    }

    const key = String(request.get('key') ?? '').trim()

    if (!/^[A-Z_][A-Z0-9_]*$/i.test(key)) {
      return response.json({
        error: 'That is not a usable secret name',
        reason: 'Letters, digits and underscores, not starting with a digit - the shape a shell can export.',
      }, 422)
    }

    const scope = String(request.get('scope') ?? 'repository').trim()

    /*
     * An instance secret reaches every repository on the server and an owner
     * secret reaches every repository that owner has. Administering *one*
     * repository is not that permission, and the check belongs here because it
     * is a fact about the scope rather than about the endpoint.
     */
    if ((scope === 'instance' || scope === 'owner') && auth.context.user?.is_admin !== true) {
      const row: any = await db
        .selectFrom('repositories')
        .select(['owner_type', 'owner_id'])
        .where('id', '=', repositoryId)
        .executeTakeFirst()

      const isOwner = scope === 'owner'
        && String(row?.owner_type) === 'user'
        && Number(row?.owner_id) === Number(auth.context.user?.id ?? 0)

      if (!isOwner) {
        return response.json({
          error: scope === 'instance'
            ? 'Only an instance administrator sets a secret for every repository'
            : 'Only the owner sets a secret for every one of their repositories',
        }, 403)
      }
    }

    let scopeId = repositoryId

    if (scope === 'instance') {
      scopeId = 0
    }
    else if (scope === 'owner') {
      const row: any = await db.selectFrom('repositories').select(['owner_id']).where('id', '=', repositoryId).executeTakeFirst()

      scopeId = Number(row?.owner_id ?? 0)
    }
    else if (scope === 'environment') {
      const name = String(request.get('environment') ?? '').trim()
      const found = name ? await environmentIdOf(repositoryId, name) : null

      /*
       * Refused rather than stored against nothing. A secret attached to an
       * environment that does not exist is one that will never be delivered,
       * and it would sit in a listing looking configured.
       */
      if (!found)
        return response.json({ error: 'No environment by that name here', reason: 'Create the environment first, so the secret has something to belong to.' }, 404)

      scopeId = found
    }

    if (operation === 'unset') {
      await db
        .deleteFrom('workflow_secrets')
        .where('scope_type', '=', scope)
        .where('scope_id', '=', scopeId)
        .where('key', '=', key)
        .execute()

      return response.json({ secrets: (await secretNames(repositoryId)).map(one => ({ key: one.key, scope: one.scope, updated_at: one.updatedAt })) })
    }

    const value = String(request.get('value') ?? '')

    if (!value)
      return response.json({ error: 'A secret needs a value', reason: 'To remove one, use `operation: "unset"`.' }, 422)

    await putSecret({
      scope: scope as any,
      scopeId,
      key,
      value,
      userId: auth.context.user?.id ?? null,
    })

    return response.json({
      secrets: (await secretNames(repositoryId)).map(one => ({ key: one.key, scope: one.scope, updated_at: one.updatedAt })),
      /*
       * The one sentence worth saying back. Somebody who sets a secret and
       * then cannot find it in the answer will otherwise set it again.
       */
      note: `\`${key}\` is set. Its value cannot be read back - a job receives it at a claim.`,
    })
  },
})

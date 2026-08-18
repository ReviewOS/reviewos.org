import { Action } from '@stacksjs/actions'
import { db } from '@stacksjs/database'
import { schema } from '@stacksjs/validation'
import { RATE_LIMIT_HEADERS, REPOSITORY_ERRORS } from '../../Api/documented'
import { authorizeRepository } from '../Repo/authorize'
import { resolveVariables, settingsFor } from './variables'

/**
 * Variables at four levels, and where each effective value came from.
 *
 * The listing is the reason this exists. Four places can set `REGISTRY` - the
 * instance, the owner, the repository, and the workflow file - and a value can
 * be wrong in a place nobody is looking. "It is `us-east-1`" is not the answer
 * somebody needs at that point; "it is `us-east-1`, set by the organization,
 * and this repository's `eu-west-1` is *not* winning because the workflow file
 * sets it too" is.
 *
 * **Variables, not secrets.** They are readable by anybody who can read the
 * repository, they appear in logs, and they go to every job including a fork's.
 * There is no secret store here yet and this endpoint does not pretend to be
 * one - a `secret: true` flag on a plain-text table is a thing somebody
 * eventually forgets to check.
 */
export default new Action({
  name: 'Variables',
  description: 'Set and inspect workflow variables, and see which level each effective value came from',
  method: 'POST',

  validations: {
    owner: { rule: schema.string() },
    repo: { rule: schema.string() },
    operation: { rule: schema.enum(['list', 'set', 'unset']) },
    scope: { rule: schema.enum(['instance', 'owner', 'repository']) },
    key: { rule: schema.string() },
    value: { rule: schema.string() },
  },

  responses: {
    200: {
      description: 'Every effective variable, what set it, and what it overrode.',
      schema: {
        type: 'object',
        properties: {
          variables: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                key: { type: 'string' },
                value: { type: 'string' },
                scope: { type: 'string' },
                from: { type: 'string' },
                shadowed: { type: 'array', items: { type: 'object' } },
              },
            },
          },
        },
      },
    },
    ...REPOSITORY_ERRORS,
    403: { description: 'Only an administrator sets an instance-wide variable.' },
    422: { description: 'A key is required, and the workflow level is the file rather than a row.' },
  },

  responseHeaders: RATE_LIMIT_HEADERS,

  async handle(request: RequestInstance) {
    const operation = String(request.get('operation') ?? 'list').trim()

    const auth = await authorizeRepository(request, operation === 'list' ? 'repository:read' : 'repository:settings')

    if (!auth.ok)
      return response.json({ error: auth.error }, auth.status)

    const repository = auth.context.repository
    const repositoryId = Number(repository.id)

    if (operation === 'list') {
      /*
       * The workflow level is deliberately absent from a listing.
       *
       * It is per workflow *file*, so there is no single answer for a
       * repository - and showing one file's `env:` here would say a value is
       * overridden for every run when it is overridden for one workflow.
       */
      const resolved = resolveVariables(await settingsFor(repositoryId))

      return response.json({
        variables: resolved,
        note: 'A workflow file\'s `env:` beats all of these, per workflow.',
      })
    }

    const key = String(request.get('key') ?? '').trim()

    if (!key)
      return response.json({ error: 'Which variable?' }, 422)

    if (!/^[A-Z_][A-Z0-9_]*$/i.test(key)) {
      return response.json({
        error: 'That is not a usable variable name',
        reason: 'Letters, digits and underscores, not starting with a digit - the shape a shell can export.',
      }, 422)
    }

    const scope = String(request.get('scope') ?? 'repository').trim()

    /*
     * An instance-wide variable reaches every repository on the server,
     * including ones this caller cannot see. Repository administration is not
     * enough for that, and the check is here rather than in the gate because
     * it is a fact about the *scope*, not about the endpoint.
     */
    if (scope === 'instance' && auth.context.user?.is_admin !== true)
      return response.json({ error: 'Only an instance administrator sets a variable for every repository' }, 403)

    if (scope === 'owner' && auth.context.user?.is_admin !== true) {
      /*
       * And an owner-wide one reaches every repository that owner has. Being
       * an administrator of *one* of them is not the same permission, so this
       * asks whether the caller is the owner themselves.
       */
      const owner = await db
        .selectFrom('repositories')
        .select(['owner_type', 'owner_id'])
        .where('id', '=', repositoryId)
        .executeTakeFirst()

      const isOwner = String(owner?.owner_type) === 'user' && Number(owner?.owner_id) === Number(auth.context.user?.id ?? 0)

      if (!isOwner)
        return response.json({ error: 'Only the owner sets a variable for every one of their repositories' }, 403)
    }

    const scopeId = scope === 'instance'
      ? 0
      : scope === 'owner'
        ? Number((await db.selectFrom('repositories').select(['owner_id']).where('id', '=', repositoryId).executeTakeFirst() as any)?.owner_id ?? 0)
        : repositoryId

    if (operation === 'unset') {
      await db
        .deleteFrom('workflow_variables')
        .where('scope_type', '=', scope)
        .where('scope_id', '=', scopeId)
        .where('key', '=', key)
        .execute()

      return response.json({ variables: resolveVariables(await settingsFor(repositoryId)) })
    }

    const value = String(request.get('value') ?? '')

    const existing = await db
      .selectFrom('workflow_variables')
      .select(['id'])
      .where('scope_type', '=', scope)
      .where('scope_id', '=', scopeId)
      .where('key', '=', key)
      .executeTakeFirst()

    if (existing)
      await db.updateTable('workflow_variables').set({ value }).where('id', '=', Number(existing.id)).execute()
    else
      await db.insertInto('workflow_variables').values({ scope_type: scope, scope_id: scopeId, key, value }).execute()

    const resolved = resolveVariables(await settingsFor(repositoryId))
    const effective = resolved.find(one => one.key === key)

    return response.json({
      variables: resolved,
      /*
       * Said back when the value just written is not the one runs will see.
       *
       * Setting an organization variable that a repository already overrides
       * looks like it worked, and the next question - three days later - is
       * why nothing changed.
       */
      note: effective && effective.scope !== scope
        ? `Runs still see \`${effective.value}\`, set at the ${effective.scope} level.`
        : undefined,
    })
  },
})

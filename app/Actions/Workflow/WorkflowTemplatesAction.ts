import { Action } from '@stacksjs/actions'
import { db } from '@stacksjs/database'
import { schema } from '@stacksjs/validation'
import { RATE_LIMIT_HEADERS, REPOSITORY_ERRORS } from '../../Api/documented'
import { authorizeRepository } from '../Repo/authorize'
import { applyTemplate, publishTemplate, templatesFor } from './ownerTemplates'

/**
 * Workflow templates an owner publishes, and applying one to a repository.
 *
 * The governance side of reuse. A reusable workflow is called by a repository
 * that decided to call it; a template is what an organization puts in front of
 * every repository that has not decided anything yet - which is where CI
 * conventions are actually set, and where "copy it from the last repository" is
 * how they drift.
 *
 * Keyed on a repository rather than on an owner, because that is what this
 * instance's authorization is built around: the owner is read from the
 * repository, and publishing takes `repository:settings` on one of theirs. It
 * also means `apply` needs no second lookup to know where it is writing.
 *
 * **Publishing validates the template**, and applying **refuses to overwrite**.
 * Both are the same instinct: a template is copied by people who did not write
 * it, so it should fail where its author is looking rather than in somebody
 * else's repository a week later - and it should never silently delete the
 * exception a repository made on purpose.
 */
export default new Action({
  name: 'WorkflowTemplates',
  description: 'Publish, list, and apply an owner\'s workflow templates',
  method: 'POST',

  validations: {
    owner: { rule: schema.string() },
    repo: { rule: schema.string() },
    operation: { rule: schema.enum(['list', 'publish', 'remove', 'apply']) },
    slug: { rule: schema.string() },
    name: { rule: schema.string() },
    description: { rule: schema.string() },
    path: { rule: schema.string() },
    source: { rule: schema.string() },
    template: { rule: schema.number() },
    branch: { rule: schema.string() },
    overwrite: { rule: schema.boolean() },
  },

  responses: {
    200: { description: 'The owner\'s templates, or the commit that applied one.' },
    ...REPOSITORY_ERRORS,
    404: { description: 'No such template, or no such repository.' },
    409: { description: 'That path already has a workflow, or the branch moved while this was writing.' },
    422: { description: 'The template is not a workflow this instance can run. `problems` says which lines.' },
  },

  responseHeaders: RATE_LIMIT_HEADERS,

  async handle(request: any) {
    const operation = String(request.get('operation') ?? 'list').trim()

    /*
     * Reading is read access - somebody deciding whether to adopt their
     * organization's template should be able to see it. Publishing is
     * administration of a repository the owner has; applying is a commit, so
     * it is push access to the repository being written to.
     */
    const ability = operation === 'list'
      ? 'repository:read'
      : operation === 'apply' ? 'repository:push' : 'repository:settings'

    const auth = await authorizeRepository(request, ability as any)

    if (!auth.ok)
      return response.json({ error: auth.error }, auth.status)

    const repository = await db
      .selectFrom('repositories')
      .select(['id', 'name', 'owner_type', 'owner_id'])
      .where('id', '=', Number(auth.context.repository.id))
      .executeTakeFirst()

    const ownerType = String(repository?.owner_type ?? 'user')
    const ownerId = Number(repository?.owner_id ?? 0)

    if (operation === 'list') {
      const templates = await templatesFor(ownerType, ownerId)

      return response.json({
        templates: templates.map(one => ({
          id: Number(one.id),
          slug: String(one.slug),
          name: String(one.name),
          description: String(one.description ?? ''),
          path: String(one.path),
        })),
      })
    }

    if (operation === 'publish') {
      const outcome = await publishTemplate({
        ownerType,
        ownerId,
        slug: String(request.get('slug') ?? ''),
        name: String(request.get('name') ?? ''),
        description: String(request.get('description') ?? ''),
        path: String(request.get('path') ?? ''),
        source: String(request.get('source') ?? ''),
        userId: auth.context.user?.id ?? null,
      })

      if (!outcome.ok)
        return response.json({ error: outcome.reason, problems: outcome.problems }, 422)

      return response.json({ template: { id: outcome.id, slug: String(request.get('slug') ?? '').trim().toLowerCase() } })
    }

    if (operation === 'remove') {
      const id = Number(request.get('template'))

      const found = await db
        .selectFrom('workflow_templates')
        .select(['id', 'owner_type', 'owner_id'])
        .where('id', '=', id)
        .executeTakeFirst()

      // Somebody else's template is not found rather than refused: its
      // existence is not this caller's to learn.
      if (!found || String(found.owner_type) !== ownerType || Number(found.owner_id) !== ownerId)
        return response.json({ error: 'No such template' }, 404)

      await db.deleteFrom('workflow_templates').where('id', '=', id).execute()

      return response.json({
        removed: id,
        // Said back, because deleting a template does not un-apply it: every
        // repository that adopted it still has the file, which is the right
        // behaviour and a surprising one.
        note: 'Repositories that already applied it keep the workflow they have.',
      })
    }

    const outcome = await applyTemplate({
      repositoryId: Number(repository?.id),
      ownerHandle: String(request.get('owner') ?? ''),
      repositoryName: String(repository?.name ?? ''),
      templateId: Number(request.get('template')),
      branch: String(request.get('branch') ?? '') || null,
      overwrite: request.get('overwrite') === true || String(request.get('overwrite')) === 'true',
      author: {
        name: String(auth.context.user?.handle ?? 'reviewos'),
        email: `${String(auth.context.user?.handle ?? 'reviewos')}@users.noreply.local`,
      },
    })

    if (!outcome.ok)
      return response.json({ error: outcome.reason }, outcome.status)

    return response.json({
      commit: outcome.sha,
      path: outcome.path,
      branch: outcome.branch,
      /*
       * The workflow id, because the file landing is only half of it: a
       * template that arrives as a file nothing has registered is a workflow
       * that does not exist until somebody happens to push again.
       */
      workflow: outcome.workflowId,
    })
  },
})

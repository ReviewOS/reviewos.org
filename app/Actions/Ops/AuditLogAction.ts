import { Action } from '@stacksjs/actions'
import { schema } from '@stacksjs/validation'
import { apiError } from '../../Api/errors'
import { auditEvent } from '../../Audit/events'
import { exportAudit, mayReadAudit, searchAudit } from '../../Ops/audit'
import { auditFrom } from '../Git/audit'
import { currentActor } from '../Identity/lookup'

/**
 * Reading the audit log.
 *
 * Two formats from one endpoint: JSON for a page, and JSON lines for an export.
 * A separate export endpoint would be a second place the scope check has to be
 * right, and the scope check is the only part of this that can hurt anybody.
 *
 * **Read-only, and there is no write endpoint anywhere.** Append-only is not a
 * setting here - it is the absence of any route that could do otherwise, which
 * is the only version of append-only that survives somebody adding a
 * convenience later.
 */
export default new Action({
  name: 'AuditLog',
  description: 'Search the audit log, as JSON or JSON lines',
  method: 'GET',

  validations: {
    organization_id: { rule: schema.number() },
    actor_id: { rule: schema.number() },
    /*
     * `owner` and `repo`, not `repository_id`.
     *
     * Every other endpoint here names a repository that way, and a third
     * spelling is exactly what `tests/unit/api-vocabulary.test.ts` exists to
     * stop - it caught this one. It is also the friendlier pair: somebody
     * reading an audit log knows what the repository is called, not what its
     * primary key is.
     */
    owner: { rule: schema.string() },
    repo: { rule: schema.string() },
    action: { rule: schema.string() },
    since: { rule: schema.string() },
    until: { rule: schema.string() },
    limit: { rule: schema.number() },
    before: { rule: schema.number() },
    format: { rule: schema.enum(['json', 'jsonl']) },
  },

  async handle(request: RequestInstance) {
    const { user } = await currentActor(request)

    const organizationId = Number(request.get('organization_id'))
    const scope = Number.isInteger(organizationId) && organizationId > 0
      ? { kind: 'organization' as const, organizationId }
      : { kind: 'instance' as const }

    if (!await mayReadAudit(user, scope)) {
      /*
       * 404 rather than 403, and the same answer for "you are not an
       * administrator" as for "that organization does not exist".
       *
       * Whether an organization exists is not something an audit endpoint
       * should confirm to somebody outside it, and 403-versus-404 here is a
       * membership oracle: ask for each id in turn and the ones that answer 403
       * are the organizations you are not in.
       */
      return apiError('not_found', 'No such audit log')
    }

    const query = {
      scope,
      actorId: numberOrNull(request.get('actor_id')),
      repositoryId: await repositoryIdFor(request),
      action: stringOrNull(request.get('action')),
      since: stringOrNull(request.get('since')),
      until: stringOrNull(request.get('until')),
      limit: numberOrNull(request.get('limit')) ?? undefined,
      before: numberOrNull(request.get('before')),
    }

    if (String(request.get('format') ?? 'json') === 'jsonl') {
      /*
       * Streamed rather than assembled. An instance with a year of history
       * should be able to export it without the process holding all of it, and
       * the generator already pages - so this is a pipe rather than a buffer.
       */
      /*
       * The export is itself an auditable act, and the read is not.
       *
       * Recording every page view of this endpoint would fill the log with the
       * log being looked at, and drown the events somebody came here to find.
       * Taking a *copy* of the whole thing is different in kind: it leaves the
       * instance, it is rare, and "who has a copy of this" is exactly the
       * question an audit log should be able to answer about itself.
       *
       * Emitted before the stream starts rather than after it finishes. A
       * cancelled download is still a download that began, and an export that
       * only appears in the log once it completes is one that can be avoided by
       * disconnecting.
       */
      await auditEvent('audit:exported', {
        subject: { type: 'audit_log', id: scope.kind === 'organization' ? scope.organizationId : 0 },
        actorId: user?.id ?? null,
        ...await auditFrom(request),
        organizationId: scope.kind === 'organization' ? scope.organizationId : null,
        detail: { scope: scope.kind, filters: { ...query, scope: undefined } },
      })

      const lines = exportAudit(query)

      const body = new ReadableStream({
        async pull(controller) {
          const next = await lines.next()

          if (next.done) {
            controller.close()
            return
          }

          controller.enqueue(new TextEncoder().encode(next.value))
        },
      })

      return new Response(body, {
        status: 200,
        headers: {
          'Content-Type': 'application/x-ndjson; charset=utf-8',
          // Named so a browser download is something an operator can file, and
          // dated so two exports do not overwrite each other.
          'Content-Disposition': `attachment; filename="audit-${new Date().toISOString().slice(0, 10)}.jsonl"`,
          'Cache-Control': 'no-store',
        },
      })
    }

    const page = await searchAudit(query)

    return response.json({
      events: page.rows,
      // Null on the last page rather than a cursor that returns nothing, for
      // the reason every paged endpoint here does it.
      next: page.next,
    })
  },
})

/**
 * The repository named by `owner` and `repo`, as an id.
 *
 * Null when either is missing, which means "do not filter" rather than "filter
 * by nothing". A name that does not resolve returns a **negative** id instead:
 * filtering by a repository that does not exist should produce an empty log,
 * not the whole one - and silently dropping the filter is how somebody reads a
 * page of unrelated events believing they are looking at one repository's.
 */
async function repositoryIdFor(request: RequestInstance): Promise<number | null> {
  const owner = String(request.get('owner') ?? '').trim().toLowerCase()
  const repo = String(request.get('repo') ?? '').trim()

  if (!owner || !repo)
    return null

  const { findRepositoryByPath } = await import('../Git/access')
  const repository = await findRepositoryByPath(owner, repo)

  return repository ? Number(repository.id) : -1
}

function numberOrNull(raw: unknown): number | null {
  const value = Number(raw)

  return Number.isInteger(value) && value > 0 ? value : null
}

function stringOrNull(raw: unknown): string | null {
  const value = String(raw ?? '').trim()

  return value || null
}

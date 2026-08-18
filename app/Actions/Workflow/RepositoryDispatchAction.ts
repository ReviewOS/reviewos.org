import { Action } from '@stacksjs/actions'
import { auditEvent } from '../../Audit/events'
import { auditFrom } from '../Git/audit'
import { schema } from '@stacksjs/validation'
import { RATE_LIMIT_HEADERS, REPOSITORY_ERRORS } from '../../Api/documented'
import { authorizeRepository } from '../Repo/authorize'
import { dispatchRepositoryDispatch } from './dispatch'

/**
 * Start runs from outside: `on: repository_dispatch`.
 *
 * The trigger for everything that happens somewhere else - a deployment
 * pipeline saying it finished, a package index saying a dependency moved, a
 * nightly job on a machine that is nobody's runner. Actions has it, this
 * instance recorded it as a trigger it recognised, and a workflow that named it
 * never ran.
 *
 * **The caller chooses a name and a payload, and nothing else.** Not the ref,
 * not the workflow, not which repository the payload claims to be about: the
 * definition is the registered one on the default branch, which is what makes
 * this safe to hand to a program with a narrow token.
 *
 * `client_payload` is passed through verbatim to `github.event.client_payload`,
 * because the whole point is that the caller knows something this instance does
 * not.
 */
export default new Action({
  name: 'RepositoryDispatch',
  description: 'Start workflow runs from a program, by event type',
  method: 'POST',

  validations: {
    owner: { rule: schema.string() },
    repo: { rule: schema.string() },
    event_type: { rule: schema.string() },
  },

  responses: {
    201: {
      description: 'The runs that were created. An event type no workflow watches creates none, which is not an error.',
      schema: {
        type: 'object',
        properties: {
          event_type: { type: 'string' },
          created: { type: 'array', items: { type: 'integer' } },
          note: { type: 'string' },
        },
      },
    },
    ...REPOSITORY_ERRORS,
    422: { description: 'The event type is missing, too long, or the payload is not an object.' },
  },

  responseHeaders: RATE_LIMIT_HEADERS,

  async handle(request: RequestInstance) {
    /*
     * The same ability as dispatching a workflow by hand: this starts runs, and
     * starting a run spends the instance's runners. Anybody who may read a
     * repository is not therefore somebody who may make it build.
     */
    const auth = await authorizeRepository(request, 'workflow:dispatch')
    if (!auth.ok)
      return response.json({ error: auth.error }, auth.status)

    const { repository, user } = auth.context

    const eventType = String(request.get('event_type') ?? '').trim()

    if (!eventType)
      return response.json({ error: 'An `event_type` is required' }, 422)

    if (eventType.length > 100)
      return response.json({ error: 'An `event_type` is at most 100 characters' }, 422)

    const raw = request.get('client_payload')

    if (raw !== undefined && raw !== null && (typeof raw !== 'object' || Array.isArray(raw)))
      return response.json({ error: '`client_payload` is an object' }, 422)

    const payload = (raw ?? null) as Record<string, unknown> | null

    /*
     * A ceiling on the payload, because it is stored on every run it starts and
     * handed to every job in it. Actions' own limit is 10 properties; this one
     * is on the serialised size, which is the thing that actually costs.
     */
    if (payload && JSON.stringify(payload).length > 64 * 1024)
      return response.json({ error: '`client_payload` is larger than 64KB' }, 422)

    const outcome = await dispatchRepositoryDispatch({
      repositoryId: Number(repository.id),
      eventType,
      clientPayload: payload,
      actorId: user?.id ? Number(user.id) : null,
    })

    /*
     * Recorded even when nothing started. A dispatch that matched no workflow
     * is the shape of somebody probing for one, and the empty case is the one
     * an audit reader most wants to see.
     */
    await auditEvent('workflow:run-dispatched', {
      subject: { type: 'repository', id: Number(repository.id) },
      actorId: user?.id ? Number(user.id) : null,
      ...await auditFrom(request),
      repositoryId: Number(repository.id),
      detail: { event_type: eventType, via: 'repository_dispatch', runs: outcome.created },
    }).catch(() => null)

    return response.json({
      event_type: eventType,
      created: outcome.created,
      /*
       * Said in words when nothing happened. A 201 with an empty list reads as
       * success to a program and as a mystery to the person who wrote the
       * workflow, and "no workflow here watches for that name" is the answer
       * they need - usually because of a typo in `types:`.
       */
      note: outcome.created.length > 0
        ? `Started ${outcome.created.length} ${outcome.created.length === 1 ? 'run' : 'runs'}.`
        : `No workflow in this repository triggers on \`${eventType}\`.`,
    }, 201)
  },
})

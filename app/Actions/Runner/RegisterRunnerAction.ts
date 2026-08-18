import { Action } from '@stacksjs/actions'
import { db } from '@stacksjs/database'
import { schema } from '@stacksjs/validation'
import { auditEvent } from '../../Audit/events'
import { generateToken } from '../Tokens/secret'
import { hashToken } from './authenticate'
import { protocolOf, refuseProtocol, runnerJson } from './gate'

/**
 * A machine adding itself to the fleet.
 *
 * The flow a fleet actually uses, and the reason it exists: without it an
 * autoscaler needs an *administrator's* token to create a runner, which means
 * the widest credential on the instance sits in a userdata blob on every
 * machine it starts. A registration token can do exactly one thing - add a
 * machine to one pool - and that is the whole blast radius when a machine is
 * compromised or a blob leaks.
 *
 * **The registration credential is exchanged, not kept.** Registering mints a
 * per-runner credential and the machine uses that from then on, the same shape
 * as the job token one layer down: a long-lived credential is traded for a
 * narrow one at the first opportunity. By [the threat
 * model](../../../docs/ci-threat-model.md) a registration credential must never
 * reach a job environment, and the only way to keep that promise is for the
 * thing running jobs to be holding something else by then.
 *
 * Unauthenticated in the session sense, because there is nobody at the keyboard
 * - the credential in the header *is* the authentication, and it is the only
 * thing this endpoint accepts.
 */
export default new Action({
  name: 'RegisterRunner',
  description: 'Register a machine into a pool with a registration token',
  method: 'POST',

  validations: {
    name: { rule: schema.string() },
    labels: { rule: schema.string() },
    tags: { rule: schema.string() },
  },

  responses: {
    201: {
      description: 'The runner, with its own credential. Shown once; the column holds a hash.',
      schema: {
        type: 'object',
        properties: {
          runner: {
            type: 'object',
            properties: {
              id: { type: 'integer' },
              name: { type: 'string' },
              token: { type: 'string' },
              queue: { type: 'string' },
            },
          },
        },
      },
    },
    401: { description: 'No registration token, or one that is unknown, revoked or expired.' },
    426: { description: 'This machine speaks a protocol version the server does not.' },
  },

  async handle(request: RequestInstance) {
    const protocol = protocolOf(request)
    if (!protocol.ok)
      return refuseProtocol(protocol)

    const header = String(request?.headers?.get?.('authorization') ?? '')
    const presented = header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : ''

    if (!presented)
      return runnerJson({ error: 'A registration token is required' }, 401)

    const token = await db
      .selectFrom('runner_registration_tokens')
      /*
       * `first_used_at` among them: the update below preserves it, and reading
       * a column that was never selected made that `undefined` - so every use
       * rewrote the first-use stamp, and "has this token ever been used" could
       * only ever answer "just now".
       */
      .select(['id', 'runner_pool_id', 'runner_queue_id', 'name', 'revoked_at', 'expires_at', 'uses', 'first_used_at'])
      .where('token_hash', '=', hashToken(presented))
      .executeTakeFirst()

    /*
     * One answer for unknown, revoked and expired.
     *
     * A machine that is refused cannot do anything differently with the extra
     * detail, and telling an attacker that a token *exists* but is revoked is
     * telling them the shape of the credential space.
     */
    const now = new Date()

    const usable = token
      && !token.revoked_at
      && (!token.expires_at || Date.parse(String(token.expires_at)) > now.getTime())

    if (!usable)
      return runnerJson({ error: 'This registration token is not usable' }, 401)

    const secret = generateToken()

    const labels = String(request.get('labels') ?? 'ubuntu-latest,self-hosted')
      .split(',')
      .map(label => label.trim())
      .filter(Boolean)

    /*
     * Tags a machine sets about itself at startup: `gpu=true`, `region=ash`.
     *
     * Trusted only as far as they go, which is not far: a tag decides which
     * jobs a machine is *offered*, and the pool it registered into already
     * decided which repositories those can belong to. A machine that lies about
     * its tags gets work it cannot do and fails it.
     */
    const tags = String(request.get('tags') ?? '')
      .split(',')
      .map(tag => tag.trim())
      .filter(tag => tag.includes('='))

    const name = String(request.get('name') ?? '').trim() || `runner-${Date.now()}`

    const created = await db
      .insertInto('runners')
      .values({
        name: name.slice(0, 200),
        /*
         * Instance-scoped, with the pool drawing the real boundary. A
         * registration token belongs to a pool, and the pool says which
         * repositories its machines may serve - so scope here would be a second
         * answer to a question already answered.
         */
        scope_type: 'instance',
        scope_id: null,
        token_hash: hashToken(secret.token),
        labels: labels.join('\n'),
        tags: tags.join('\n'),
        state: 'active',
        version: '1',
        runner_queue_id: token.runner_queue_id ?? await firstQueueOf(Number(token.runner_pool_id)),
        // Which credential put this machine here, kept for after the token is
        // revoked - which is exactly when somebody asks.
        runner_registration_token_id: Number(token.id),
      } as any)
      .returning(['id'])
      .executeTakeFirst()

    await db
      .updateTable('runner_registration_tokens')
      .set({
        // First use answers "has this ever been used", last use answers "is it
        // still being used". A token with a null first use is one to delete
        // without asking anybody.
        first_used_at: token.first_used_at ?? now.toISOString(),
        last_used_at: now.toISOString(),
        uses: Number(token.uses ?? 0) + 1,
      } as any)
      .where('id', '=', Number(token.id))
      .execute()

    await auditEvent('fleet:runner-registered', {
      subject: { type: 'fleet', id: Number(created?.id) },
      actorId: null,
      detail: { runner: Number(created?.id), name, pool: Number(token.runner_pool_id), token: Number(token.id) },
    }).catch(() => null)

    return runnerJson({
      runner: {
        id: Number(created?.id),
        name,
        // Shown once, and it is not the credential it registered with: from
        // here the machine authenticates as itself.
        token: secret.token,
      },
    }, 201)
  },
})

/** The pool's first queue, for a token that did not name one. */
async function firstQueueOf(poolId: number): Promise<number | null> {
  const queue = await db
    .selectFrom('runner_queues')
    .select(['id'])
    .where('runner_pool_id', '=', poolId)
    .orderBy('id', 'asc')
    .executeTakeFirst()

  return queue ? Number(queue.id) : null
}

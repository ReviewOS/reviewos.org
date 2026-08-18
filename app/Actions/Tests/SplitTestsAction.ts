import { Action } from '@stacksjs/actions'
import { schema } from '@stacksjs/validation'
import { RATE_LIMIT_HEADERS, REPOSITORY_ERRORS } from '../../Api/documented'
import { authorizeRepository } from '../Repo/authorize'
import { itemsFrom, splitForRepository } from './history'

/**
 * "Which of these should this node run?"
 *
 * The client hands over the files it found and which node it is; the answer is
 * the slice, ordered slowest first, computed from what this suite has actually
 * been costing. That is the whole of it, and keeping it that small is
 * deliberate: a client is a shell script with `curl` and `jq`, not a package
 * somebody has to install into their test environment.
 *
 * **It always answers.** A node that gets an error instead of a list cannot run
 * anything, which turns a missing-history problem into a broken build - so a
 * suite nobody has ever reported results for still gets a deterministic
 * partition, with a `note` saying it was computed from nothing. An even-looking
 * split that quietly came from no data is the failure mode worth avoiding here.
 */
export default new Action({
  name: 'SplitTests',
  description: 'Distribute a suite across parallel nodes using historical timing',
  method: 'POST',

  validations: {
    owner: { rule: schema.string() },
    repo: { rule: schema.string() },
    suite: { rule: schema.string() },
    nodes: { rule: schema.number() },
    index: { rule: schema.number() },
  },

  responses: {
    200: {
      description: 'The items this node should run, and a note when the split had little to work with.',
      schema: {
        type: 'object',
        properties: {
          items: { type: 'array', items: { type: 'string' } },
          estimated_ms: { type: 'integer' },
          unknown: { type: 'integer' },
          note: { type: 'string', nullable: true },
        },
      },
    },
    422: { description: 'Nothing to split, or a node index outside the fleet.' },
    ...REPOSITORY_ERRORS,
  },

  responseHeaders: RATE_LIMIT_HEADERS,

  async handle(request: RequestInstance) {
    // Reading timings is reading. Splitting decides nothing and records
    // nothing; it answers a question about history the caller may already see.
    const auth = await authorizeRepository(request, 'repository:read')

    if (!auth.ok)
      return response.json({ error: auth.error }, auth.status)

    const { repository } = auth.context
    const suite = String(request.get('suite') ?? 'default').trim() || 'default'
    const nodes = Math.max(1, Math.min(500, Number(request.get('nodes')) || 1))
    const index = Math.max(0, Math.min(nodes - 1, Number(request.get('index')) || 0))
    const names = itemsFrom(request.get('items'))

    if (!names.length)
      return response.json({ error: 'Nothing to split', reason: '`items` is the list of files or test names this node found.' }, 422)

    const outcome = await splitForRepository({ repositoryId: Number(repository.id), suite, items: names, nodes, index })

    return response.json({
      items: outcome.items,
      estimated_ms: outcome.estimatedMs,
      unknown: outcome.unknown,
      note: outcome.note,
      // Said back so a client can log it, and so a partition that came out
      // wrong can be reproduced from the answer alone.
      nodes,
      index,
      suite,
    })
  },
})

import { Action } from '@stacksjs/actions'
import { schema } from '@stacksjs/validation'
import publicDiff from '../../../config/publicdiff'
import { parseDiffPath } from './parse'
import { renderTargetDiff } from './render'

/**
 * Somebody else's diff, fetched and rendered, with the reader's own token.
 *
 * The page renders the public attempt itself. This exists for the other case:
 * a private repository, or a public one behind an organisation's SSO, where the
 * only thing that can read it is a token belonging to the person looking.
 *
 * ## Where the token lives
 *
 * In their browser, in `localStorage`, and nowhere else. It reaches this
 * endpoint as an `Authorization` header on one request, is used for one
 * outbound fetch, and is not written to the database, the log or a session. A
 * viewer that *stored* the token would be asking a stranger to hand over a
 * credential to somebody else's repositories, which is a different product and
 * a much worse one.
 *
 * Rows rather than a patch, because everything else on this instance renders
 * diffs on the server: sending the patch back would mean a second renderer in
 * the browser, and the seam between what the page rendered and what the client
 * rendered is precisely where a reader is looking.
 *
 * ## Why it refuses when the feature is off
 *
 * `PUBLIC_DIFF_ENABLED` is off by default. An endpoint that fetches arbitrary
 * URLs from the internet must not exist on an instance whose operator did not
 * ask for it, and "the page is not linked" is not the same as "the endpoint is
 * not there".
 */
export default new Action({
  name: 'ViewPatch',
  description: 'Fetch and render a public GitHub diff',
  method: 'GET',

  validations: {
    owner: { rule: schema.string() },
    repo: { rule: schema.string() },
    kind: { rule: schema.string() },
    ref: { rule: schema.string() },
  },

  async handle(request: RequestInstance) {
    if (!publicDiff.enabled)
      return response.json({ error: 'The public diff viewer is not enabled on this instance' }, 404)

    const owner = String(request.get('owner') ?? '')
    const repo = String(request.get('repo') ?? '')
    const kind = String(request.get('kind') ?? '')
    const ref = String(request.get('ref') ?? '')

    // Reassembled into a path and parsed by the same function the page uses,
    // rather than validated a second time here. Two validators for one shape is
    // how the endpoint comes to accept something the page would refuse.
    const target = parseDiffPath(`${owner}/${repo}/${kind}/${ref}`)

    if (!target)
      return response.json({ error: 'That is not a pull request, commit or compare range' }, 422)

    /*
     * The reader's token, from the header and from nowhere else.
     *
     * Not a query parameter, deliberately: a query string is written into the
     * access log of every proxy between here and the browser, and a personal
     * access token in a log file is a credential leak that survives the request
     * by months.
     */
    const authorization = String(request.headers?.get?.('authorization') ?? '')
    const token = authorization.toLowerCase().startsWith('bearer ')
      ? authorization.slice('bearer '.length).trim()
      : null

    const rendered = await renderTargetDiff(target, { token })

    if (!rendered.ok) {
      return response.json({
        ok: false,
        reason: rendered.reason,
        message: rendered.message,
        retryAfterMs: rendered.retryAfterMs,
      }, rendered.reason === 'rate-limited' ? 429 : 200)
    }

    return response.json({
      ok: true,
      html: rendered.html,
      files: rendered.files,
      additions: rendered.additions,
      deletions: rendered.deletions,
      via: rendered.via,
      note: rendered.message,
    })
  },
})

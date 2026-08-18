import { Action } from '@stacksjs/actions'
import { schema } from '@stacksjs/validation'
import { runGit } from '../Git/git'
import { browseContext } from './context'
import { MAX_RESULTS, parseMatches, SEARCH_BYTE_LIMIT, searchArgs } from './search'

/**
 * Search one repository's code at a ref.
 *
 * Through `browseContext`, so it answers the same question every other browse
 * endpoint does - a repository somebody can clone is a repository they can
 * search, and one they cannot is a 404 rather than a 403. Code search that
 * leaked the *existence* of a private repository through a different status
 * code would be a worse hole than the search is a feature.
 *
 * ## Bounded, because a pattern is somebody else's regular expression
 *
 * Three limits, and each is a real failure rather than a precaution:
 *
 * - **A timeout.** `git grep` with a pathological regex on a large repository
 *   runs for minutes, and a web request holding a process open that long is a
 *   denial of service somebody discovers by accident.
 * - **A result cap.** A one-character search matches every line in the
 *   repository, and a response carrying them is a page that does not render.
 * - **A minimum pattern length.** Searching for `e` is not a search; it is the
 *   whole repository, expensively.
 */
export default new Action({
  name: 'SearchCode',
  description: 'Search a repository at a ref',
  method: 'GET',

  validations: {
    owner: { rule: schema.string().required() },
    repository: { rule: schema.string() },
    q: { rule: schema.string().required() },
    ref: { rule: schema.string() },
  },

  async handle(request: RequestInstance) {
    const browse = await browseContext(request)

    if (!browse.ok)
      return response.json({ error: browse.error }, browse.status)

    const { diskPath, ref } = browse.context
    const pattern = String(request.get('q') ?? '').trim()

    if (pattern.length < 2)
      return response.json({ error: 'Search for at least two characters.' }, 422)

    /*
     * A regular expression is compiled by git, not by us, so a bad one is a
     * git error rather than an exception here - but a very long one is worth
     * refusing outright. The limit is generous for anything a person types and
     * short of the patterns that make a backtracking engine work for minutes.
     */
    if (pattern.length > 512)
      return response.json({ error: 'That pattern is too long to search for.' }, 422)

    const paths = String(request.get('path') ?? '')
      .split(',')
      .map(one => one.trim())
      .filter(Boolean)
      .slice(0, 10)

    const args = searchArgs({
      pattern,
      ref,
      regex: truthy(request.get('regex')),
      caseSensitive: truthy(request.get('case')),
      paths,
      language: String(request.get('language') ?? ''),
      context: Number(request.get('context') ?? 0),
    })

    const result = await runGit(diskPath, args, { timeoutMs: 10_000, maxBytes: SEARCH_BYTE_LIMIT })

    /*
     * Exit code 1 is "no matches", which is an answer rather than a failure.
     * Every other non-zero code is git refusing - an unparseable regex, or a
     * ref that does not exist - and the message is worth showing, because the
     * commonest one is a regex with an unbalanced bracket and the person who
     * typed it can fix that in a second if told.
     */
    if (!result.ok && result.code !== 1) {
      const reason = (result.stderr || '').split('\n').find(line => line.trim()) ?? 'the search failed'

      return response.json({ error: reason.replace(/^fatal:\s*/, '') }, 422)
    }

    // The ref is passed so the prefix git puts on every path can come off:
    // `git grep <pattern> main` reports `main:src/cart.ts`, because it is
    // reading a tree rather than a working directory.
    const matches = parseMatches(result.stdout, MAX_RESULTS, ref)

    return response.json({
      ref,
      pattern,
      matches: matches.map(match => ({
        path: match.path,
        line: match.line,
        text: truncate(match.text),
        before: match.before.map(truncate),
        after: match.after.map(truncate),
        // Where the blob view shows this exact line, so a result is one click
        // from its context rather than a path somebody has to navigate to.
        url: `/${browse.context.owner}/${browse.context.name}/blob/${encodeURIComponent(ref)}/${match.path}#L${match.line}`,
      })),
      /*
       * Whether the cap was reached, rather than a total.
       *
       * `git grep` does not count what it did not print, and a "total" that was
       * really the cap would be a number somebody plans a refactor around.
       */
      truncated: matches.length >= MAX_RESULTS || result.truncated === true,
    })
  },
})

/**
 * A line, cut to something a row can hold.
 *
 * A minified bundle is one line of two hundred thousand characters, and a
 * search that matches it returns a response nothing can render. Cut at the end
 * rather than around the match: the match's column is not reported by
 * `git grep`, and inventing a window around a guess would put the interesting
 * part off screen as often as not.
 */
function truncate(text: string): string {
  return text.length > 500 ? `${text.slice(0, 500)}…` : text
}

/** A query parameter as a flag: `1`, `true` and `on` are all yes. */
function truthy(value: unknown): boolean {
  return ['1', 'true', 'on', 'yes'].includes(String(value ?? '').toLowerCase())
}

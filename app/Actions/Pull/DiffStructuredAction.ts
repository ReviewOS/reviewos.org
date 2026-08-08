import { Action } from '@stacksjs/actions'
import { schema } from '@stacksjs/validation'
import { streamMergeBaseDiff } from '../Git/diffStream'
import { diskPathFor } from '../Git/access'
import { authorizeRepository } from '../Repo/authorize'
import { parseDiff } from './diff'
import { etagFrom, conditional } from '../../Api/etag'
import { pageSize } from '../../Api/cursor'
import { apiError } from '../../Api/errors'

/**
 * A pull request's diff as data: hunks, ranges, and the origin of every line.
 *
 * **Scraping the rendered diff should never be the only way to get one.** The
 * review screen has `/diff/rows`, which returns HTML because that is what a
 * browser needs and rendering it on the server is what makes a fifty-thousand
 * line diff cheap. An agent asking the same question has to parse that HTML
 * back into hunks, which means it re-implements the parser, gets it subtly
 * wrong, and breaks the first time a class name changes.
 *
 * So this is the same `parseDiff` the review screen uses, serialized. Not a
 * second parser and not a second definition of what a hunk is - if the two ever
 * disagree, the diff a reviewer approved is not the diff an agent read.
 *
 * **Line origins are the part worth being explicit about.** `added`, `removed`
 * and `context` with both line numbers on every line, rather than the raw
 * `+`/`-`/` ` prefix. An agent that wants to comment on line 40 of the new file
 * needs the new-side number, and deriving it from a patch means counting hunk
 * offsets - which is exactly the arithmetic that puts a comment two lines off.
 */
export default new Action({
  name: 'DiffStructured',
  description: 'A pull request diff as structured JSON',
  method: 'GET',

  /*
   * Declared so the OpenAPI document, and therefore the generated client, know
   * what this endpoint reads. Without a declaration the document says the
   * endpoint takes nothing, and a client generated from it cannot call it.
   *
   * **Deliberately none of them required.** The framework validates a declared
   * block before the action runs and answers in its own shape, which is not
   * phase 12's error envelope - so requiring a field here would replace this
   * action's `invalid_field` plus its `fix` sentence with a generic 422. The
   * declaration describes the shape; the action keeps the refusals, and for
   * input the action would have accepted the check is a no-op.
   */
  validations: {
    owner: { rule: schema.string() },
    repo: { rule: schema.string() },
    number: { rule: schema.number() },
    path: { rule: schema.string() },
    per_page: { rule: schema.number() },
    offset: { rule: schema.number() },
  },

  async handle(request: any) {
    const auth = await authorizeRepository(request, 'repository:read')
    if (!auth.ok)
      return response.json({ error: auth.error }, auth.status)

    const { repository } = auth.context
    const owner = String(request.get('owner') ?? '').trim().toLowerCase()

    const number = Number(request.get('number'))
    if (!Number.isInteger(number) || number <= 0)
      return apiError('invalid_field', 'A pull request number is required', {
        field: 'number',
        fix: 'Pass ?number= with the pull request number.',
      })

    const pullRequest: any = await db
      .selectFrom('pull_requests')
      .select(['id', 'base_sha', 'head_sha', 'changed_files'])
      .where('repository_id', '=', repository.id)
      .where('number', '=', number)
      .executeTakeFirst()

    if (!pullRequest)
      return apiError('not_found', 'No such pull request')

    const path = diskPathFor(owner, repository.name)
    if (!path)
      return apiError('not_found', 'No such pull request')

    // Captured non-null, because `build` is a closure and TypeScript cannot
    // narrow `path` through it - the check above holds, but not visibly here.
    const diskPath: string = path

    /*
     * The tag is the two shas, which is the whole of what decides this answer.
     *
     * Cheap on purpose: a diff of a large pull request costs a git process and
     * a parse, and hashing the result would mean paying that to discover the
     * client already had it. Two shas come off the row that was read anyway.
     */
    const tag = etagFrom(['diff', pullRequest.base_sha, pullRequest.head_sha, request.get('path') ?? ''])

    // `build` is only called on a miss, so a client that already has this diff
    // costs a row read and nothing else - no git process, no parse.
    return await conditional(request, tag, build)

    async function build(): Promise<Response> {
      const wanted = String(request.get('path') ?? '').trim()

      /*
       * Collected rather than streamed, and that is the one place this differs
       * from the review screen.
       *
       * `/diff/rows` streams because a browser can paint the first file while
       * git is still writing the last. A JSON document has no such shape - a
       * client cannot use half an object - so the choice is between collecting
       * it and inventing a second streaming format nobody asked for. The
       * `path` filter and paging below are what keep the collected size sane.
       */
      const diff = streamMergeBaseDiff(diskPath, String(pullRequest.base_sha), String(pullRequest.head_sha))

      // Null when a sha is not a safe revision, which `isSafeRevision` decides.
      // Refused rather than passed to git, because the shas came off a row but
      // the row could have been written by an importer.
      if (!diff)
        return apiError('internal', 'the diff could not be read')

      let raw = ''
      for await (const chunk of diff.chunks)
        raw += chunk

      const outcome = await diff.done
      if (!outcome.ok)
        return apiError('internal', outcome.stderr.trim() || 'the diff could not be read')

      const files = parseDiff(raw)
        .filter(file => !wanted || file.path === wanted || file.previousPath === wanted)

      /*
       * Paged by file, not by line.
       *
       * A single file's hunks belong together - half a file's diff is not a
       * useful thing to receive - so the page boundary is between files. A
       * pull request touching four hundred files is the case this exists for,
       * and its files are individually small.
       */
      const size = pageSize(request.get('per_page'))
      const offset = Math.max(0, Number(request.get('offset') ?? 0) || 0)
      const page = files.slice(offset, offset + size)

      return response.json({
        number,
        base_sha: pullRequest.base_sha,
        head_sha: pullRequest.head_sha,
        total_files: files.length,
        offset,
        // Null when this is the last page, matching how the cursor endpoints
        // signal the end, so a client stops on the same condition everywhere.
        next_offset: offset + page.length < files.length ? offset + page.length : null,
        files: page.map(serializeFile),
      })
    }
  },
})

/**
 * One file, in the shape an agent can act on without re-deriving anything.
 *
 * Every line carries both numbers even though one is always null - a client
 * that has to know which side it is on before it can read a number is a client
 * that will read the wrong one.
 */
function serializeFile(file: any) {
  return {
    path: file.path,
    previous_path: file.previousPath,
    status: file.status,
    binary: file.binary,
    additions: file.additions,
    deletions: file.deletions,
    old_mode: file.oldMode,
    new_mode: file.newMode,
    line_endings: file.lineEndings,
    hunks: file.hunks.map((hunk: any) => ({
      old_start: hunk.oldStart,
      old_lines: hunk.oldLines,
      new_start: hunk.newStart,
      new_lines: hunk.newLines,
      heading: hunk.heading,
      lines: hunk.lines.map((line: any) => ({
        origin: line.origin,
        content: line.content,
        old_line: line.oldLine,
        new_line: line.newLine,
        // Only when true. A `no_newline: false` on every line of every diff is
        // a lot of bytes to say nothing.
        ...(line.noNewline ? { no_newline: true } : {}),
      })),
    })),
  }
}

import { Action } from '@stacksjs/actions'
import { authorizeRepository } from '../Repo/authorize'
import { parseLcov } from './coverage'

/**
 * CI uploads a coverage report, keyed to the commit it measured.
 *
 * lcov, because it is the format every coverage tool can emit. Keyed by
 * commit rather than by pull request for the same reason check runs are: one
 * report serves every pull request whose head is that commit, and a
 * force-push naturally orphans the old report instead of mislabeling new
 * code with it.
 *
 * `check:report`, the reporter's own ability: reporting facts about a commit
 * is a write, and it is deliberately not the permission to push code.
 *
 * An upload replaces the commit's previous report whole. Coverage is a
 * statement about one test run; merging two runs' opinions line by line
 * would produce a report no run ever made.
 */
export const MAX_REPORT_BYTES = 10 * 1024 * 1024

export default new Action({
  name: 'UploadCoverage',
  description: 'Store a coverage report for a commit',
  method: 'POST',

  async handle(request: any) {
    const auth = await authorizeRepository(request, 'check:report')
    if (!auth.ok)
      return response.json({ error: auth.error }, auth.status)

    const { repository } = auth.context

    const sha = String(request.get('sha') ?? '').trim()
    if (!/^[0-9a-f]{40}$/.test(sha))
      return response.json({ error: 'A full commit sha is required' }, 422)

    // A multipart file when CI sends one, the raw body otherwise - curl
    // pipes lcov straight in either way.
    const file = request.file?.('file')
    const text = file
      ? await file.text()
      : String(request.get('lcov') ?? '')

    if (!text.trim())
      return response.json({ error: 'An lcov report is required' }, 422)

    if (text.length > MAX_REPORT_BYTES)
      return response.json({ error: 'That report is too large' }, 413)

    const parsed = parseLcov(text)
    if (parsed.size === 0)
      return response.json({ error: 'That does not read as lcov' }, 422)

    // Replace, never accumulate: delete the commit's previous rows, then
    // write the new report. The unique index on (repository, sha, path) is
    // what makes a concurrent double upload safe - one of them wins whole.
    await db
      .deleteFrom('coverage_files')
      .where('repository_id', '=', Number(repository.id))
      .where('commit_sha', '=', sha)
      .execute()

    let files = 0
    for (const [path, lines] of parsed) {
      await db.insertInto('coverage_files').values({
        repository_id: Number(repository.id),
        commit_sha: sha,
        path,
        uncovered_lines: JSON.stringify(lines.uncovered),
        covered_lines: JSON.stringify(lines.covered),
      }).execute()

      files += 1
    }

    return response.json({ sha, files }, 201)
  },
})

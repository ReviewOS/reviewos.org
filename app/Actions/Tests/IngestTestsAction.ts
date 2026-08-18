import { Action } from '@stacksjs/actions'
import { db } from '@stacksjs/database'
import { schema } from '@stacksjs/validation'
import { RATE_LIMIT_HEADERS, REPOSITORY_ERRORS } from '../../Api/documented'
import { authorizeRepository } from '../Repo/authorize'
import { ingestTestRun } from './ingest'
import { parseJunit } from './junit'

/**
 * Test results, from any CI.
 *
 * The endpoint that makes the rest of this worth having: results arrive from
 * wherever they were produced, so a repository gets flake detection *before* it
 * moves a pipeline here. A feature that only works after a migration is one
 * nobody evaluates.
 *
 * Authenticated with an ordinary repository credential and `check:report` -
 * the same ability a CI integration already needs to say a commit passed.
 * Reporting test results is the same act at a finer grain, and inventing a
 * second permission for it would mean every existing integration asking for one
 * more scope to do less.
 *
 * ## The answer is the point
 *
 * It replies with a **verdict that ignores muted failures**, the counts, and
 * the tests this run showed to be newly flaky. A collector that wants a mute to
 * decide the job's outcome uses that verdict as its exit status; nothing here
 * can reach back and change what the test runner already did, and the
 * documentation says so rather than implying otherwise.
 */
export default new Action({
  name: 'IngestTests',
  description: 'Record test results for a commit, from this instance\'s CI or anybody else\'s',
  method: 'POST',

  validations: {
    owner: { rule: schema.string() },
    repo: { rule: schema.string() },
    suite: { rule: schema.string() },
    sha: { rule: schema.string() },
    branch: { rule: schema.string() },
    key: { rule: schema.string() },
    format: { rule: schema.enum(['junit', 'json']) },
    report: { rule: schema.string() },
  },

  responses: {
    200: {
      description: 'What was recorded, and the verdict this instance reaches once muted failures are set aside.',
      schema: {
        type: 'object',
        properties: {
          run: { type: 'integer' },
          verdict: { type: 'string' },
          duplicate: { type: 'boolean' },
          counts: {
            type: 'object',
            properties: {
              passed: { type: 'integer' },
              failed: { type: 'integer' },
              skipped: { type: 'integer' },
              muted_failures: { type: 'integer' },
            },
          },
          newly_flaky: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    422: { description: 'The report could not be read. `reason` says what was wrong with it.' },
    ...REPOSITORY_ERRORS,
  },

  responseHeaders: RATE_LIMIT_HEADERS,

  async handle(request: RequestInstance) {
    /*
     * `check:report`, not a scope of its own. A CI integration that may say a
     * commit passed may say which tests did: the finer grain is strictly less
     * authority, and a new scope would mean every existing integration asking
     * for one more permission to tell you *more*.
     */
    const auth = await authorizeRepository(request, 'check:report')
    if (!auth.ok)
      return response.json({ error: auth.error }, auth.status)

    const { repository } = auth.context

    const sha = String(request.get('sha') ?? '').trim()

    if (!sha)
      return response.json({ error: 'Which commit did these tests run against?' }, 422)

    const format = String(request.get('format') ?? 'junit').trim() === 'json' ? 'json' : 'junit'
    const report = request.get('report')

    let executions: any[] = []

    if (format === 'junit') {
      const parsed = parseJunit(String(report ?? ''))

      if (!parsed.ok)
        return response.json({ error: 'This report could not be read', reason: parsed.reason }, 422)

      executions = parsed.executions
    }
    else {
      /*
       * The documented JSON shape, which exists because JUnit XML cannot carry
       * the things that turn out to matter - retries, tags, which job it ran
       * in - without somebody inventing an attribute for each.
       */
      const body = typeof report === 'string' ? safeJson(report) : report

      if (!Array.isArray(body?.tests))
        return response.json({ error: 'This report could not be read', reason: 'a JSON report is `{ "tests": [ ... ] }`' }, 422)

      executions = body.tests
        .filter((one: Record<string, unknown>) => one && typeof one === 'object' && one.name)
        .map((one: Record<string, unknown>) => ({
          scope: String(one.scope ?? one.file ?? ''),
          name: String(one.name),
          result: ['passed', 'failed', 'skipped'].includes(String(one.result)) ? String(one.result) : 'passed',
          durationMs: Number(one.duration_ms ?? one.durationMs ?? 0) || 0,
          retries: Number(one.retries ?? 0) || 0,
          failureMessage: one.failure_message ?? one.failureMessage ?? null,
          failureStack: one.failure_stack ?? one.failureStack ?? null,
          tags: Array.isArray(one.tags) ? one.tags.map(String) : [],
        }))
    }

    const pull = await pullRequestFor(Number(repository.id), String(request.get('branch') ?? ''))

    const outcome = await ingestTestRun({
      repositoryId: Number(repository.id),
      suite: String(request.get('suite') ?? 'default'),
      headSha: sha,
      branch: String(request.get('branch') ?? '') || null,
      pullRequestId: pull,
      /*
       * The reporter's own id, and the reason a retrying collector does not
       * double every test's history. Every collector retries.
       */
      key: String(request.get('key') ?? '') || null,
      source: format,
      executions,
    })

    if (!outcome.ok)
      return response.json({ error: 'This report could not be recorded', reason: outcome.reason }, 422)

    return response.json({
      run: outcome.runId,
      duplicate: outcome.duplicate ?? false,
      // Muted failures are set aside here and nowhere else: they are still
      // counted, still shown, and still in the test's history.
      verdict: outcome.verdict,
      counts: {
        passed: outcome.counts?.passed ?? 0,
        failed: outcome.counts?.failed ?? 0,
        skipped: outcome.counts?.skipped ?? 0,
        muted_failures: outcome.counts?.mutedFailures ?? 0,
      },
      newly_flaky: outcome.newlyFlaky ?? [],
    })
  },
})

/** The open pull request for a branch, when the reporter named one. */
async function pullRequestFor(repositoryId: number, branch: string): Promise<number | null> {
  if (!branch)
    return null

  const pull = await db
    .selectFrom('pull_requests')
    .select(['id'])
    .where('repository_id', '=', repositoryId)
    .where('head_ref', '=', branch)
    .where('state', '=', 'open')
    .orderBy('id', 'desc')
    .executeTakeFirst()
    .catch(() => null)

  return pull ? Number(pull.id) : null
}

/** JSON that may not be, from a machine this instance does not control. */
function safeJson(text: string): any {
  try {
    return JSON.parse(text)
  }
  catch {
    return null
  }
}

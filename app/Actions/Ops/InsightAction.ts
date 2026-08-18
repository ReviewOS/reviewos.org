import { Action } from '@stacksjs/actions'
import { schema } from '@stacksjs/validation'
import { RATE_LIMIT_HEADERS } from '../../Api/documented'
import { DEFAULT_WINDOW_DAYS, insightFor, MAX_WINDOW_DAYS } from '../../Ops/insight'
import { currentActor } from '../Identity/lookup'
import { authorizeRepository } from '../Repo/authorize'

/**
 * The statistics block, documented once and used for both scopes.
 *
 * Every rate is nullable in the document as well as in the response, because a
 * client generated from a schema that says otherwise will crash on the first
 * quiet repository it meets.
 */
const STATISTICS = {
  type: 'object',
  properties: {
    workflow: { type: 'string' },
    path: { type: 'string' },
    runs: { type: 'integer' },
    success_rate: { type: 'number', nullable: true },
    p50_ms: { type: 'integer', nullable: true },
    p95_ms: { type: 'integer', nullable: true },
    retry_rate: { type: 'number', nullable: true },
    samples: { type: 'integer' },
  },
} as const

/**
 * The pipeline dashboard, as data.
 *
 * **One endpoint behind both screens**, which is the roadmap's requirement and
 * also the only way the two stay honest: a screen computing its own version of
 * the success rate is a second definition of success, and the day they disagree
 * nobody can tell which one is wrong.
 *
 * Two scopes, and the difference is who may ask:
 *
 * - `owner` + `repo`: anybody who can read that repository. These numbers are
 *   about their own CI and say nothing about anybody else's.
 * - no scope: the whole instance, and an administrator only. Fleet-wide
 *   utilization and per-owner minutes describe every tenant here, which is not
 *   something one tenant is owed.
 *
 * A non-administrator asking instance-wide gets 404 rather than 403, the same
 * as the other operator endpoints: whether this instance has a fleet is not a
 * fact to confirm to a stranger.
 */
export default new Action({
  name: 'Insight',
  description: 'Run, queue, fleet, and cost numbers over a window',
  method: 'GET',

  validations: {
    owner: { rule: schema.string(), required: false },
    repo: { rule: schema.string(), required: false },
    days: { rule: schema.number(), required: false },
  },

  responses: {
    200: {
      description: 'The window, and every figure the operator screens show.',
      schema: {
        type: 'object',
        properties: {
          window: {
            type: 'object',
            properties: {
              days: { type: 'integer' },
              from: { type: 'string' },
              to: { type: 'string' },
            },
          },
          overall: STATISTICS,
          workflows: { type: 'array', items: STATISTICS },
          failures_by_job: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                failures: { type: 'integer' },
                runs: { type: 'integer' },
              },
            },
          },
          wait: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                queue: { type: 'string' },
                pool: { type: 'string' },
                samples: { type: 'integer' },
                p50_ms: { type: 'integer', nullable: true },
                p95_ms: { type: 'integer', nullable: true },
              },
            },
          },
          runners: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                runner: { type: 'string' },
                busy_ms: { type: 'integer' },
                utilization: { type: 'number' },
                idle_ms: { type: 'integer' },
              },
            },
          },
          cost: {
            type: 'object',
            properties: {
              repositories: { type: 'array', items: { type: 'object' } },
              owners: { type: 'array', items: { type: 'object' } },
              queues: { type: 'array', items: { type: 'object' } },
            },
          },
          flaky: {
            type: 'object',
            properties: {
              runs_failed_by_known_flaky: { type: 'integer' },
              failed_runs: { type: 'integer' },
              share: { type: 'number', nullable: true },
            },
          },
        },
      },
    },
    404: { description: 'No such repository, or the caller may not read the instance-wide numbers.' },
  },

  responseHeaders: RATE_LIMIT_HEADERS,

  async handle(request: any) {
    const owner = String(request.get('owner') ?? '').trim()
    const repo = String(request.get('repo') ?? '').trim()

    /*
     * Clamped rather than rejected. A window is a dial somebody drags, and an
     * error for 400 days is a dial that breaks at the end of its travel; the
     * response says which window it actually used, so nobody is misled about
     * what they are looking at.
     */
    const asked = Number(request.get('days'))
    const days = Number.isFinite(asked) && asked > 0
      ? Math.min(MAX_WINDOW_DAYS, Math.floor(asked))
      : DEFAULT_WINDOW_DAYS

    let repositoryId = 0

    if (owner && repo) {
      const auth = await authorizeRepository(request, 'repository:read')

      if (!auth.ok)
        return response.json({ error: auth.error }, auth.status)

      repositoryId = Number(auth.context.repository.id)
    }
    else {
      const { user } = await currentActor(request)

      if (!user?.is_admin)
        return response.json({ error: 'Not found' }, 404)
    }

    const insight = await insightFor({ repositoryId, days })

    return response.json({
      window: insight.window,
      overall: shape(insight.overall),
      workflows: insight.workflows.map(one => ({ workflow: one.workflow, path: one.path, ...shape(one) })),
      failures_by_job: insight.failuresByJob,
      wait: insight.wait.map(one => ({
        queue: one.queue,
        pool: one.pool,
        samples: one.samples,
        p50_ms: one.p50,
        p95_ms: one.p95,
      })),
      runners: insight.runners.map(one => ({
        runner: one.runner,
        busy_ms: one.busyMs,
        utilization: round(one.share),
        // Idle is derived rather than measured, and said in the same units: a
        // reader deciding whether to shut a machine down wants the hours it did
        // nothing, not the arithmetic.
        idle_ms: Math.max(0, insight.window.days * 86_400_000 - one.busyMs),
      })),
      cost: {
        repositories: insight.cost.repositories.map(one => ({ repository: one.key, minutes: one.minutes })),
        owners: insight.cost.owners.map(one => ({ owner: one.key, minutes: one.minutes })),
        queues: insight.cost.queues.map(one => ({ queue: one.key, minutes: one.minutes })),
      },
      flaky: {
        runs_failed_by_known_flaky: insight.flaky.runsFailedByFlaky,
        failed_runs: insight.flaky.failedRuns,
        share: round(insight.flaky.share),
      },
    })
  },
})

/** The statistics block, in the API's snake_case, with the nulls kept as nulls. */
function shape(statistics: {
  runs: number
  successRate: number | null
  p50: number | null
  p95: number | null
  retryRate: number | null
  samples: number
}): Record<string, unknown> {
  return {
    runs: statistics.runs,
    /*
     * Null travels. A client that gets `0` for a success rate computed from two
     * runs will draw it, and a chart showing zero percent success is a page
     * somebody escalates; null is the one value a chart library declines to
     * plot, which is the correct behaviour here.
     */
    success_rate: round(statistics.successRate),
    p50_ms: statistics.p50,
    p95_ms: statistics.p95,
    retry_rate: round(statistics.retryRate),
    samples: statistics.samples,
  }
}

/** Three decimals: these are shares, and the fourth is noise. */
function round(value: number | null): number | null {
  return value === null ? null : Math.round(value * 1000) / 1000
}

import { Action } from '@stacksjs/actions'
import { db } from '@stacksjs/database'
import { schema } from '@stacksjs/validation'
import { RATE_LIMIT_HEADERS, REPOSITORY_ERRORS } from '../../Api/documented'
import { authorizeRepository } from '../Repo/authorize'

/**
 * What this repository's CI has actually been doing.
 *
 * Every number here can be worked out by reading runs one at a time, which is
 * why nobody does it: "is CI getting slower" is a question about a hundred runs
 * and the run screen is a question about one. So the aggregation happens where
 * the rows are.
 *
 * ## The numbers, and why these ones
 *
 * **Success rate** is the headline and the least useful on its own - a
 * repository at 80% is either flaky or failing honestly, and the two want
 * opposite responses. **Failure by step** is what separates them: one step
 * accounting for most of the failures is a flaky test, and failures spread
 * evenly are a codebase.
 *
 * **Queue time beside duration**, because they have different fixes and the
 * sum hides which one is needed - more machines, or faster jobs. **Retry
 * count** is the flakiness that has already been paid for. **Cache
 * effectiveness** is hits over lookups, which is the number that says whether a
 * key changes too often. **Runner utilization** is how much of the fleet's
 * time went into work rather than into waiting.
 *
 * ## The window is part of the answer
 *
 * A success rate with no window is a number that gets less useful every day the
 * instance runs: a repository that was broken for a week in March never
 * recovers its average. The default is thirty days, and the window travels in
 * the response so a client cannot show a number without saying what it is of.
 */
export default new Action({
  name: 'WorkflowMetrics',
  description: 'Aggregate CI numbers for a repository, optionally for one workflow',
  method: 'GET',

  validations: {
    owner: { rule: schema.string() },
    repo: { rule: schema.string() },
    /** One workflow, by id. Every workflow in the repository when absent. */
    workflow: { rule: schema.number(), required: false },
    /** How many days back to look. Thirty by default, ninety at most. */
    days: { rule: schema.number(), required: false },
  },

  responses: {
    200: {
      description: 'The aggregate numbers, with the window they are of.',
      schema: {
        type: 'object',
        properties: {
          window: { type: 'object', properties: { days: { type: 'integer' }, since: { type: 'string' } } },
          runs: { type: 'object' },
          jobs: { type: 'object' },
          steps: { type: 'array', items: { type: 'object' }, description: 'The steps that failed most often, worst first.' },
          cache: { type: 'object' },
        },
      },
    },
    ...REPOSITORY_ERRORS,
  },

  responseHeaders: RATE_LIMIT_HEADERS,

  async handle(request: RequestInstance) {
    const auth = await authorizeRepository(request, 'workflow:read')

    if (!auth.ok)
      return response.json({ error: auth.error }, auth.status)

    const repositoryId = Number(auth.context.repository.id)

    const asked = Number(request.get('days'))
    const days = Number.isFinite(asked) && asked > 0 ? Math.min(Math.floor(asked), 90) : 30
    const since = new Date(Date.now() - days * 86_400_000).toISOString()

    /*
     * One workflow's runs, when asked for.
     *
     * By version rather than by workflow, because a run points at a version -
     * and resolving the ids here keeps the aggregation a single scan rather
     * than a join per number.
     */
    const workflowId = Number(request.get('workflow'))

    const versionIds = Number.isFinite(workflowId) && workflowId > 0
      ? (await db
          .selectFrom('workflow_versions')
          .select(['id'])
          .where('workflow_id', '=', workflowId)
          .execute()
          .catch(() => []))
          .map(row => Number(row.id))
      : null

    if (versionIds && versionIds.length === 0)
      return response.json(empty(days, since))

    let runQuery = db
      .selectFrom('workflow_runs')
      .select(['id', 'state', 'attempt', 'started_at', 'finished_at', 'created_at'])
      .where('repository_id', '=', repositoryId)
      .where('created_at', '>=', since)

    if (versionIds)
      runQuery = runQuery.where('workflow_version_id', 'in', versionIds)

    const runs = await runQuery.limit(5000).execute().catch(() => [])

    if (runs.length === 0)
      return response.json(empty(days, since))

    const ids = runs.map(run => Number(run.id))

    const jobs = await db
      .selectFrom('workflow_jobs')
      .select(['id', 'state', 'attempt', 'queued_at', 'started_at', 'finished_at', 'cache_lookups', 'cache_hits'])
      .where('workflow_run_id', 'in', ids)
      .limit(20_000)
      .execute()
      .catch(() => [])

    const steps = jobs.length > 0
      ? await db
        .selectFrom('workflow_steps')
        .select(['name', 'state', 'position'])
        .where('workflow_job_id', 'in', jobs.map(job => Number(job.id)))
        .where('state', '=', 'failed')
        .limit(20_000)
        .execute()
        .catch(() => [])
      : []

    const finished = runs.filter(run => ['succeeded', 'failed', 'cancelled'].includes(String(run.state)))
    const succeeded = finished.filter(run => String(run.state) === 'succeeded')

    /*
     * Failures by step name rather than by position: `make test` at step 3 in
     * one job and step 5 in another is the same step failing, and a table keyed
     * on position would report it as two problems neither of which looks
     * serious.
     */
    const byStep = new Map<string, number>()

    for (const step of steps as any[]) {
      const name = String(step.name ?? `step ${Number(step.position ?? 0) + 1}`)

      byStep.set(name, (byStep.get(name) ?? 0) + 1)
    }

    const lookups = jobs.reduce((total, job) => total + (Number(job.cache_lookups ?? 0) || 0), 0)
    const hits = jobs.reduce((total, job) => total + (Number(job.cache_hits ?? 0) || 0), 0)

    const queueMs = jobs.map(job => between(job.queued_at, job.started_at)).filter(one => one !== null) as number[]
    const runMs = jobs.map(job => between(job.started_at, job.finished_at)).filter(one => one !== null) as number[]

    return response.json({
      window: { days, since },

      runs: {
        total: runs.length,
        finished: finished.length,
        succeeded: succeeded.length,
        // A rate over finished runs rather than over all of them: a run still
        // going is not a run that failed, and counting it as one makes a busy
        // afternoon look like an outage.
        success_rate: finished.length > 0 ? round(succeeded.length / finished.length) : null,
        duration_ms: middle(runs.map(run => between(run.started_at, run.finished_at)).filter(one => one !== null) as number[]),
      },

      jobs: {
        total: jobs.length,
        /*
         * Attempts past the first, which is the flakiness that has already been
         * paid for in machine time. A count of attempts would read as "how many
         * jobs ran", which is the number above.
         */
        retries: jobs.reduce((total, job) => total + Math.max(0, Number(job.attempt ?? 1) - 1), 0),
        queue_ms: middle(queueMs),
        duration_ms: middle(runMs),
        /*
         * How much of the fleet's time went into work rather than waiting.
         *
         * Derived from the same two numbers rather than measured on the
         * machines: a runner's own idle time is a fact about the fleet, and
         * this is a fact about this repository's demand on it.
         */
        utilization: queueMs.length > 0 || runMs.length > 0
          ? round(sum(runMs) / Math.max(1, sum(runMs) + sum(queueMs)))
          : null,
      },

      steps: [...byStep.entries()]
        .map(([name, failures]) => ({ name, failures }))
        .sort((left, right) => right.failures - left.failures)
        .slice(0, 10),

      cache: {
        lookups,
        hits,
        // Null rather than zero when nothing asked: a repository that does not
        // use the cache has no hit rate, and 0% reads as one that is broken.
        hit_rate: lookups > 0 ? round(hits / lookups) : null,
      },
    })
  },
})

/** The shape of an answer with nothing in it, so a client parses one thing. */
function empty(days: number, since: string): Record<string, unknown> {
  return {
    window: { days, since },
    runs: { total: 0, finished: 0, succeeded: 0, success_rate: null, duration_ms: null },
    jobs: { total: 0, retries: 0, queue_ms: null, duration_ms: null, utilization: null },
    steps: [],
    cache: { lookups: 0, hits: 0, hit_rate: null },
  }
}

/** Milliseconds between two stamps, or null when either is missing. */
function between(from: unknown, to: unknown): number | null {
  const start = from ? Date.parse(String(from)) : Number.NaN
  const end = to ? Date.parse(String(to)) : Number.NaN

  if (!Number.isFinite(start) || !Number.isFinite(end))
    return null

  return Math.max(0, end - start)
}

/**
 * The median, not the mean.
 *
 * One nine-hour job that hung until its timeout moves a mean far enough to hide
 * a week of ordinary builds, and "how long does this usually take" is the
 * question being asked. The mean answers a different one nobody asked.
 */
function middle(values: readonly number[]): number | null {
  if (values.length === 0)
    return null

  const sorted = [...values].sort((left, right) => left - right)
  const middleIndex = Math.floor(sorted.length / 2)

  return sorted.length % 2 === 1
    ? sorted[middleIndex]!
    : Math.round(((sorted[middleIndex - 1] ?? 0) + (sorted[middleIndex] ?? 0)) / 2)
}

function sum(values: readonly number[]): number {
  return values.reduce((total, one) => total + one, 0)
}

/** A rate as two decimals, which is as much precision as any of these have. */
function round(value: number): number {
  return Math.round(value * 100) / 100
}

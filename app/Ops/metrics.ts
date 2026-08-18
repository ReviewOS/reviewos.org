import { db } from '@stacksjs/database'
/**
 * What this instance is doing, as numbers something can scrape.
 *
 * Prometheus exposition format, because it is what every scraper reads and
 * because the alternative - a JSON shape of our own - is a format each operator
 * has to write an exporter for. A self-hosted forge should be observable with
 * the tools people already run.
 *
 * ## In memory, and reset on restart
 *
 * Counters live in this process and start at zero when it does. That is the
 * normal shape for a Prometheus counter: a scraper detects the reset and
 * handles it, and `rate()` over a counter that restarted is still correct.
 * Persisting them would be work done to make a graph prettier across a deploy,
 * at the cost of a write on every request.
 *
 * The consequence for several processes is the same as everywhere else here:
 * each reports its own numbers, and the scrape target is the process rather
 * than the instance. That is what a scraper expects.
 *
 * ## Why the histograms are so coarse
 *
 * Six buckets, not twenty. Every bucket is a time series per label
 * combination, and a forge with two hundred repositories can produce a
 * cardinality explosion out of well-meant detail. The buckets here are chosen
 * around decisions somebody makes - is this fast, is this slow, is this a
 * problem - rather than to draw a smooth curve.
 */

export interface Snapshot {
  counters: Record<string, number>
  histograms: Record<string, { buckets: Record<string, number>, sum: number, count: number }>
  gauges: Record<string, number>
}

const counters = new Map<string, number>()
const gauges = new Map<string, number>()
const histograms = new Map<string, { buckets: number[], counts: number[], sum: number, count: number }>()

/**
 * Latency buckets, in seconds.
 *
 * Around the decisions: 10ms is "nothing happened", 100ms is "a page", 1s is
 * "somebody noticed", 10s is "somebody complained". Anything past 30 is in the
 * overflow bucket, where it belongs - the difference between 45 and 90 seconds
 * is not a difference anybody acts on differently.
 */
const LATENCY_BUCKETS = [0.01, 0.1, 0.5, 1, 10, 30]

/**
 * Git operation buckets, in seconds, and deliberately wider.
 *
 * A `rev-parse` is a millisecond and a clone of a large repository is minutes.
 * Sharing the HTTP buckets would put every real git operation in the overflow
 * and every trivial one in the first bucket, which is a histogram that answers
 * nothing.
 */
const GIT_BUCKETS = [0.05, 0.5, 2, 10, 60, 300]

/** Count one occurrence. */
export function increment(name: string, labels: Record<string, string> = {}, by = 1): void {
  const key = seriesKey(name, labels)

  counters.set(key, (counters.get(key) ?? 0) + by)
}

/** Record a value that goes up and down. */
export function gauge(name: string, value: number, labels: Record<string, string> = {}): void {
  gauges.set(seriesKey(name, labels), value)
}

/** Record how long something took, in seconds. */
export function observe(name: string, seconds: number, labels: Record<string, string> = {}, buckets = LATENCY_BUCKETS): void {
  const key = seriesKey(name, labels)
  const existing = histograms.get(key) ?? { buckets, counts: Array.from({ length: buckets.length + 1 }, () => 0), sum: 0, count: 0 }

  let index = existing.buckets.findIndex(bound => seconds <= bound)
  if (index === -1)
    index = existing.buckets.length

  existing.counts[index] = (existing.counts[index] ?? 0) + 1
  existing.sum += seconds
  existing.count += 1

  histograms.set(key, existing)
}

/** Time a git operation, with its own wider buckets. */
export function observeGit(operation: string, seconds: number): void {
  observe('reviewos_git_operation_seconds', seconds, { operation }, GIT_BUCKETS)
}

/**
 * The numbers, in Prometheus text format.
 *
 * `TYPE` and `HELP` lines included, because a metric without them is a metric
 * whose meaning lives in somebody's head. The name is the interface here -
 * dashboards and alerts are written against it - so renaming one later is a
 * breaking change to somebody's pager.
 */
export function render(): string {
  const lines: string[] = []
  const described = new Set<string>()

  const describe = (name: string, type: string, help: string) => {
    if (described.has(name))
      return

    described.add(name)
    lines.push(`# HELP ${name} ${help}`)
    lines.push(`# TYPE ${name} ${type}`)
  }

  for (const [key, value] of [...counters.entries()].sort()) {
    const { name } = split(key)
    describe(name, 'counter', HELP[name] ?? 'A counter.')
    lines.push(`${key} ${value}`)
  }

  for (const [key, value] of [...gauges.entries()].sort()) {
    const { name } = split(key)
    describe(name, 'gauge', HELP[name] ?? 'A gauge.')
    lines.push(`${key} ${value}`)
  }

  for (const [key, histogram] of [...histograms.entries()].sort()) {
    const { name, labels } = split(key)
    describe(name, 'histogram', HELP[name] ?? 'A histogram.')

    let cumulative = 0
    for (let index = 0; index < histogram.buckets.length; index += 1) {
      cumulative += histogram.counts[index] ?? 0
      lines.push(`${name}_bucket${withLabel(labels, 'le', String(histogram.buckets[index]))} ${cumulative}`)
    }

    // The overflow bucket. Required: a histogram without `+Inf` is one a
    // scraper reports as malformed rather than as missing a bucket.
    cumulative += histogram.counts[histogram.buckets.length] ?? 0
    lines.push(`${name}_bucket${withLabel(labels, 'le', '+Inf')} ${cumulative}`)
    lines.push(`${name}_sum${labels} ${histogram.sum}`)
    lines.push(`${name}_count${labels} ${histogram.count}`)
  }

  return `${lines.join('\n')}\n`
}

/** What each metric means, for the `HELP` line. */
const HELP: Record<string, string> = {
  reviewos_http_requests_total: 'HTTP requests, by method and status class.',
  reviewos_http_request_seconds: 'How long HTTP requests took.',
  reviewos_git_operation_seconds: 'How long git operations took, by operation.',
  reviewos_queue_depth: 'Jobs waiting in the queue.',
  reviewos_queue_oldest_seconds: 'How long the oldest queued job has waited. A number that keeps climbing means no worker is running.',
  reviewos_repositories_total: 'Repositories on this instance.',
  reviewos_users_total: 'Accounts on this instance.',

  /*
   * The fleet, which is the whole interface an autoscaler needs.
   *
   * Three numbers per queue answer the only question a scaler asks: is there
   * work nobody is doing, and are there machines doing nothing. Everything
   * else it might want - how long a job takes, which repository it belongs
   * to - is a decision it should not be making.
   */
  reviewos_ci_jobs_waiting: 'CI jobs queued and not yet claimed, by queue. The number an autoscaler scales on.',
  reviewos_ci_jobs_running: 'CI jobs a runner is currently holding, by queue.',
  reviewos_ci_jobs_oldest_waiting_seconds: 'How long the oldest unclaimed CI job has waited, by queue. Climbing while runners is zero means nothing is coming.',
  reviewos_ci_runners: 'Runners by queue and lifecycle: idle, running, stopping, lost, disabled, never-seen.',
}

/**
 * The numbers that come from the database rather than from counting requests.
 *
 * Read at scrape time rather than kept current, because they change slowly and
 * a scrape is the only moment anybody wants them. Keeping them live would mean
 * a write on every push to answer a question asked every fifteen seconds.
 */
export async function collectFromDatabase(): Promise<void> {

  try {
    const queued = await db.selectFrom('jobs').select(db.fn.count('id').as('count')).executeTakeFirst()
    gauge('reviewos_queue_depth', Number(queued?.count ?? 0))

    const oldest = await db
      .selectFrom('jobs')
      .select(['created_at'])
      .orderBy('created_at', 'asc')
      .limit(1)
      .executeTakeFirst()

    gauge(
      'reviewos_queue_oldest_seconds',
      oldest?.created_at ? Math.max(0, Math.round((Date.now() - Date.parse(String(oldest.created_at))) / 1000)) : 0,
    )

    const repositories = await db.selectFrom('repositories').select(db.fn.count('id').as('count')).executeTakeFirst()
    gauge('reviewos_repositories_total', Number(repositories?.count ?? 0))

    const users = await db.selectFrom('users').select(db.fn.count('id').as('count')).executeTakeFirst()
    gauge('reviewos_users_total', Number(users?.count ?? 0))

    await collectFleet()
  }
  catch {
    /*
     * A scrape that cannot reach the database returns what it has rather than
     * failing. Metrics are how somebody finds out the database is unreachable,
     * and an endpoint that 500s in that case removes the instrument at the
     * moment it is needed - `/api/health` is where that fact belongs.
     */
  }
}

/** For tests, which need to count from zero. */
export function resetMetrics(): void {
  counters.clear()
  gauges.clear()
  histograms.clear()
}

export function snapshot(): Snapshot {
  return {
    counters: Object.fromEntries(counters),
    gauges: Object.fromEntries(gauges),
    histograms: Object.fromEntries(
      [...histograms.entries()].map(([key, value]) => [key, {
        buckets: Object.fromEntries(value.buckets.map((bound, index) => [String(bound), value.counts[index] ?? 0])),
        sum: value.sum,
        count: value.count,
      }]),
    ),
  }
}

/** `name{label="value"}`, with the labels sorted so one series has one key. */
function seriesKey(name: string, labels: Record<string, string>): string {
  const entries = Object.entries(labels).filter(([, value]) => value !== undefined && value !== '')

  if (entries.length === 0)
    return name

  const rendered = entries
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([key, value]) => `${key}="${escape(value)}"`)
    .join(',')

  return `${name}{${rendered}}`
}

function split(key: string): { name: string, labels: string } {
  const brace = key.indexOf('{')

  return brace === -1 ? { name: key, labels: '' } : { name: key.slice(0, brace), labels: key.slice(brace) }
}

/** Add one more label to an existing rendered label set. */
function withLabel(labels: string, name: string, value: string): string {
  const pair = `${name}="${escape(value)}"`

  return labels ? `${labels.slice(0, -1)},${pair}}` : `{${pair}}`
}

/**
 * Escape a label value.
 *
 * A repository name reaches these, and a quote or a newline in one would
 * produce a scrape the collector rejects wholesale - so one bad name would
 * take every metric with it.
 */
function escape(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')
}

/**
 * The fleet, by queue: work waiting, work running, and machines by lifecycle.
 *
 * **This is the autoscaler contract.** Everything a scaler needs is here and
 * nothing else is: how much work nobody is doing, how long the oldest of it has
 * waited, and how many machines are in each state. A scaler that needed more
 * than this would be making decisions that belong to the instance.
 *
 * Every queue is emitted even at zero, including the `unassigned` pseudo-queue
 * for machines nobody has put in one. A gauge that disappears when it reaches
 * zero is how an autoscaler concludes there is no work when what actually
 * happened is that the series stopped being reported.
 */
async function collectFleet(): Promise<void> {
  const queues = await db.selectFrom('runner_queues').select(['id', 'name']).execute()
  const runners = await db
    .selectFrom('runners')
    .select(['id', 'state', 'labels', 'runner_queue_id', 'last_seen_at', 'stop_requested'])
    .execute()

  const jobs = await db
    .selectFrom('workflow_jobs')
    .select(['id', 'state', 'runs_on', 'runner_id', 'lease_expires_at', 'created_at'])
    .where('state', 'in', ['queued', 'running'])
    .execute()

  const { runnerLifecycle } = await import('../Actions/Runner/fleet')

  const named = [...queues.map(queue => ({ id: Number(queue.id), name: String(queue.name) })), { id: 0, name: 'unassigned' }]
  const now = Date.now()

  for (const queue of named) {
    const machines = runners.filter(runner => Number(runner.runner_queue_id ?? 0) === queue.id)

    /*
     * Work is attributed to a queue by the labels its machines answer to,
     * which is how the claim decides. A queue with no machines has no labels
     * and therefore no work, which is correct and is also exactly the case an
     * autoscaler is being asked to fix - so the unassigned bucket carries the
     * jobs nothing matches, rather than them vanishing.
     */
    const labels = new Set(machines.flatMap(runner => String(runner.labels ?? '').split('\n').map(line => line.trim()).filter(Boolean)))

    const mine = jobs.filter((job) => {
      const wanted = String(job.runs_on ?? '').split('\n').map(line => line.trim()).filter(Boolean)

      if (queue.id === 0)
        return wanted.length === 0 || !wanted.every(label => anyQueueHas(runners, label))

      return wanted.length > 0 && wanted.every(label => labels.has(label))
    })

    const waiting = mine.filter(job => String(job.state) === 'queued')
    const running = mine.filter(job => String(job.state) === 'running')

    gauge('reviewos_ci_jobs_waiting', waiting.length, { queue: queue.name })
    gauge('reviewos_ci_jobs_running', running.length, { queue: queue.name })

    const oldest = waiting
      .map(job => (job.created_at ? Date.parse(String(job.created_at)) : Number.NaN))
      .filter(at => Number.isFinite(at))
      .sort((one, two) => one - two)[0]

    gauge(
      'reviewos_ci_jobs_oldest_waiting_seconds',
      oldest === undefined ? 0 : Math.max(0, Math.round((now - oldest) / 1000)),
      { queue: queue.name },
    )

    const held = jobs.filter(job => String(job.state) === 'running')

    for (const lifecycle of ['idle', 'running', 'stopping', 'lost', 'disabled', 'never-seen']) {
      const count = machines.filter((runner) => {
        const holding = held.find(job => String(job.runner_id ?? '') === String(runner.id))
        const lease = holding?.lease_expires_at ? Date.parse(String(holding.lease_expires_at)) : Number.NaN

        return runnerLifecycle({
          state: String(runner.state),
          lastSeenAt: runner.last_seen_at ? String(runner.last_seen_at) : null,
          stopRequested: runner.stop_requested ? String(runner.stop_requested) : null,
          holdsJob: Boolean(holding),
          leaseLapsed: Boolean(holding) && Number.isFinite(lease) && lease <= now,
        }, new Date(now)) === lifecycle
      }).length

      // Emitted at zero too: a series that disappears is how a scaler decides
      // there are no runners when what happened is that nobody reported any.
      gauge('reviewos_ci_runners', count, { queue: queue.name, lifecycle })
    }
  }
}

/** Whether any runner anywhere answers to this label. */
function anyQueueHas(runners: readonly any[], label: string): boolean {
  return runners.some(runner => String(runner.labels ?? '')
    .split('\n')
    .map(line => line.trim())
    .includes(label))
}

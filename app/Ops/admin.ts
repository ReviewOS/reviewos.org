import { db } from '@stacksjs/database'
/**
 * What an instance administrator needs to see and do.
 *
 * The reads are here and pure over the database; the endpoint is a thin shell
 * over them. That split exists because every one of these queries counts
 * something, and a count that is subtly wrong on an administration page is
 * worse than no page: it is a number somebody plans around.
 *
 * ## Nothing here is a product surface
 *
 * An administrator sees across every organization and every private repository
 * by definition, so each function is written on the assumption that the caller
 * has already been checked. There is exactly one check, in the action, and no
 * function here does its own - two places to get it right is one place to get
 * it wrong.
 */

export interface InstanceStats {
  users: number
  admins: number
  organizations: number
  repositories: { total: number, private: number, public: number }
  pullRequests: { open: number, merged: number }
  queue: { pending: number, failed: number, oldestPendingSeconds: number | null }
  /** Bytes on disk, as the size accounting recorded it. Null when never measured. */
  repositoryBytes: number | null
}

/** Every number the overview shows, in as few queries as it can manage. */
export async function instanceStats(): Promise<InstanceStats> {

  const count = async (table: string, apply?: (query: any) => any): Promise<number> => {
    try {
      let query = db.selectFrom(table).select(db.fn.count('id').as('n'))

      if (apply)
        query = apply(query)

      const row: any = await query.executeTakeFirst()

      return Number(row?.n ?? 0)
    }
    catch {
      /*
       * A missing table reads as zero rather than throwing.
       *
       * This page is most useful when something is wrong, which is exactly when
       * a table might be missing - an instance mid-migration, or one whose
       * queue driver was never set up. A stack trace instead of a dashboard at
       * that moment helps nobody.
       */
      return 0
    }
  }

  const [users, admins, organizations, repositories, privateRepositories, open, merged, pending, failed] = await Promise.all([
    count('users'),
    count('users', query => query.where('is_admin', '=', true)),
    count('organizations'),
    count('repositories'),
    count('repositories', query => query.where('visibility', '=', 'private')),
    count('pull_requests', query => query.where('state', '=', 'open')),
    count('pull_requests', query => query.where('state', '=', 'merged')),
    count('jobs'),
    count('failed_jobs'),
  ])

  return {
    users,
    admins,
    organizations,
    repositories: { total: repositories, private: privateRepositories, public: repositories - privateRepositories },
    pullRequests: { open, merged },
    queue: { pending, failed, oldestPendingSeconds: await oldestPending() },
    repositoryBytes: await totalRepositoryBytes(),
  }
}

/**
 * How long the oldest queued job has been waiting.
 *
 * The number that says whether a worker is running, which "how many are
 * pending" does not: a thousand jobs queued a second ago is a busy instance and
 * three queued yesterday is a stopped worker. The health endpoint judges this
 * too; the difference is that this one is a number on a page rather than a
 * verdict.
 */
async function oldestPending(): Promise<number | null> {

  try {
    const row = await db
      .selectFrom('jobs')
      .select(['created_at'])
      .orderBy('created_at', 'asc')
      .executeTakeFirst()

    if (!row?.created_at)
      return null

    const created = Date.parse(String(row.created_at))

    return Number.isFinite(created) ? Math.max(0, Math.round((Date.now() - created) / 1000)) : null
  }
  catch {
    return null
  }
}

/** What the repositories add up to, from the sizes already recorded per row. */
async function totalRepositoryBytes(): Promise<number | null> {

  try {
    const rows = await db.selectFrom('repositories').select(['size_kb']).execute()
    const kb = rows.reduce((total, row) => total + (Number(row.size_kb) || 0), 0)

    return kb > 0 ? kb * 1024 : null
  }
  catch {
    return null
  }
}

export interface AdminUser {
  id: number
  handle: string
  name: string | null
  email: string | null
  is_admin: boolean
  two_factor_enabled: boolean
  created_at: string | null
}

/**
 * People, newest first, optionally narrowed by a search.
 *
 * Searched on handle and email together, because an administrator looking
 * somebody up has one or the other and rarely knows which the account was made
 * with. Case-insensitive and substring, since the usual query is half a name
 * remembered from a support message.
 */
export async function adminUsers(search: string, limit = 50): Promise<AdminUser[]> {
  const term = String(search ?? '').trim().toLowerCase()

  try {
    let query = db
      .selectFrom('users')
      .select(['id', 'handle', 'name', 'email', 'is_admin', 'two_factor_enabled', 'created_at'])

    if (term)
      query = query.where('handle', 'like', `%${term}%`)

    const rows: any[] = await query.orderBy('id', 'desc').limit(Math.min(Math.max(1, limit), 200)).execute()

    return rows.map(shapeUser)
  }
  catch {
    return []
  }
}

function shapeUser(row: any): AdminUser {
  return {
    id: Number(row.id),
    handle: String(row.handle ?? ''),
    name: row.name ? String(row.name) : null,
    email: row.email ? String(row.email) : null,
    is_admin: Boolean(row.is_admin),
    two_factor_enabled: Boolean(row.two_factor_enabled),
    created_at: row.created_at ? String(row.created_at) : null,
  }
}

export interface AdminRepository {
  id: number
  owner: string
  name: string
  visibility: string
  size_kb: number
  open_issues_count: number
  pushed_at: string | null
}

/**
 * Repositories, largest first.
 *
 * Largest rather than newest, because the question an administrator brings to
 * this list is nearly always about disk: what is taking the space, and can it
 * go. A list ordered by creation answers a question nobody asks of an
 * administration page.
 */
export async function adminRepositories(limit = 50): Promise<AdminRepository[]> {

  try {
    const rows = await db
      .selectFrom('repositories')
      .select(['id', 'name', 'owner_type', 'owner_id', 'visibility', 'size_kb', 'open_issues_count', 'pushed_at'])
      .orderBy('size_kb', 'desc')
      .limit(Math.min(Math.max(1, limit), 200))
      .execute()

    const owners = await ownerHandles(rows)

    return rows.map(row => ({
      id: Number(row.id),
      owner: owners.get(`${row.owner_type}:${row.owner_id}`) ?? String(row.owner_id),
      name: String(row.name ?? ''),
      visibility: String(row.visibility ?? ''),
      size_kb: Number(row.size_kb) || 0,
      open_issues_count: Number(row.open_issues_count) || 0,
      pushed_at: row.pushed_at ? String(row.pushed_at) : null,
    }))
  }
  catch {
    return []
  }
}

/**
 * Handles for a page of repositories, in two queries rather than one per row.
 *
 * The polymorphic owner is why: there is no join that reaches both tables, so
 * the choice is a query per repository or two queries for the page. Fifty of
 * the former on a page that exists to be glanced at is the kind of thing that
 * makes an administration screen the slowest page in a product.
 */
async function ownerHandles(rows: any[]): Promise<Map<string, string>> {
  const handles = new Map<string, string>()

  const ids = (type: string) => [...new Set(rows.filter(row => row.owner_type === type).map(row => Number(row.owner_id)))]

  for (const [type, table] of [['user', 'users'], ['organization', 'organizations']] as const) {
    const wanted = ids(type)

    if (wanted.length === 0)
      continue

    try {
      const found = await db.selectFrom(table).select(['id', 'handle']).where('id', 'in', wanted).execute()

      for (const row of found)
        handles.set(`${type}:${row.id}`, String(row.handle))
    }
    catch {
      // A page with an id where a handle should be is still a usable page.
    }
  }

  return handles
}

export interface FailedJobRow {
  id: number
  queue: string
  /** The job class, pulled out of the payload so the list is readable. */
  job: string
  /** The first line of the exception, which is the part somebody scans for. */
  reason: string
  failed_at: string | null
}

/** What has failed, newest first. */
export async function failedJobs(limit = 50): Promise<FailedJobRow[]> {

  try {
    const rows = await db
      .selectFrom('failed_jobs')
      .select(['id', 'queue', 'payload', 'exception', 'failed_at'])
      .orderBy('id', 'desc')
      .limit(Math.min(Math.max(1, limit), 200))
      .execute()

    return rows.map(row => ({
      id: Number(row.id),
      queue: String(row.queue ?? 'default'),
      job: jobNameOf(row.payload),
      // The first line only. A stack trace in a table cell makes the table
      // unreadable, and the first line is what somebody scans down the column
      // looking for the one that is different.
      reason: String(row.exception ?? '').split('\n')[0]?.slice(0, 200) ?? '',
      failed_at: row.failed_at ? String(row.failed_at) : null,
    }))
  }
  catch {
    return []
  }
}

/** The job's name out of its envelope, or something honest when it is not there. */
function jobNameOf(payload: unknown): string {
  try {
    const parsed = typeof payload === 'string' ? JSON.parse(payload) : payload

    return String((parsed as any)?.name ?? (parsed as any)?.job ?? (parsed as any)?.displayName ?? 'unknown')
  }
  catch {
    return 'unparseable'
  }
}

/**
 * Put a failed job back on the queue.
 *
 * The original payload, moved rather than copied: a retry that left the row
 * behind would show the same failure on the page forever, and an operator
 * retrying a list would work through it without it ever getting shorter.
 *
 * Returns false when there is no such row, which is what a second click on the
 * same button looks like.
 */
export async function retryFailedJob(id: number): Promise<boolean> {

  try {
    const row = await db
      .selectFrom('failed_jobs')
      .select(['id', 'queue', 'payload'])
      .where('id', '=', id)
      .executeTakeFirst()

    if (!row)
      return false

    await db.insertInto('jobs').values({
      queue: String(row.queue ?? 'default'),
      payload: String(row.payload ?? '{}'),
      // Attempts reset. The retry is a deliberate act by a person who has read
      // the exception, and starting it one attempt from the dead-letter table
      // would mean a single transient failure sends it straight back.
      attempts: 0,
      /*
       * Epoch **seconds**, because that is what the column is.
       *
       * `jobs.available_at` is an integer, and an ISO string here is refused by
       * Postgres - which the first version of this swallowed and reported as
       * "there was no such job". The same shape of bug as
       * `token_usage_windows.window_started_ms` earlier in this codebase: a
       * timestamp written into an integer column, hidden by a catch that
       * treated failure as an ordinary answer.
       */
      available_at: Math.floor(Date.now() / 1000),
    }).execute()

    await db.deleteFrom('failed_jobs').where('id', '=', id).execute()

    return true
  }
  catch (error) {
    /*
     * Logged, not silent.
     *
     * This returned a bare `false` and that is how the integer column above
     * went unnoticed: a retry that threw looked exactly like a retry of a job
     * that was not there, and both answer "nothing happened" on the page.
     */
    console.error(`[admin] could not retry job ${id}:`, error)

    return false
  }
}

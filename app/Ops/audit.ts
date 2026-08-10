/**
 * Reading the audit log.
 *
 * Writing it is `app/Actions/Git/audit.ts`, deliberately one function so every
 * event reaches the table the same way. This is the other half, and it exists
 * because a log nobody can search is a log nobody reads: the question is always
 * asked after something has already gone wrong, by somebody who knows roughly
 * *when* and roughly *who* and needs the rest.
 *
 * ## Scope is the interesting part
 *
 * **An organization owner reads their own organization's log.** Not the
 * instance's - that would hand anybody who can create an organization a window
 * onto everybody else - and not nothing, which is the usual arrangement and the
 * reason people ask an administrator to grep for them.
 *
 * That is why `organization_id` and `repository_id` are columns rather than
 * something derived from the polymorphic subject: the scope check is a `WHERE`,
 * and a scope check that cannot be a `WHERE` is one that gets done in the
 * application after loading everything, or not at all.
 *
 * ## Distinct from the activity feed
 *
 * The feed is a product surface and hides what you cannot see. This is a record
 * and hides nothing from an owner: an event about a private repository appears
 * in that repository's owner's log whether or not the reader could open the
 * repository page. They are different questions, and conflating them makes the
 * audit log useless for the one thing it is for.
 */

export interface AuditQuery {
  /** Instance-wide, or one organization's. */
  scope: { kind: 'instance' } | { kind: 'organization', organizationId: number }
  actorId?: number | null
  repositoryId?: number | null
  action?: string | null
  /** ISO timestamps. Inclusive at both ends, which is what a person means by a range. */
  since?: string | null
  until?: string | null
  limit?: number
  /** Keyset cursor: the id of the last row of the previous page. */
  before?: number | null
}

export interface AuditRow {
  id: number
  uuid: string | null
  action: string
  subject_type: string | null
  subject_id: number | null
  actor_id: number | null
  access_token_id: number | null
  organization_id: number | null
  repository_id: number | null
  external_actor: string | null
  user_agent: string | null
  ip_address: string | null
  reason: string | null
  detail: unknown
  created_at: string | null
}

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 500

/**
 * Search the log.
 *
 * Newest first, because the question is nearly always "what just happened".
 * Paged by id rather than by offset for the reason `app/Api/cursor.ts` sets out
 * at length: this table is being written to while somebody reads it, and offset
 * paging over a table being written to silently skips rows.
 */
export async function searchAudit(query: AuditQuery): Promise<{ rows: AuditRow[], next: number | null }> {
  const db = (globalThis as any).db
  const limit = Math.min(Math.max(1, Math.floor(query.limit ?? DEFAULT_LIMIT)), MAX_LIMIT)

  let builder = db.selectFrom('audit_events').selectAll()

  /*
   * The scope first, always, and not as one filter among several.
   *
   * Written before anything the caller asked for so that a future filter added
   * below cannot accidentally be applied *instead* of it - the failure mode
   * being an organization owner reading the whole instance because somebody
   * reordered a chain.
   */
  if (query.scope.kind === 'organization')
    builder = builder.where('organization_id', '=', query.scope.organizationId)

  if (query.actorId)
    builder = builder.where('actor_id', '=', query.actorId)

  if (query.repositoryId)
    builder = builder.where('repository_id', '=', query.repositoryId)

  if (query.action)
    builder = builder.where('action', '=', query.action)

  /*
   * The bounds, moved into the frame the column is stored in.
   *
   * See `databaseOffset`: `created_at` holds the *database's* wall clock, so a
   * caller's genuine ISO instant has to be moved into that frame before it can
   * be compared. Zero on a UTC deployment.
   */
  const offsetMs = query.since || query.until ? await databaseOffset() : 0

  if (query.since)
    builder = builder.where('created_at', '>=', shift(query.since, offsetMs))

  if (query.until)
    builder = builder.where('created_at', '<=', shift(query.until, offsetMs))

  if (query.before)
    builder = builder.where('id', '<', query.before)

  // One more than asked for, to know whether there is a next page without a
  // `COUNT` over a table that only grows.
  const rows: any[] = await builder.orderBy('id', 'desc').limit(limit + 1).execute()

  const page = rows.slice(0, limit)
  const last = page[page.length - 1]

  return {
    rows: page.map(shape),
    next: rows.length > limit && last ? Number(last.id) : null,
  }
}

/**
 * The log as JSON lines.
 *
 * One object per line, so it streams, so `grep` works on it, and so an import
 * into anything else is a loop rather than a parser. A single JSON array would
 * have to be built in memory and read the same way, which for the one table
 * that only grows is the wrong shape.
 *
 * Returns an async generator rather than a string: an instance with a year of
 * history should be able to export it without holding it all at once.
 */
export async function* exportAudit(query: AuditQuery, batch = 500): AsyncGenerator<string> {
  let before = query.before ?? null

  while (true) {
    const page = await searchAudit({ ...query, limit: batch, before })

    for (const row of page.rows)
      yield `${JSON.stringify(row)}\n`

    if (!page.next)
      return

    before = page.next
  }
}

/**
 * Whether this reader may read this scope.
 *
 * Two answers only, and deliberately not a third: an instance administrator
 * reads everything, an organization owner reads their own organization, and
 * everybody else reads nothing. A "read your own actions" tier sounds
 * reasonable and is not - it lets somebody confirm what was recorded about
 * them, which is exactly the thing an audit log must not offer to the person it
 * is recording.
 */
export async function mayReadAudit(
  user: { id: number, is_admin?: boolean } | null,
  scope: AuditQuery['scope'],
): Promise<boolean> {
  if (!user)
    return false

  if (user.is_admin)
    return true

  if (scope.kind === 'instance')
    return false

  const db = (globalThis as any).db

  try {
    const membership: any = await db
      .selectFrom('org_members')
      .select(['role'])
      .where('organization_id', '=', scope.organizationId)
      .where('user_id', '=', user.id)
      .executeTakeFirst()

    return String(membership?.role ?? '') === 'owner'
  }
  catch {
    // A missing table or a failed query is not permission. The safe direction
    // here is the only direction.
    return false
  }
}

/**
 * An ISO instant, moved into the frame `created_at` is actually stored in.
 *
 * **`created_at` is the database's wall clock**, filled by `CURRENT_TIMESTAMP`
 * into a `timestamp` without a zone. A caller passes a genuine ISO instant. On
 * a UTC deployment - which the compose file produces - those agree and this
 * does nothing; on a database running in a local timezone they differ by the
 * offset, and the comparison silently returns *nothing*.
 *
 * Nothing is the worst possible answer here. An empty audit search reads as "it
 * did not happen", which is exactly the conclusion this table exists to stop
 * somebody reaching by accident.
 *
 * The offset is the **database's**, not this process's, and the two are the
 * same only by convention - the test suite runs in UTC against a Postgres in
 * Pacific, which is precisely the case a naive `getTimezoneOffset()` gets
 * wrong. So it is measured rather than assumed: `LOCALTIMESTAMP` is the same
 * clock the column default reads, and the driver hands it back labelled UTC,
 * so the difference from a real instant is the offset.
 *
 * The alternative - rewriting how every table in this application stores a
 * timestamp - is a change with no business being bundled into an audit search.
 */
let databaseOffsetMs: number | null = null

async function databaseOffset(): Promise<number> {
  if (databaseOffsetMs !== null)
    return databaseOffsetMs

  try {
    const { sql } = await import('bun')
    const before = Date.now()
    const rows: any = await sql`SELECT LOCALTIMESTAMP AS wall`
    const wall = Date.parse(String(rows?.[0]?.wall ?? ''))

    databaseOffsetMs = Number.isFinite(wall)
      // Rounded to the quarter hour: what is being measured is a timezone, and
      // the remainder is the round trip. Quarter hours rather than hours
      // because several real zones are offset by 30 or 45 minutes.
      ? Math.round((wall - before) / 900_000) * 900_000
      : 0
  }
  catch {
    // A database that will not answer this will not answer the search either.
    // Zero is correct for the UTC case rather than a guess.
    databaseOffsetMs = 0
  }

  return databaseOffsetMs
}

function shift(iso: string, offsetMs: number): string {
  const parsed = Date.parse(iso)

  // Not a date is passed through rather than turned into 1970: the database
  // refusing it is a clearer failure than silently searching the Nixon era.
  if (!Number.isFinite(parsed))
    return iso

  return new Date(parsed + offsetMs).toISOString()
}

/** For tests, and for a process that outlives a timezone change. */
export function resetDatabaseOffset(): void {
  databaseOffsetMs = null
}

/** One row, with `detail` parsed back into something a reader can use. */
function shape(row: any): AuditRow {
  let detail: unknown = null

  if (row.detail) {
    try {
      detail = JSON.parse(String(row.detail))
    }
    catch {
      // Written before `recordAudit` serialised everything, or written by hand.
      // Kept as the string it is rather than dropped: an audit row is evidence,
      // and evidence that does not parse is still evidence.
      detail = String(row.detail)
    }
  }

  return {
    id: Number(row.id),
    uuid: row.uuid ? String(row.uuid) : null,
    action: String(row.action ?? ''),
    subject_type: row.subject_type ? String(row.subject_type) : null,
    subject_id: row.subject_id === null || row.subject_id === undefined ? null : Number(row.subject_id),
    actor_id: row.actor_id === null || row.actor_id === undefined ? null : Number(row.actor_id),
    access_token_id: row.access_token_id === null || row.access_token_id === undefined ? null : Number(row.access_token_id),
    organization_id: row.organization_id === null || row.organization_id === undefined ? null : Number(row.organization_id),
    repository_id: row.repository_id === null || row.repository_id === undefined ? null : Number(row.repository_id),
    external_actor: row.external_actor ? String(row.external_actor) : null,
    user_agent: row.user_agent ? String(row.user_agent) : null,
    ip_address: row.ip_address ? String(row.ip_address) : null,
    reason: row.reason ? String(row.reason) : null,
    detail,
    created_at: row.created_at ? String(row.created_at) : null,
  }
}

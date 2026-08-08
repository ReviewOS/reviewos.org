/**
 * What a repository looks like in the index.
 *
 * Called by the `useSearch` trait on the model, through `shapeMany`. The model
 * is where the index belongs - it is the thing being indexed, and a projection
 * that lives anywhere else is one the next person has to go looking for.
 *
 * `shapeMany` and not `shape`, because the two fields that make this corpus
 * worth searching - the owner's handle and the topics - are relations. `shape`
 * is per row, so denormalizing a relation through it costs a query per row and
 * turns a rebuild into thousands of round trips. The batch form takes the whole
 * chunk: one query for the owners in it, one for the topics, however large it
 * is. That form did not exist until this needed it, and was added to Stacks
 * rather than worked around here.
 *
 * **The document is deliberately small.** The trait's default projection put
 * all twenty-one columns in: `disk_path`, `allow_squash_merge`,
 * `delete_branch_on_merge`, `issue_counter`. Nobody searches those, they cost
 * index size and write time on every push, and `disk_path` in particular is
 * server filesystem layout that has no business in a search corpus. What is
 * here is what somebody types, what the result has to show, and what the
 * ranking sorts by.
 *
 * `visibility` is carried, and it is *not* a permission boundary - see
 * `visibility.ts` for why the index is never trusted for that. It is here so a
 * future query can narrow the candidate set cheaply before the real check runs,
 * which is an optimisation and never the guard.
 */

import { db } from '@stacksjs/database'

/** The index a repository document lives in. Matches the model's table. */
export const REPOSITORY_INDEX = 'repositories'

export interface RepositoryDocument {
  id: string
  name: string
  /** `owner/name`, which is how people say a repository out loud. */
  full_name: string
  owner: string
  description: string
  topics: string[]
  visibility: string
  stars_count: number
  is_fork: boolean
  is_archived: boolean
  /** Seconds, because Typesense sorts numbers and not ISO strings. */
  pushed_at: number
  updated_at: number
}

interface RepositoryRow {
  id: number
  name: string
  description: string | null
  visibility: string
  owner_type: string
  owner_id: number
  stars_count: number | null
  is_fork: boolean | null
  is_archived: boolean | null
  pushed_at: string | null
  updated_at: string | null
}

function seconds(value: unknown): number {
  if (value === null || value === undefined || value === '')
    return 0

  const parsed = Date.parse(String(value))

  return Number.isNaN(parsed) ? 0 : Math.floor(parsed / 1000)
}

/**
 * Turn a batch of repository rows into documents.
 *
 * Takes the whole batch so the relation lookups are two queries rather than two
 * per row. A caller with one repository passes an array of one and pays for two
 * queries, which is the same as it would have cost anyway.
 */
export async function repositoryDocuments(input: readonly any[]): Promise<RepositoryDocument[]> {
  if (input.length === 0)
    return []

  // Plain rows from a hand-written query, or model instances from
  // `makeAllSearchable`. The trait hands over whatever the ORM was holding, and
  // an instance keeps its columns on `_attributes` rather than on itself - so
  // reading `row.name` off one yields undefined and indexes a corpus of
  // "undefined", which is exactly what the first run of this produced.
  const rows = input.map((row: any) =>
    (row?._attributes ?? (typeof row?.toJSON === 'function' ? row.toJSON() : row)) as RepositoryRow,
  )

  const ids = rows.map(row => Number(row.id))

  // Handles for every owner in the batch, in two queries rather than one per
  // row. Users and organizations are separate tables and a repository points at
  // one of them, so both are read and matched on `owner_type` below.
  const userIds = rows.filter(row => String(row.owner_type) === 'user').map(row => Number(row.owner_id))
  const orgIds = rows.filter(row => String(row.owner_type) === 'organization').map(row => Number(row.owner_id))

  const users = userIds.length > 0
    ? await db.selectFrom('users').select(['id', 'handle']).where('id', 'in', [...new Set(userIds)]).execute()
    : []

  const organizations = orgIds.length > 0
    ? await db.selectFrom('organizations').select(['id', 'handle']).where('id', 'in', [...new Set(orgIds)]).execute()
    : []

  const userHandles = new Map(users.map((row: any) => [Number(row.id), String(row.handle)]))
  const orgHandles = new Map(organizations.map((row: any) => [Number(row.id), String(row.handle)]))

  const topicRows = await db
    .selectFrom('repo_topics')
    .select(['repository_id', 'topic'])
    .where('repository_id', 'in', ids)
    .execute()

  const topics = new Map<number, string[]>()
  for (const row of topicRows as any[]) {
    const key = Number(row.repository_id)
    const list = topics.get(key) ?? []
    list.push(String(row.topic))
    topics.set(key, list)
  }

  return rows.map((row) => {
    const ownerId = Number(row.owner_id)
    const owner = String(row.owner_type) === 'organization'
      ? orgHandles.get(ownerId) ?? ''
      : userHandles.get(ownerId) ?? ''

    const name = String(row.name)

    return {
      // A string, because Typesense treats `id` as the document key and wants
      // it that way. Everything else that needs the number reads it back.
      id: String(row.id),
      name,
      full_name: owner ? `${owner}/${name}` : name,
      owner,
      description: String(row.description ?? ''),
      topics: topics.get(Number(row.id)) ?? [],
      visibility: String(row.visibility),
      stars_count: Number(row.stars_count ?? 0),
      is_fork: Boolean(row.is_fork),
      is_archived: Boolean(row.is_archived),
      pushed_at: seconds(row.pushed_at),
      updated_at: seconds(row.updated_at),
    }
  })
}

/** The rows this projection needs, for callers assembling their own query. */
export const REPOSITORY_COLUMNS = [
  'id',
  'name',
  'description',
  'visibility',
  'owner_type',
  'owner_id',
  'stars_count',
  'is_fork',
  'is_archived',
  'pushed_at',
  'updated_at',
] as const

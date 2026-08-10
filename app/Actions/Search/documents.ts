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

  /*
   * Annotated, because an inferred `Map` from an array of pairs is not the map
   * it looks like.
   *
   * `rows.map(row => [a, b])` infers `(number | string)[]`, not a tuple, so the
   * `Map` comes out with a value type of `{}` - and the document's `owner`
   * field, which is a string, is then unassignable. The map is what the
   * annotation says it is; the inference just cannot see it.
   */
  const userHandles = new Map<number, string>(users.map((row: any) => [Number(row.id), String(row.handle)]))
  const orgHandles = new Map<number, string>(organizations.map((row: any) => [Number(row.id), String(row.handle)]))

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

/** The index an issue document lives in. Matches the model's table. */
export const ISSUE_INDEX = 'issues'

/**
 * An issue, as the index holds it.
 *
 * `repository_id` is carried and it is the field that matters most here, for a
 * reason that is not about searching: an issue is readable exactly when its
 * repository is, so every hit has to be traceable back to a repository before
 * `visibility.ts` can rule on it. A document without it could not be filtered
 * at all, and the fallback would be a query per hit.
 *
 * `author` and `labels` are denormalized for the same reason the repository
 * document carries the owner handle - `author:me` and `label:bug` are the
 * qualifiers people actually type, and resolving them per hit at query time is
 * the N+1 this whole approach exists to avoid.
 *
 * The body is indexed but truncated. Search wants the words; nobody scrolls a
 * result, and a forty-kilobyte issue body in the index costs write time on
 * every edit and buys nothing a first paragraph does not.
 */
export interface IssueDocument {
  id: string
  repository_id: number
  repository: string
  number: number
  title: string
  body: string
  author: string
  labels: string[]
  state: string
  is_pull_request: boolean
  comments_count: number
  created_at: number
  updated_at: number
}

/** How much of a body is worth indexing. */
const BODY_LIMIT = 4000

export async function issueDocuments(input: readonly any[]): Promise<IssueDocument[]> {
  if (input.length === 0)
    return []

  const rows = input.map((row: any) =>
    (row?._attributes ?? (typeof row?.toJSON === 'function' ? row.toJSON() : row)) as any,
  )

  const ids = rows.map(row => Number(row.id))
  const repositoryIds = [...new Set(rows.map(row => Number(row.repository_id)).filter(Boolean))]
  const authorIds = [...new Set(rows.map(row => Number(row.author_id)).filter(Boolean))]

  // The repository's full name, so a result can say where it lives without the
  // page joining back per row.
  const repositories = repositoryIds.length > 0
    ? await db
        .selectFrom('repositories')
        .select(['id', 'name', 'owner_type', 'owner_id'])
        .where('id', 'in', repositoryIds)
        .execute()
    : []

  const owners = await ownerHandles(repositories as any[])
  const repositoryNames = new Map<number, string>()
  for (const row of repositories as any[]) {
    const handle = owners.get(`${row.owner_type}:${Number(row.owner_id)}`) ?? ''
    repositoryNames.set(Number(row.id), handle ? `${handle}/${String(row.name)}` : String(row.name))
  }

  const authors = authorIds.length > 0
    ? await db.selectFrom('users').select(['id', 'handle']).where('id', 'in', authorIds).execute()
    : []
  const authorHandles = new Map((authors as any[]).map(row => [Number(row.id), String(row.handle)]))

  const labelRows = await db
    .selectFrom('issue_labels')
    .innerJoin('repository_labels', 'repository_labels.id', '=', 'issue_labels.label_id')
    .select(['issue_labels.issue_id as issue_id', 'repository_labels.name as name'])
    .where('issue_labels.issue_id', 'in', ids)
    .execute()

  const labels = new Map<number, string[]>()
  for (const row of labelRows as any[]) {
    const key = Number(row.issue_id)
    const list = labels.get(key) ?? []
    list.push(String(row.name))
    labels.set(key, list)
  }

  return rows.map(row => ({
    id: String(row.id),
    repository_id: Number(row.repository_id),
    repository: repositoryNames.get(Number(row.repository_id)) ?? '',
    number: Number(row.number ?? 0),
    title: String(row.title ?? ''),
    // An external author has no account, so the row carries the name instead.
    author: authorHandles.get(Number(row.author_id)) ?? String(row.external_author ?? ''),
    body: String(row.body ?? '').slice(0, BODY_LIMIT),
    labels: labels.get(Number(row.id)) ?? [],
    state: String(row.state ?? ''),
    is_pull_request: Boolean(row.is_pull_request),
    comments_count: Number(row.comments_count ?? 0),
    created_at: seconds(row.created_at),
    updated_at: seconds(row.updated_at),
  }))
}

/** Handles for a set of repository rows, keyed `type:id`. Two queries, not N. */
async function ownerHandles(repositories: any[]): Promise<Map<string, string>> {
  const userIds = repositories.filter(r => String(r.owner_type) === 'user').map(r => Number(r.owner_id))
  const orgIds = repositories.filter(r => String(r.owner_type) === 'organization').map(r => Number(r.owner_id))

  const users = userIds.length > 0
    ? await db.selectFrom('users').select(['id', 'handle']).where('id', 'in', [...new Set(userIds)]).execute()
    : []

  const organizations = orgIds.length > 0
    ? await db.selectFrom('organizations').select(['id', 'handle']).where('id', 'in', [...new Set(orgIds)]).execute()
    : []

  const map = new Map<string, string>()
  for (const row of users as any[])
    map.set(`user:${Number(row.id)}`, String(row.handle))
  for (const row of organizations as any[])
    map.set(`organization:${Number(row.id)}`, String(row.handle))

  return map
}

/** The issue columns the projection needs. */
export const ISSUE_COLUMNS = [
  'id',
  'repository_id',
  'number',
  'title',
  'body',
  'author_id',
  'external_author',
  'state',
  'is_pull_request',
  'comments_count',
  'created_at',
  'updated_at',
] as const

/** The index a pull request document lives in. Matches the model's table. */
export const PULL_INDEX = 'pull_requests'

/**
 * A pull request, as the index holds it.
 *
 * Its own corpus, and that is a correction rather than a preference. This
 * started out searching pull requests as issues carrying `is_pull_request`,
 * because the column exists - but nothing ever sets it, and pull requests live
 * in their own table. The scope returned an empty list for every query, and the
 * test that was supposed to cover it asserted only that issues did *not* appear,
 * which is trivially true when nothing appears at all.
 *
 * Carries `repository_id` for the same reason the issue document does: a pull
 * request is readable exactly when its repository is, and `visibility.ts` has to
 * be able to ask about the repository without a query per hit.
 *
 * `draft` and `state` are separate because they answer different questions.
 * `is:draft` is about whether it wants review; `is:open` is about whether it is
 * still live. A draft that is closed is both.
 */
export interface PullDocument {
  id: string
  repository_id: number
  repository: string
  number: number
  title: string
  body: string
  author: string
  state: string
  draft: boolean
  base_branch: string
  head_branch: string
  changed_files: number
  created_at: number
  updated_at: number
}

export async function pullDocuments(input: readonly any[]): Promise<PullDocument[]> {
  if (input.length === 0)
    return []

  const rows = input.map((row: any) =>
    (row?._attributes ?? (typeof row?.toJSON === 'function' ? row.toJSON() : row)) as any,
  )

  const repositoryIds = [...new Set(rows.map(row => Number(row.repository_id)).filter(Boolean))]
  const authorIds = [...new Set(rows.map(row => Number(row.author_id)).filter(Boolean))]

  const repositories = repositoryIds.length > 0
    ? await db
        .selectFrom('repositories')
        .select(['id', 'name', 'owner_type', 'owner_id'])
        .where('id', 'in', repositoryIds)
        .execute()
    : []

  const owners = await ownerHandles(repositories as any[])
  const repositoryNames = new Map<number, string>()
  for (const row of repositories as any[]) {
    const handle = owners.get(`${row.owner_type}:${Number(row.owner_id)}`) ?? ''
    repositoryNames.set(Number(row.id), handle ? `${handle}/${String(row.name)}` : String(row.name))
  }

  const authors = authorIds.length > 0
    ? await db.selectFrom('users').select(['id', 'handle']).where('id', 'in', authorIds).execute()
    : []
  const authorHandles = new Map((authors as any[]).map(row => [Number(row.id), String(row.handle)]))

  return rows.map(row => ({
    id: String(row.id),
    repository_id: Number(row.repository_id),
    repository: repositoryNames.get(Number(row.repository_id)) ?? '',
    number: Number(row.number ?? 0),
    title: String(row.title ?? ''),
    body: String(row.body ?? '').slice(0, BODY_LIMIT),
    author: authorHandles.get(Number(row.author_id)) ?? String(row.external_author ?? ''),
    state: String(row.state ?? ''),
    draft: Boolean(row.draft),
    base_branch: String(row.base_branch ?? ''),
    head_branch: String(row.head_branch ?? ''),
    changed_files: Number(row.changed_files ?? 0),
    created_at: seconds(row.created_at),
    updated_at: seconds(row.updated_at),
  }))
}

/** The pull request columns the projection needs. */
export const PULL_COLUMNS = [
  'id',
  'repository_id',
  'number',
  'title',
  'body',
  'author_id',
  'external_author',
  'state',
  'draft',
  'base_branch',
  'head_branch',
  'changed_files',
  'created_at',
  'updated_at',
] as const

/** The index a user document lives in. Matches the model's table. */
export const USER_INDEX = 'users'

/**
 * A person, as the index holds them.
 *
 * **This exists because the default projection indexed the whole row**, and the
 * whole row includes `password`. A password hash in a search corpus turns any
 * read of the search node into an offline cracking target that needs no further
 * access - the same reason the token hash is kept off the settings page. It also
 * carried `email`, which made every address on the instance queryable by anyone
 * who could search, and `is_admin`, which is a map of who is worth attacking.
 *
 * So the document is a deny-by-default list of four fields. Anything added to
 * the users table from now on stays out of the index until somebody names it
 * here, which is the right direction for a table that holds credentials.
 *
 * There is no visibility filter on people: an account is public on a forge, its
 * handle appears on every commit it authored, and hiding it from search while
 * showing it on a pull request would be theatre. That is a deliberate decision
 * rather than an omission, and it is why this projection is the only thing
 * standing between the users table and the index.
 */
export interface UserDocument {
  id: string
  handle: string
  name: string
  avatar_url: string
}

export async function userDocuments(input: readonly any[]): Promise<UserDocument[]> {
  if (input.length === 0)
    return []

  const rows = input.map((row: any) =>
    (row?._attributes ?? (typeof row?.toJSON === 'function' ? row.toJSON() : row)) as any,
  )

  return rows.map(row => ({
    id: String(row.id),
    handle: String(row.handle ?? ''),
    name: String(row.name ?? ''),
    avatar_url: String(row.avatar_url ?? ''),
  }))
}

/** The user columns the projection needs. Deliberately four, and no more. */
export const USER_COLUMNS = ['id', 'handle', 'name', 'avatar_url'] as const

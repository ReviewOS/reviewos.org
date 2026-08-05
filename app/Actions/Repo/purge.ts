/**
 * Running the delete plan.
 *
 * The ordering lives next door in `dependents.ts`, pure and tested. This is the
 * part that has to talk to the database: read the foreign keys it actually has,
 * find the rows that hang off one repository, and remove them deepest first.
 *
 * Ids are collected level by level rather than deleted through nested
 * subqueries: reads go through the query builder, and the deletes go through
 * `deleteWhereIn`, which exists because the builder cannot render `IN` on a
 * delete. It costs a list of integers per table, which for the largest
 * repository anybody has is measured in megabytes, once, during a delete.
 *
 * The graph is read once per delete rather than cached. A delete is rare, the
 * query is against system catalogs, and a cache is how this ends up acting on a
 * schema that changed under it.
 */

import type { ForeignKeyEdge } from './dependents'
import { deleteWhereIn, IN_CHUNK } from '../Support/rows'
import { deletionOrder, planPurge } from './dependents'

/**
 * Every foreign key in the current schema.
 *
 * Three plain selects joined in memory rather than one three-way SQL join. The
 * query builder rejects an aliased table name, and `constraint_name` appears in
 * all three views, so the join it would accept is a page of fully qualified
 * column references. A constraint name is unique within a schema, which makes
 * the join a `Map` lookup here and no less correct.
 */
export async function foreignKeyEdges(): Promise<ForeignKeyEdge[]> {
  const [constraints, children, parents] = await Promise.all([
    db
      .selectFrom('information_schema.table_constraints' as any)
      .select(['constraint_name'] as any)
      .where('constraint_type' as any, '=', 'FOREIGN KEY')
      .execute() as Promise<any[]>,
    db
      .selectFrom('information_schema.key_column_usage' as any)
      .select(['constraint_name', 'table_name', 'column_name'] as any)
      .execute() as Promise<any[]>,
    db
      .selectFrom('information_schema.constraint_column_usage' as any)
      .select(['constraint_name', 'table_name'] as any)
      .execute() as Promise<any[]>,
  ])

  const foreignKeys = new Set(constraints.map(row => String(row.constraint_name)))
  const parentOf = new Map<string, string>()

  for (const row of parents) {
    if (foreignKeys.has(String(row.constraint_name)))
      parentOf.set(String(row.constraint_name), String(row.table_name))
  }

  const edges: ForeignKeyEdge[] = []

  for (const row of children) {
    const name = String(row.constraint_name)
    const parent = parentOf.get(name)

    if (!foreignKeys.has(name) || !parent)
      continue

    edges.push({ child: String(row.table_name), column: String(row.column_name), parent })
  }

  return edges
}

export interface PurgeResult {
  ok: boolean
  /** Table name to rows removed, in the order the tables were emptied. */
  removed: Array<{ table: string, rows: number }>
  error?: string
}

/**
 * Remove everything that belongs to a repository, leaving the repository row.
 *
 * Stops at the first failure and says which table it was on, rather than
 * carrying on and leaving a half-emptied repository whose row will not delete
 * anyway. Nothing has moved on disk when this runs, so a failure here is a
 * delete that did not happen - which is the right outcome for a delete that
 * cannot complete.
 */
export async function purgeRepository(repositoryId: number): Promise<PurgeResult> {
  const removed: PurgeResult['removed'] = []

  if (!Number.isFinite(repositoryId) || repositoryId <= 0)
    return { ok: false, removed, error: 'Not a repository id' }

  let steps
  try {
    steps = planPurge(await foreignKeyEdges(), 'repositories')
  }
  catch (error) {
    return { ok: false, removed, error: `Could not read the schema: ${error}` }
  }

  // Forwards: which rows in each table belong to this repository. Every step's
  // parent has been collected before the step is reached, which is what the
  // discovery order buys.
  const idsByTable = new Map<string, number[]>([['repositories', [repositoryId]]])

  for (const step of steps) {
    const parentIds = idsByTable.get(step.parent) ?? []
    if (parentIds.length === 0)
      continue

    try {
      const found = await idsWhereIn(step.table, step.column, parentIds)
      const known = idsByTable.get(step.table)

      if (known)
        idsByTable.set(step.table, [...new Set([...known, ...found])])
      else
        idsByTable.set(step.table, found)
    }
    catch (error) {
      return { ok: false, removed, error: `Could not read ${step.table}: ${error}` }
    }
  }

  // Deepest first: nothing goes before the rows that point at it. One delete
  // per table, which is what `deletionOrder` returns.
  for (const step of deletionOrder(steps)) {
    const ids = idsByTable.get(step.table) ?? []

    if (ids.length === 0)
      continue

    try {
      removed.push({ table: step.table, rows: await deleteWhereIn(step.table, 'id', ids) })
    }
    catch (error) {
      return { ok: false, removed, error: `Could not clear ${step.table}: ${error}` }
    }
  }

  // Forks outlive their parent. `parent_id` is what says where a repository
  // came from, and the answer stops being available rather than the fork
  // stopping existing.
  try {
    await db
      .updateTable('repositories')
      .set({ parent_id: null })
      .where('parent_id', '=', repositoryId)
      .execute()
  }
  catch (error) {
    return { ok: false, removed, error: `Could not detach the forks: ${error}` }
  }

  return { ok: true, removed }
}

/** The ids of rows in `table` whose `column` is one of `values`. */
async function idsWhereIn(table: string, column: string, values: number[]): Promise<number[]> {
  const ids: number[] = []

  for (const chunk of chunked(values)) {
    const rows: any[] = await db
      .selectFrom(table as any)
      .select(['id'] as any)
      .where(column as any, 'in', chunk)
      .execute()

    for (const row of rows)
      ids.push(Number(row.id))
  }

  return ids
}

function* chunked(values: number[]): Generator<number[]> {
  for (let index = 0; index < values.length; index += IN_CHUNK)
    yield values.slice(index, index + IN_CHUNK)
}

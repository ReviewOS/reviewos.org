/**
 * Everything that has to go when a repository goes.
 *
 * Twenty-two tables hang off `repositories`, directly or through issues and
 * pull requests, and every one of their foreign keys is `NO ACTION`. So
 * `DELETE FROM repositories` fails, naming whichever constraint Postgres
 * happened to check first - and it fails *after* the bare repository has been
 * moved aside, leaving a repository that is gone from disk and still listed in
 * the interface.
 *
 * The obvious fix is `ON DELETE CASCADE` on the constraints, and it is the
 * right one. It is not available yet. Declaring `onDelete: 'cascade'` on a
 * model does generate an `ALTER TABLE … ADD CONSTRAINT … ON DELETE CASCADE`,
 * but nothing drops the constraint the column was created with, so Postgres
 * ends up holding both and enforcing both. The stricter one wins: the migration
 * applies cleanly, reports success, and deletes go on failing - visible only by
 * querying `pg_constraint`. Fixing it means teaching the generator to *replace*
 * a constraint rather than add a second one, which is a change in
 * `bun-query-builder`, recorded in `docs/todo/02-git-hosting.md`.
 *
 * Until then the order is worked out from the database's own account of its
 * foreign keys rather than from a list somebody remembers to extend. A table
 * added next year is handled the day it is added; a hand-written list would be
 * wrong the day after it was written, and wrong in the way that only shows up
 * when somebody deletes something.
 */

/** One foreign key: `child.column` points at `parent`. */
export interface ForeignKeyEdge {
  child: string
  column: string
  parent: string
}

/** One table's rows, and which table they hang off. */
export interface PurgeStep {
  table: string
  column: string
  parent: string
  /**
   * How far the *parent* is from the root, counting the longest way round.
   *
   * Longest rather than shortest, and that is the whole subtlety. `issues` is a
   * direct child of `repositories`, so the short way says depth 1 - but it is
   * also reachable as `repositories -> milestones -> issues`, and deleting
   * milestones at depth 1 while issues still points at them fails. The longest
   * path is the only depth at which a table is safe to empty.
   */
  parentDepth: number
}

/**
 * Which rows belong to a repository, and how far from it they sit.
 *
 * Returned in an order a caller can walk forwards to collect ids: every step's
 * parent has been fully collected before the step is reached. `deletionOrder`
 * turns the same steps into the order they may be removed in.
 *
 * Two things are deliberately absent:
 *
 * - **The root.** Deleting the repository row is the caller's business. Doing
 *   it here would bury the one statement that is allowed to fail.
 * - **Self-references.** `repositories.parent_id` points at `repositories`, so
 *   a naive walk would delete every fork of the repository being deleted. A
 *   fork is an independent repository that happens to know where it came from;
 *   it is detached rather than destroyed, which the caller does.
 */
export function planPurge(edges: readonly ForeignKeyEdge[], root: string): PurgeStep[] {
  const relevant: ForeignKeyEdge[] = []
  const seen = new Set<string>()

  for (const edge of edges) {
    // A table pointing at itself is never followed. Postgres also reports one
    // constraint once per referenced column, so the same edge arrives twice.
    if (edge.child === edge.parent)
      continue

    const key = `${edge.child}.${edge.column} -> ${edge.parent}`
    if (seen.has(key))
      continue

    seen.add(key)
    relevant.push(edge)
  }

  const depths = tableDepths(relevant, root)

  const steps = relevant
    // Unreachable tables are not this repository's business, and the root row
    // is the caller's.
    .filter(edge => edge.child !== root && depths.has(edge.parent) && depths.has(edge.child))
    .map(edge => ({
      table: edge.child,
      column: edge.column,
      parent: edge.parent,
      parentDepth: depths.get(edge.parent)!,
    }))

  // Shallowest parent first, so a step is never reached before everything that
  // fills its parent has run.
  return steps.sort((a, b) => a.parentDepth - b.parentDepth)
}

/**
 * The order rows may actually be removed in: deepest table first, one delete
 * per table.
 *
 * One per table rather than one per step, because a table reachable by two
 * columns is still one table, and emptying it twice at two different depths is
 * how the first emptying happens too early.
 */
export function deletionOrder(steps: readonly PurgeStep[]): PurgeStep[] {
  const deepest = new Map<string, PurgeStep>()

  for (const step of steps) {
    const held = deepest.get(step.table)
    if (!held || step.parentDepth > held.parentDepth)
      deepest.set(step.table, step)
  }

  return [...deepest.values()].sort((a, b) => b.parentDepth - a.parentDepth)
}

/**
 * How far each table is from the root, by the longest path.
 *
 * Relaxed repeatedly rather than walked once, because the longest path to a
 * table is not known until every route to it has been seen. Bounded by the
 * number of tables: after that many rounds nothing can still be improving
 * except a cycle, and a delete is not where anybody wants to discover one.
 */
function tableDepths(edges: readonly ForeignKeyEdge[], root: string): Map<string, number> {
  const depths = new Map<string, number>([[root, 0]])
  const rounds = Math.min(edges.length + 1, 64)

  for (let round = 0; round < rounds; round += 1) {
    let changed = false

    for (const edge of edges) {
      const parentDepth = depths.get(edge.parent)
      if (parentDepth === undefined)
        continue

      const candidate = parentDepth + 1
      if ((depths.get(edge.child) ?? -1) < candidate) {
        depths.set(edge.child, candidate)
        changed = true
      }
    }

    if (!changed)
      break
  }

  return depths
}

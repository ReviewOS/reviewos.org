/**
 * Filling in `repository_id` on rows written before the column existed.
 *
 * Every table under a repository carries the shard key now, and new rows get it
 * where they are written. Rows already on disk do not: the migration adds a
 * nullable column and says nothing about what belongs in it, which is right -
 * a migration that reads a hundred million rows is a migration that never
 * finishes on the instance that most needs it.
 *
 * So the backfill is a separate, resumable step. It walks each table in batches
 * of ids, joins to whichever parent holds the key, and writes only rows where
 * it is still null. Interrupt it and run it again: it picks up where it stopped
 * because "still null" is the cursor.
 *
 * The chains are declared rather than discovered. A foreign key says which
 * tables are related, not which relationship *owns* the row - `workflow_jobs`
 * points at both `workflow_runs` and `runners`, and only one of those has the
 * repository. Getting that wrong would write plausible values that put rows on
 * the wrong shard, which is worse than leaving them null.
 */

import type { Connection } from './engineMigration'
import { connect } from './engineMigration'

/** One table, and the path from it to a row that already carries the key. */
export interface ShardKeyChain {
  table: string
  /** Joined parent-to-child, outermost first. The last one holds the key. */
  hops: Array<{ table: string, localKey: string, parentKey: string }>
}

/**
 * Every table that owes the key, and where it comes from.
 *
 * Two-hop chains are the grandchildren: a review comment's repository is its
 * thread's, and a workflow step's is its job's. `workflow_version_steps` is
 * three hops from `repositories` and two from a row that has the column, which
 * is the depth that made denormalizing worth doing at all.
 */
export const SHARD_KEY_CHAINS: readonly ShardKeyChain[] = [
  { table: 'check_annotations', hops: [{ table: 'check_runs', localKey: 'check_run_id', parentKey: 'id' }] },
  { table: 'environment_reviewers', hops: [{ table: 'environments', localKey: 'environment_id', parentKey: 'id' }] },
  { table: 'issue_assignees', hops: [{ table: 'issues', localKey: 'issue_id', parentKey: 'id' }] },
  { table: 'issue_labels', hops: [{ table: 'issues', localKey: 'issue_id', parentKey: 'id' }] },
  { table: 'managed_tests', hops: [{ table: 'test_suites', localKey: 'test_suite_id', parentKey: 'id' }] },
  { table: 'pull_request_reviewers', hops: [{ table: 'pull_requests', localKey: 'pull_request_id', parentKey: 'id' }] },
  { table: 'pull_request_reviews', hops: [{ table: 'pull_requests', localKey: 'pull_request_id', parentKey: 'id' }] },
  { table: 'release_assets', hops: [{ table: 'releases', localKey: 'release_id', parentKey: 'id' }] },
  { table: 'review_checkpoints', hops: [{ table: 'pull_requests', localKey: 'pull_request_id', parentKey: 'id' }] },
  { table: 'review_drafts', hops: [{ table: 'pull_requests', localKey: 'pull_request_id', parentKey: 'id' }] },
  { table: 'review_threads', hops: [{ table: 'pull_requests', localKey: 'pull_request_id', parentKey: 'id' }] },
  { table: 'reviewed_files', hops: [{ table: 'pull_requests', localKey: 'pull_request_id', parentKey: 'id' }] },
  { table: 'run_metadata', hops: [{ table: 'workflow_runs', localKey: 'workflow_run_id', parentKey: 'id' }] },
  { table: 'test_runs', hops: [{ table: 'test_suites', localKey: 'test_suite_id', parentKey: 'id' }] },
  { table: 'webhook_deliveries', hops: [{ table: 'webhooks', localKey: 'webhook_id', parentKey: 'id' }] },
  { table: 'workflow_artifacts', hops: [{ table: 'workflow_runs', localKey: 'workflow_run_id', parentKey: 'id' }] },
  { table: 'workflow_jobs', hops: [{ table: 'workflow_runs', localKey: 'workflow_run_id', parentKey: 'id' }] },
  { table: 'workflow_versions', hops: [{ table: 'workflows', localKey: 'workflow_id', parentKey: 'id' }] },

  // The grandchildren, after their parents are filled. Order matters here and
  // nowhere else: these read the column the rows above just gained.
  { table: 'review_comments', hops: [{ table: 'review_threads', localKey: 'review_thread_id', parentKey: 'id' }] },
  { table: 'test_executions', hops: [{ table: 'test_runs', localKey: 'test_run_id', parentKey: 'id' }] },
  { table: 'workflow_job_logs', hops: [{ table: 'workflow_jobs', localKey: 'workflow_job_id', parentKey: 'id' }] },
  { table: 'workflow_steps', hops: [{ table: 'workflow_jobs', localKey: 'workflow_job_id', parentKey: 'id' }] },
  { table: 'workflow_version_jobs', hops: [{ table: 'workflow_versions', localKey: 'workflow_version_id', parentKey: 'id' }] },
  { table: 'workflow_step_attempts', hops: [{ table: 'workflow_steps', localKey: 'workflow_step_id', parentKey: 'id' }] },
  { table: 'workflow_version_steps', hops: [{ table: 'workflow_version_jobs', localKey: 'workflow_version_job_id', parentKey: 'id' }] },
]

export interface BackfillResult {
  table: string
  /** Rows that gained a value. */
  filled: number
  /** Rows still null afterwards, because the parent is gone or is null. */
  orphaned: number
}

/** The identifier quote for this engine. */
function quote(name: string, adapter: string): string {
  return adapter === 'mysql' ? `\`${name}\`` : `"${name}"`
}

/**
 * One table, in batches.
 *
 * `UPDATE ... FROM` is Postgres and `UPDATE a JOIN b` is MySQL, so the two are
 * written out rather than papered over: an update with a join is the one
 * statement where the dialects share no syntax at all, and pretending otherwise
 * is how a portable-looking helper ends up running on one engine.
 */
export async function backfillTable(connection: Connection, chain: ShardKeyChain, batch = 5000): Promise<BackfillResult> {
  const sql = connect(connection)
  const q = (name: string) => quote(name, connection.adapter)
  const child = q(chain.table)
  const parent = q(chain.hops[0]!.table)
  const localKey = q(chain.hops[0]!.localKey)
  const parentKey = q(chain.hops[0]!.parentKey)

  let filled = 0

  try {
    for (;;) {
      const statement = connection.adapter === 'mysql'
        // No `LIMIT` on a joined update - MySQL rejects it outright - and no
        // bare subquery on the table being written either, which is why the id
        // list is wrapped in a derived table. Both are MySQL rules with no
        // Postgres equivalent, and both were found by running this.
        ? `UPDATE ${child} AS c
             JOIN ${parent} AS p ON p.${parentKey} = c.${localKey}
              SET c.${q('repository_id')} = p.${q('repository_id')}
            WHERE c.${q('repository_id')} IS NULL
              AND p.${q('repository_id')} IS NOT NULL
              AND c.${q('id')} IN (
                SELECT ${q('id')} FROM (
                  SELECT ${q('id')} FROM ${child}
                   WHERE ${q('repository_id')} IS NULL
                   ORDER BY ${q('id')}
                   LIMIT ${batch}
                ) AS batch
              )`
        : `UPDATE ${child} AS c
              SET ${q('repository_id')} = p.${q('repository_id')}
             FROM ${parent} AS p
            WHERE p.${parentKey} = c.${localKey}
              AND c.${q('repository_id')} IS NULL
              AND p.${q('repository_id')} IS NOT NULL
              AND c.${q('id')} IN (
                SELECT ${q('id')} FROM ${child}
                 WHERE ${q('repository_id')} IS NULL
                 ORDER BY ${q('id')}
                 LIMIT ${batch}
              )`

      const result = await sql.unsafe(statement) as unknown as { affectedRows?: number, count?: number }
      const moved = Number(result?.affectedRows ?? result?.count ?? 0)

      filled += moved

      // A batch that moves nothing is the end: either every row has a value or
      // the ones left have no parent to take one from.
      if (moved < 1)
        break
    }

    const [remaining] = await sql.unsafe(
      `SELECT COUNT(*) AS n FROM ${child} WHERE ${q('repository_id')} IS NULL`,
    ) as Array<{ n: number | string }>

    return { table: chain.table, filled, orphaned: Number(remaining?.n ?? 0) }
  }
  finally {
    await sql.close().catch(() => {})
  }
}

/** Every chain, in order, so a grandchild reads a parent that is already filled. */
export async function backfillShardKey(connection: Connection, batch = 5000): Promise<BackfillResult[]> {
  const results: BackfillResult[] = []

  for (const chain of SHARD_KEY_CHAINS)
    results.push(await backfillTable(connection, chain, batch))

  return results
}

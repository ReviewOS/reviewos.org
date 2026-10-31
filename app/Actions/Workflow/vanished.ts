/**
 * Runs of a workflow the newer commit no longer has.
 *
 * A newer push to a ref already skips the queued runs of the *same* workflow
 * through its concurrency group ("Skipped: a newer commit arrived before this
 * run started"). That rule never reached a workflow the newer commit deleted
 * or renamed: there is no newer run in its group to replace it, so the stale
 * run went on to execute. On 2026-10-31 HQ renamed `lsu-native-*.yml` to
 * `enterprise-native-*.yml`; the old runs at the previous commit held the one
 * Mac runner for hours ahead of the real ones, and one failed on a module the
 * rename had moved.
 *
 * So a push that moves a branch also retires that branch's live push runs
 * whose workflow file is absent at the new head - queued ones before they
 * start, running ones through the same cancellation a person would send.
 *
 * Two guards keep this from cancelling work it should not:
 *
 * - **Only behind the new head.** Push callbacks can land out of order, and an
 *   older push arriving late lists an older tree, in which a workflow added by
 *   the newer commit is "absent". A run whose commit is not an ancestor of the
 *   new head - a newer one, or a force-pushed one - is left alone.
 * - **Only a known tree.** When the new head cannot be listed, nothing is
 *   superseded: "git timed out" must not read as "every workflow was deleted".
 *
 * Absent means the file is gone from the tree, not merely unread: a repository
 * that copied its `.github` workflows into `.reviewos` still has the originals,
 * and their runs are left alone.
 */

import { db } from '@stacksjs/database'
import { cancelRun } from './cancel'

export interface VanishedInput {
  repositoryId: number
  /** The ref that moved: `refs/heads/main`. */
  ref: string
  /** Its new head. */
  headSha: string
  /** The workflow paths the new head carries; null when that is unknown. */
  present: readonly string[] | null
  /** Whether a run's commit is behind the new head, so the newer tree speaks for it. */
  isAncestor: (sha: string) => Promise<boolean>
}

/** A live run and the workflow file it was started from. */
export interface LiveRun {
  number: number
  headSha: string
  path: string
}

/**
 * The runs to retire, from the live push runs on the ref. Pure, so the rules
 * are testable without a repository or a database.
 */
export async function vanishedRuns(
  runs: readonly LiveRun[],
  input: Pick<VanishedInput, 'headSha' | 'present' | 'isAncestor'>,
): Promise<LiveRun[]> {
  if (!input.present)
    return []

  const present = new Set(input.present)
  const behind = new Map<string, boolean>()
  const stale: LiveRun[] = []

  for (const run of runs) {
    if (!run.path || run.headSha === input.headSha || present.has(run.path))
      continue

    if (!behind.has(run.headSha))
      behind.set(run.headSha, await input.isAncestor(run.headSha).catch(() => false))

    if (behind.get(run.headSha))
      stale.push(run)
  }

  return stale
}

/** The reason written on the run, saying which file the newer commit lacks. */
export function vanishedReason(path: string, headSha: string): string {
  return `Skipped: a newer commit (${headSha.slice(0, 9)}) no longer has \`${path}\`.`
}

/**
 * Retire this ref's live push runs whose workflow the new head dropped.
 * Returns the run numbers it cancelled. Never throws: it is a consequence of a
 * push and must not fail one.
 */
export async function supersedeVanishedWorkflows(input: VanishedInput): Promise<number[]> {
  try {
    if (!input.present)
      return []

    const rows: any[] = await db
      .selectFrom('workflow_runs')
      .innerJoin('workflow_versions', 'workflow_versions.id', '=', 'workflow_runs.workflow_version_id')
      .innerJoin('workflows', 'workflows.id', '=', 'workflow_versions.workflow_id')
      .select([
        'workflow_runs.number as number',
        'workflow_runs.head_sha as head_sha',
        'workflow_versions.source_path as source_path',
        'workflows.path as workflow_path',
      ])
      .where('workflow_runs.repository_id', '=', input.repositoryId)
      // The repository's own workflows only: an owner-defined one lives in
      // another repository's tree, so its absence here says nothing.
      .where('workflows.repository_id', '=', input.repositoryId)
      .where('workflow_runs.event', '=', 'push')
      .where('workflow_runs.event_ref', '=', input.ref)
      .where('workflow_runs.state', 'in', ['queued', 'waiting', 'running', 'paused'])
      .execute()

    const stale = await vanishedRuns(rows.map(row => ({
      number: Number(row.number),
      headSha: String(row.head_sha ?? ''),
      path: String(row.source_path || row.workflow_path || ''),
    })), input)

    const cancelled: number[] = []

    for (const run of stale) {
      const result = await cancelRun({
        repositoryId: input.repositoryId,
        number: run.number,
        reason: vanishedReason(run.path, input.headSha),
        actor: { actorId: null },
      }).catch(() => null)

      if (result && 'workflow_run' in result.body && result.body.cancelled)
        cancelled.push(run.number)
    }

    return cancelled
  }
  catch {
    return []
  }
}

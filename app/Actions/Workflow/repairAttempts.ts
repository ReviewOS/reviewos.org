/**
 * What a run has already spent on repair.
 *
 * `repairPolicy.ts` decides; this counts. The split is the same one every other
 * decision in that file keeps: the rules are pure and testable, and the one
 * function that reads rows is small enough to be obviously right.
 *
 * ## Refusals do not count against the attempt budget
 *
 * They are written - a refusal nobody recorded is the reason "why did nothing
 * try to fix this" has no answer - but `spentOn` counts only what ran. A
 * repository whose policy refuses every attempt for a forbidden path has not
 * used up its two tries; it has used none, and counting refusals would let one
 * misconfigured pattern permanently exhaust a budget nothing ever spent.
 *
 * Time and cost are the other way round: a refusal that reached the model
 * before being refused spent real minutes and real money, so whatever an
 * attempt recorded is counted whatever state it ended in. The rule is "count
 * what was spent, not what was tried".
 */

import { db } from '@stacksjs/database'

/** What one run has used, in the units `mayAttemptRepair` asks for. */
export interface RepairSpend {
  attempts: number
  minutesSpent: number
  costSpent: number
  tokensSpent: number
}

const NOTHING: RepairSpend = { attempts: 0, minutesSpent: 0, costSpent: 0, tokensSpent: 0 }

/**
 * The spend for one run.
 *
 * Read in one query and summed here rather than in SQL, because the two sums
 * have different populations - attempts counts a subset of the rows minutes and
 * cost are summed over - and two aggregate queries to answer one question is
 * two chances for them to disagree about which rows exist.
 */
export async function spentOn(runId: number): Promise<RepairSpend> {
  const rows: any[] = await db
    .selectFrom('repair_attempts')
    .select(['state', 'minutes', 'cost', 'tokens'])
    .where('workflow_run_id', '=', runId)
    .execute()
    .catch(() => [])

  return sumSpend(rows)
}

/**
 * The counting rule, on its own.
 *
 * Pure because the interesting part is not the query, it is which rows count
 * for what - and that is a rule somebody will want to argue about while reading
 * a test rather than while reading an incident.
 */
export function sumSpend(rows: readonly { state?: unknown, minutes?: unknown, cost?: unknown, tokens?: unknown }[]): RepairSpend {
  if (rows.length === 0)
    return { ...NOTHING }

  let attempts = 0
  let minutesSpent = 0
  let costSpent = 0
  let tokensSpent = 0

  for (const row of rows) {
    // Everything except a refusal is something that ran, including one that
    // failed: an attempt that spent its budget and produced nothing has still
    // had its turn, and not counting it is how a broken repair loops forever.
    if (String(row.state) !== 'refused')
      attempts += 1

    // Time and cost are counted whatever the row came to. A refusal reached
    // after the model ran spent real minutes and real money, and a budget that
    // forgave them would be a budget an expensive loop never reaches.
    minutesSpent += whole(row.minutes)
    costSpent += whole(row.cost)
    tokensSpent += whole(row.tokens)
  }

  return { attempts, minutesSpent, costSpent, tokensSpent }
}

export interface AttemptRecord {
  repositoryId: number
  runId: number
  jobId: number | null
  step: string
  state: 'attempted' | 'proposed' | 'refused' | 'failed'
  refusal?: string | null
  reason?: string | null
  branch?: string | null
  commitSha?: string | null
  proposedBy?: number | null
  minutes?: number
  cost?: number
  tokens?: number
}

/**
 * Write one, and hand back its id so the attempt can be closed later.
 *
 * Returns null rather than throwing when the insert fails. The caller is on the
 * path that decides whether to spend money on a model, and a ledger write that
 * failed must not be the thing that starts a repair - `considerRepair` treats a
 * null id as a reason to stop, which is the safe direction: no row means no
 * budget can be counted, and an unbounded repair loop is exactly what the
 * budgets exist to prevent.
 */
export async function recordAttempt(input: AttemptRecord): Promise<number | null> {
  const written: any = await db
    .insertInto('repair_attempts')
    .values({
      repository_id: input.repositoryId,
      workflow_run_id: input.runId,
      workflow_job_id: input.jobId,
      step: input.step.slice(0, 255),
      state: input.state,
      refusal: input.refusal ? String(input.refusal).slice(0, 64) : null,
      reason: input.reason ? String(input.reason).slice(0, 2000) : null,
      branch: input.branch ? String(input.branch).slice(0, 255) : null,
      commit_sha: input.commitSha ? String(input.commitSha).slice(0, 64) : null,
      proposed_by: input.proposedBy ?? null,
      minutes: whole(input.minutes),
      cost: whole(input.cost),
      tokens: whole(input.tokens),
    })
    .returning(['id'])
    .executeTakeFirst()
    .catch(() => null)

  return written?.id ? Number(written.id) : null
}

/**
 * Close an attempt with what it came to.
 *
 * Separate from `recordAttempt` because the row has to exist *before* the model
 * runs. An attempt written only on completion is one that does not exist while
 * it is running, which means a second failure arriving in the same minute reads
 * a budget that does not know about the first - and two agents work on the same
 * run at once.
 */
export async function finishAttempt(id: number, outcome: {
  state: 'proposed' | 'refused' | 'failed'
  refusal?: string | null
  reason?: string | null
  branch?: string | null
  commitSha?: string | null
  minutes?: number
  cost?: number
  tokens?: number
}): Promise<void> {
  await db
    .updateTable('repair_attempts')
    .set({
      state: outcome.state,
      refusal: outcome.refusal ? String(outcome.refusal).slice(0, 64) : null,
      reason: outcome.reason ? String(outcome.reason).slice(0, 2000) : null,
      branch: outcome.branch ? String(outcome.branch).slice(0, 255) : null,
      commit_sha: outcome.commitSha ? String(outcome.commitSha).slice(0, 64) : null,
      minutes: whole(outcome.minutes),
      cost: whole(outcome.cost),
      tokens: whole(outcome.tokens),
      updated_at: new Date().toISOString(),
    })
    .where('id', '=', id)
    .execute()
    .catch(() => null)
}

/** A stored or supplied number, as a whole non-negative one. */
function whole(value: unknown): number {
  const raw = Number(value)

  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0
}

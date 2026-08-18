/**
 * Every check on a commit, shaped for somebody looking at a pull request.
 *
 * The rollup in `rollup.ts` answers one question - may this merge - and that is
 * deliberately all it answers. A person on the checks tab has different ones:
 * *which* check failed, how long it took, where its output is, whether it has
 * run at all, and whether the green tick belongs to the commit in front of them
 * or to one that has been replaced.
 *
 * Kept out of the template because a template cannot be tested and this has the
 * awkward cases in it. The shaping below is pure; `checksPanel` is the one
 * function that reads rows.
 */

import type { Report, RollupState } from './rollup'
import { fromCheckRun, fromStatus, rollup } from './rollup'
import { requirementsSatisfied, statusAsRun } from './status'

/** How an entry reads: the word, and the colour that goes with it. */
export type CheckTone = 'good' | 'bad' | 'warn' | 'muted'

export interface CheckEntry {
  name: string
  /** Where it came from, so a page can explain a disagreement. */
  source: 'status' | 'check_run'
  state: RollupState
  /** What the reader sees: `Passed`, `Running`, `Cancelled`, and so on. */
  label: string
  tone: CheckTone
  /** Which attempt this is. 1 unless the reporter retried. */
  attempt: number
  /** `1m 20s`, or empty when it never started or never finished. */
  duration: string
  detailsUrl: string
  summary: string
  /** Named by a branch rule, so a failure here blocks rather than informs. */
  required: boolean
  /**
   * Reported against a commit that is no longer the head.
   *
   * The case this exists for: a required check passed, somebody pushed, and the
   * check has not run again. Every forge shows a tick somewhere in that state,
   * and the tick is about code nobody is merging.
   */
  stale: boolean
  /** The commit it did report against, when that is not the head. */
  staleSha: string
  annotations: CheckAnnotation[]
  /** How many there are in total, which is not `annotations.length`. */
  annotationCount: number
}

export interface CheckAnnotation {
  path: string
  startLine: number
  endLine: number
  side: string
  level: string
  title: string
  message: string
}

export interface ChecksPanel {
  state: RollupState
  counts: Record<RollupState, number>
  entries: CheckEntry[]
  /**
   * The branch rule's verdict, which is a different question from the rollup.
   *
   * Computed with `requirementsSatisfied`, which is the function the merge
   * endpoint calls, over both reporting APIs, which is what the merge endpoint
   * reads. Anything else here would be a page that says a pull request is ready
   * and a button that then refuses it - or the reverse, which is worse.
   */
  required: { satisfied: boolean, missing: string[], failing: string[], pending: string[] }
  /** Every annotation on the head, for the diff to hang on its lines. */
  annotations: CheckAnnotation[]
}

/**
 * The word for a check run, which is not the same as its rollup state.
 *
 * `cancelled` and `timed_out` both roll up as failures - nothing looked at the
 * code - but telling somebody their check "failed" when a newer push cancelled
 * it sends them to read a log that says nothing. The distinction is only ever
 * cosmetic to the merge rule and never cosmetic to the reader.
 */
export function labelFor(status: string, conclusion: string): { label: string, tone: CheckTone } {
  if (status === 'queued')
    return { label: 'Queued', tone: 'warn' }

  if (status !== 'completed')
    return { label: 'Running', tone: 'warn' }

  switch (conclusion) {
    case 'success': return { label: 'Passed', tone: 'good' }
    case 'failure': return { label: 'Failed', tone: 'bad' }
    case 'cancelled': return { label: 'Cancelled', tone: 'muted' }
    case 'timed_out': return { label: 'Timed out', tone: 'bad' }
    case 'action_required': return { label: 'Action required', tone: 'bad' }
    case 'skipped': return { label: 'Skipped', tone: 'muted' }
    case 'neutral': return { label: 'Neutral', tone: 'muted' }
    case 'stale': return { label: 'Stale', tone: 'muted' }
    // Completed and said nothing. A reporter bug, and reading it as anything
    // else invents a verdict the check never gave.
    default: return { label: 'Finished without a conclusion', tone: 'warn' }
  }
}

/** The word for a commit status, which has three states and no conclusion. */
export function labelForStatus(state: string): { label: string, tone: CheckTone } {
  if (state === 'success')
    return { label: 'Passed', tone: 'good' }

  if (state === 'pending')
    return { label: 'Running', tone: 'warn' }

  return { label: 'Failed', tone: 'bad' }
}

/**
 * How long it took, in the units somebody reads rather than milliseconds.
 *
 * Empty when either end is missing: a check that has not finished has no
 * duration, and printing "0s" for it says something false. Wall time, which is
 * the number a person waiting for CI actually cares about.
 */
export function durationBetween(startedAt: unknown, finishedAt: unknown): string {
  const start = Date.parse(String(startedAt ?? ''))
  const end = Date.parse(String(finishedAt ?? ''))

  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start)
    return ''

  const seconds = Math.round((end - start) / 1000)

  if (seconds < 60)
    return `${seconds}s`

  const minutes = Math.floor(seconds / 60)

  if (minutes < 60)
    return seconds % 60 === 0 ? `${minutes}m` : `${minutes}m ${seconds % 60}s`

  const hours = Math.floor(minutes / 60)

  return minutes % 60 === 0 ? `${hours}h` : `${hours}h ${minutes % 60}m`
}

/**
 * A check run row, as an entry.
 *
 * Exported so the shaping can be tested against rows rather than against a
 * rendered page: the states that matter here are the ones a reporter produces
 * rarely and a test produces on demand.
 */
export function entryFromRun(row: any, options: { required: Set<string>, headSha: string, annotations?: CheckAnnotation[], annotationCount?: number }): CheckEntry {
  const status = String(row.status ?? 'queued')
  const conclusion = String(row.conclusion ?? '')
  const { label, tone } = labelFor(status, conclusion)
  const sha = String(row.head_sha ?? '')
  const stale = Boolean(sha) && Boolean(options.headSha) && sha !== options.headSha

  return {
    name: String(row.name ?? ''),
    source: 'check_run',
    state: fromCheckRun(row).state,
    // A stale report is never announced as a verdict on this commit, whatever
    // it concluded about the one it ran against.
    label: stale ? `${label} on an earlier commit` : label,
    tone: stale ? 'muted' : tone,
    attempt: Number(row.attempt) || 1,
    duration: durationBetween(row.started_at, row.completed_at),
    detailsUrl: row.details_url ? String(row.details_url) : '',
    summary: row.summary ? String(row.summary) : '',
    required: options.required.has(String(row.name ?? '')),
    stale,
    staleSha: stale ? sha : '',
    annotations: options.annotations ?? [],
    annotationCount: options.annotationCount ?? (options.annotations?.length ?? 0),
  }
}

/** A commit status row, as an entry. No attempts, no output, no annotations. */
export function entryFromStatus(row: any, required: Set<string>): CheckEntry {
  const state = String(row.state ?? 'pending')
  const { label, tone } = labelForStatus(state)

  return {
    name: String(row.context ?? ''),
    source: 'status',
    state: fromStatus(row).state,
    label,
    tone,
    attempt: 1,
    duration: '',
    detailsUrl: row.target_url ? String(row.target_url) : '',
    summary: row.description ? String(row.description) : '',
    required: required.has(String(row.context ?? '')),
    stale: false,
    staleSha: '',
    annotations: [],
    annotationCount: 0,
  }
}

/**
 * An entry for a required check that has never reported.
 *
 * The one a branch rule exists for, and the one every other forge renders as an
 * empty row somebody scrolls past. It says so in words.
 */
export function entryForMissing(name: string): CheckEntry {
  return {
    name,
    source: 'check_run',
    state: 'pending',
    label: 'Has never reported',
    tone: 'warn',
    attempt: 0,
    duration: '',
    detailsUrl: '',
    summary: '',
    required: true,
    stale: false,
    staleSha: '',
    annotations: [],
    annotationCount: 0,
  }
}

/**
 * Only the newest entry under each name, keeping the row rather than the report.
 *
 * `latestPerName` answers with `Report`s, which is what the merge rule needs and
 * not what a page renders - so the same rule is applied to entries here rather
 * than being re-derived slightly differently in a template.
 */
export function newestPerName(entries: readonly CheckEntry[]): CheckEntry[] {
  const newest = new Map<string, CheckEntry>()

  for (const entry of entries) {
    const held = newest.get(entry.name)

    // Attempts first, and a present report always beats a stale one: a check
    // that has run again on this commit replaces what it said about the last.
    if (!held || (held.stale && !entry.stale) || (held.stale === entry.stale && entry.attempt >= held.attempt))
      newest.set(entry.name, entry)
  }

  return [...newest.values()].sort((a, b) => {
    // Required first, then anything unhappy, then by name. A reader scanning
    // this list is looking for what is wrong, not for an alphabet.
    if (a.required !== b.required)
      return a.required ? -1 : 1

    const rank = (entry: CheckEntry) => (entry.state === 'failure' ? 0 : entry.state === 'pending' ? 1 : 2)

    return rank(a) - rank(b) || a.name.localeCompare(b.name)
  })
}

/**
 * Every check on a pull request's head, with the branch rule's verdict beside it.
 *
 * One query per table, plus one for annotations. A check that reported on an
 * earlier head is fetched *only* for the required names that are missing from
 * this one, which is the case worth a second look: a green tick belonging to a
 * commit somebody has already replaced.
 */
export async function checksPanel(input: {
  repositoryId: number
  headSha: string
  required: readonly string[]
}): Promise<ChecksPanel> {
  const required = new Set(input.required.map(String))

  const statuses = await db
    .selectFrom('commit_statuses')
    .selectAll()
    .where('repository_id', '=', Number(input.repositoryId))
    .where('sha', '=', input.headSha)
    .orderBy('id', 'asc')
    .execute()

  const runs = await db
    .selectFrom('check_runs')
    .selectAll()
    .where('repository_id', '=', Number(input.repositoryId))
    .where('head_sha', '=', input.headSha)
    .orderBy('id', 'asc')
    .execute()

  const reports: Report[] = [
    ...statuses.map((row, index) => fromStatus(row, index + 1)),
    ...runs.map(row => fromCheckRun(row)),
  ]

  const combined = rollup(reports)

  const verdict = requirementsSatisfied(
    [
      ...statuses.map(row => statusAsRun(row)),
      ...runs.map((row: any) => ({
        name: String(row.name ?? ''),
        status: row.status,
        conclusion: row.conclusion,
        startedAt: Date.parse(String(row.started_at ?? '')) || 0,
      })),
    ],
    [...required],
  )

  const annotationsByRun = await annotationsFor(runs.map(row => Number(row.id)))

  const entries: CheckEntry[] = [
    ...statuses.map(row => entryFromStatus(row, required)),
    ...runs.map(row => entryFromRun(row, {
      required,
      headSha: input.headSha,
      annotations: annotationsByRun.get(Number(row.id))?.items ?? [],
      annotationCount: annotationsByRun.get(Number(row.id))?.total ?? 0,
    })),
  ]

  // A required name with nothing on this commit: say whether it has ever run,
  // and against what. "Has never reported" and "passed on the commit before
  // yours" are different problems with different fixes.
  const seen = new Set(entries.map(entry => entry.name))

  for (const name of verdict.missing) {
    if (seen.has(name))
      continue

    const previous = await db
      .selectFrom('check_runs')
      .selectAll()
      .where('repository_id', '=', Number(input.repositoryId))
      .where('name', '=', name)
      .orderBy('id', 'desc')
      .limit(1)
      .executeTakeFirst()

    entries.push(previous
      ? entryFromRun(previous, { required, headSha: input.headSha })
      : entryForMissing(name))
  }

  const shaped = newestPerName(entries)

  return {
    state: combined.state,
    counts: combined.counts,
    entries: shaped,
    required: {
      satisfied: verdict.satisfied,
      missing: verdict.missing,
      failing: verdict.failing,
      pending: verdict.pending,
    },
    // Only what ran against this head: an annotation from a superseded run
    // points at lines that may not exist any more.
    annotations: shaped.filter(entry => !entry.stale).flatMap(entry => entry.annotations),
  }
}

/** Annotations for a set of runs, in one query, capped per run. */
async function annotationsFor(runIds: readonly number[]): Promise<Map<number, { total: number, items: CheckAnnotation[] }>> {
  const found = new Map<number, { total: number, items: CheckAnnotation[] }>()

  if (runIds.length === 0)
    return found

  try {
    const rows = await db
      .selectFrom('check_annotations')
      .selectAll()
      .where('check_run_id', 'in', [...runIds])
      .orderBy('path', 'asc')
      .orderBy('start_line', 'asc')
      .execute()

    for (const row of rows) {
      const id = Number(row.check_run_id)
      const held = found.get(id) ?? { total: 0, items: [] }

      held.total += 1

      // The same ceiling the API uses. A linter with four thousand findings is
      // one nobody reads through, and a page carrying all of them is a page
      // that does not render.
      if (held.items.length < 100) {
        held.items.push({
          path: String(row.path ?? ''),
          startLine: Number(row.start_line) || 0,
          endLine: Number(row.end_line) || Number(row.start_line) || 0,
          side: String(row.side ?? 'right'),
          level: String(row.level ?? 'warning'),
          title: row.title ? String(row.title) : '',
          message: String(row.message ?? ''),
        })
      }

      found.set(id, held)
    }
  }
  catch {
    // No annotations table on this instance, or it could not be read. The
    // checks themselves are still worth showing.
  }

  return found
}

/**
 * What an import has done, and what it has left to do.
 *
 * An import of a real repository takes long enough that it *will* be
 * interrupted - a deploy, a worker restart, a rate limit that outlasts the
 * process. So the job is written as a sequence of named stages with a cursor,
 * and every stage is safe to run again from where it stopped.
 *
 * ## Resumable means idempotent, not "remembers a number"
 *
 * A cursor alone is not enough: a page written and then interrupted before the
 * cursor advanced would be written twice on the next run. So every write is
 * keyed on something stable from the source - the issue number, the review
 * comment's external id - and re-running a page updates rather than duplicates.
 * The cursor is an optimisation on top of that, not the correctness argument.
 */

export type ImportStage = 'git' | 'labels' | 'milestones' | 'issues' | 'pulls' | 'comments' | 'reviews' | 'releases' | 'done'

/**
 * The stages in the order they run, which is the order they depend on.
 *
 * Comments come after both issues and pull requests because a comment has to
 * find the thing it hangs off. Running them earlier would file every comment
 * under "not imported" and produce a problems list the length of the
 * repository.
 */
export const IMPORT_STAGES: readonly ImportStage[] = ['git', 'labels', 'milestones', 'issues', 'pulls', 'comments', 'reviews', 'releases', 'done']

export interface ImportProgress {
  stage: ImportStage
  /** The page within the stage, 1-based, as GitHub counts them. */
  page: number
  counts: Record<string, number>
  /** What went wrong and was skipped, rather than what stopped the import. */
  problems: string[]
}

export function emptyProgress(): ImportProgress {
  return { stage: 'git', page: 1, counts: {}, problems: [] }
}

/**
 * The stage after this one.
 *
 * `done` is a stage rather than a null, so a resumed import that has finished
 * has something to compare against rather than a special case at every call
 * site.
 */
export function nextStage(stage: ImportStage): ImportStage {
  const index = IMPORT_STAGES.indexOf(stage)

  return IMPORT_STAGES[Math.min(index + 1, IMPORT_STAGES.length - 1)]!
}

/** Whether the import has anything left to do. */
export function isFinished(progress: ImportProgress): boolean {
  return progress.stage === 'done'
}

/**
 * How far along, as a fraction, for a progress bar that is not a lie.
 *
 * Stage-weighted rather than page-counted, because the number of pages is not
 * known until each stage starts and a bar that jumps back is worse than a
 * coarse one. Git is weighted heavily because it genuinely is most of the wall
 * clock on a large repository.
 */
const WEIGHTS: Record<ImportStage, number> = {
  git: 40,
  labels: 2,
  milestones: 2,
  issues: 18,
  pulls: 16,
  comments: 10,
  reviews: 8,
  releases: 4,
  done: 0,
}

export function percentComplete(progress: ImportProgress): number {
  const total = Object.values(WEIGHTS).reduce((sum, weight) => sum + weight, 0)
  let done = 0

  for (const stage of IMPORT_STAGES) {
    if (stage === progress.stage)
      break

    done += WEIGHTS[stage]
  }

  return Math.min(100, Math.round((done / total) * 100))
}

/**
 * A sentence somebody reading a progress line actually wants.
 *
 * Named stages rather than a percentage alone, because "68%" of an import tells
 * nobody whether the thing they are waiting for has arrived. "Importing pull
 * requests" says the issues are already there.
 */
const DESCRIPTIONS: Record<ImportStage, string> = {
  git: 'Cloning the repository',
  labels: 'Importing labels',
  milestones: 'Importing milestones',
  issues: 'Importing issues',
  pulls: 'Importing pull requests',
  comments: 'Importing the conversations',
  reviews: 'Importing reviews and review threads',
  releases: 'Importing releases',
  done: 'Finished',
}

export function describeProgress(progress: ImportProgress): string {
  if (progress.stage === 'done')
    return summarize(progress)

  const page = progress.page > 1 ? `, page ${progress.page}` : ''

  return `${DESCRIPTIONS[progress.stage]}${page}`
}

/** What was imported, in the order somebody checks it. */
export function summarize(progress: ImportProgress): string {
  const parts = ['issues', 'pull_requests', 'comments', 'reviews', 'review_threads', 'releases']
    .filter(key => (progress.counts[key] ?? 0) > 0)
    .map(key => `${progress.counts[key]} ${key.replace(/_/g, ' ')}`)

  if (parts.length === 0)
    return 'Imported the repository, with no metadata'

  return `Imported ${parts.join(', ')}`
}

/** Count something that was imported, for the summary above. */
export function record(progress: ImportProgress, key: string, amount = 1): void {
  progress.counts[key] = (progress.counts[key] ?? 0) + amount
}

/**
 * Note something that failed without stopping the import.
 *
 * The distinction that makes an importer usable: one malformed comment out of
 * four thousand should not abandon the migration, and it should also not vanish.
 * Capped, because a systematic failure would otherwise produce a problems list
 * the size of the repository and a row too large to store.
 */
export function noteProblem(progress: ImportProgress, problem: string): void {
  if (progress.problems.length >= 50) {
    if (progress.problems.length === 50)
      progress.problems.push('More problems followed and were not recorded.')

    return
  }

  progress.problems.push(problem)
}

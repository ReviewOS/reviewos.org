/**
 * Small helpers the review templates need.
 *
 * Exported from `resources/functions`, so stx auto-imports them and the
 * templates stay free of logic that would be untestable inside a template.
 */

export interface TemplateThread {
  id: number
  path: string
  line: number | null
  side: 'left' | 'right'
  resolved: boolean
  outdated: boolean
  comments: Array<{
    id: number
    authorHandle: string
    body: string
    createdAt: string
  }>
}

export interface TemplateLine {
  origin: 'context' | 'added' | 'removed'
  oldLine: number | null
  newLine: number | null
}

/**
 * The threads that belong under this line.
 *
 * A thread on the right-hand side matches the new line number, one on the left
 * matches the old. Matching on both at once is how a comment written about a
 * removed line ends up printed under the line that replaced it.
 */
export function threadsAt(
  threads: readonly TemplateThread[],
  path: string,
  line: TemplateLine,
): TemplateThread[] {
  return threads.filter((thread) => {
    if (thread.path !== path || thread.line === null)
      return false

    return thread.side === 'right'
      ? line.newLine === thread.line
      : line.oldLine === thread.line
  })
}

/** `1,234` rather than `1234`, which is hard to size at a glance. */
export function formatCount(value: number): string {
  return value.toLocaleString('en-US')
}

/**
 * A short, human sense of when something happened, at a given clock.
 *
 * Takes the current time as an argument rather than reading it, so a rendered
 * page is a function of its inputs and the tests are not flaky. Named
 * `relativeTimeAt` because `browse.ts` owns `relativeTime`, and the auto-import
 * barrel is one namespace: two exports of a name make it fail to compile, which
 * takes every other function in `resources/functions/` down with it.
 */
export function relativeTimeAt(iso: string, now: number): string {
  const then = Date.parse(iso)
  if (Number.isNaN(then))
    return ''

  const seconds = Math.round((now - then) / 1000)

  if (seconds < 45)
    return 'just now'

  const units: Array<[number, string]> = [
    [60, 'minute'],
    [3600, 'hour'],
    [86400, 'day'],
    [2592000, 'month'],
    [31536000, 'year'],
  ]

  let value = seconds
  let name = 'second'

  for (const [size, unit] of units) {
    if (seconds < size)
      break
    value = Math.floor(seconds / size)
    name = unit
  }

  return `${value} ${name}${value === 1 ? '' : 's'} ago`
}

/**
 * The syntax tokens for one diff line.
 *
 * Named `lineTokensFor` rather than `tokensFor` because the auto-import barrel
 * is one namespace: `repo.ts` exports a `tokensFor` that lists an account's
 * access tokens, and two exports of one name made the whole barrel fail to
 * compile - "Cannot export a duplicate name" - which takes every other function
 * in `resources/functions/` down with it and leaves a view that relies on one
 * saying "is not defined".
 *
 * Keyed by origin and line number rather than by array position, because a
 * hunk's lines are not contiguous in the file and a thread row sits between
 * them. Falls back to the raw content, so a file the highlighter declined
 * still renders.
 */
export function lineTokensFor(
  highlighted: Record<string, Array<{ type: string, content: string }>> | undefined,
  line: { origin: string, oldLine: number | null, newLine: number | null, content: string },
): Array<{ type: string, content: string }> {
  if (!highlighted)
    return [{ type: 'text', content: line.content }]

  // A removed line only exists on the left, an added line only on the right.
  const key = line.origin === 'removed' ? `-${line.oldLine}` : `+${line.newLine}`

  return highlighted[key] ?? [{ type: 'text', content: line.content }]
}

/*
 * The review logic the templates need.
 *
 * A view cannot import from `app/` directly — the stx plugin resolves a
 * server-script import relative to `resources/`, so `resources/functions` is
 * the boundary and the crossing happens here, once. The rules themselves stay
 * in `app/Actions`, tested.
 *
 * Written as `import` plus a named `export`, not `export … from`: the stx
 * composable loader cannot parse a re-export, and it fails by leaving every
 * binding undefined rather than by saying so.
 */
import { diffTotals as diffTotalsImpl, isGenerated as isGeneratedImpl, isWhitespaceOnly as isWhitespaceOnlyImpl, parseDiff as parseDiffImpl } from '../../app/Actions/Pull/diff'
import { approvalsSatisfied as approvalsSatisfiedImpl, machineAccountsAmong as machineAccountsAmongImpl, mapLine as mapLineImpl, reanchor as reanchorImpl, reviewIsStale as reviewIsStaleImpl } from '../../app/Actions/Pull/anchoring'
import { changedPathsFor as changedPathsForImpl, commitDiff as commitDiffImpl, commitsOnBranch as commitsOnBranchImpl, pullRequestDiff as pullRequestDiffImpl, SSR_DIFF_BYTE_LIMIT as SSR_DIFF_BYTE_LIMIT_IMPL } from '../../app/Actions/Pull/load'
import { isMergeStrategy as isMergeStrategyImpl, mergeBlockers as mergeBlockersImpl } from '../../app/Actions/Pull/merge'
import { combinedState as combinedStateImpl, requirementSummary as requirementSummaryImpl, requirementsSatisfied as requirementsSatisfiedImpl } from '../../app/Actions/Checks/status'
import { highlightDiffFile as highlightDiffFileImpl, renderDiffFile as renderDiffFileImpl } from '../../app/Actions/Pull/rows'
import { anchorThreads as anchorThreadsImpl, loadReviewThreads as loadReviewThreadsImpl } from '../../app/Actions/Pull/loadThreads'
import { threadSlotFor as threadSlotForImpl } from '../../app/Actions/Pull/threads'
import { branchExists as branchExistsImpl } from '../../app/Actions/Pull/restore'
import { crossFileMoves as crossFileMovesImpl, moveNotes as moveNotesImpl } from '../../app/Actions/Pull/crossmoves'
import { loadCoverage as loadCoverageImpl } from '../../app/Actions/Checks/coverage'
import { checksPanel as checksPanelImpl } from '../../app/Actions/Checks/panel'
import { annotationsByLine as annotationsByLineImpl, annotationsForLine as annotationsForLineImpl, renderAnnotations as renderAnnotationsImpl } from '../../app/Actions/Pull/annotations'
import { refreshMergeability as refreshMergeabilityImpl } from '../../app/Actions/Pull/refresh-mergeability'
import { isBehindBase as isBehindBaseImpl } from '../../app/Actions/Pull/mergeability'
import { parseRestrictions as parseRestrictionsImpl } from '../../app/Actions/Repo/branchRules'
import { pushActorFor as pushActorForImpl } from '../../app/Actions/Git/access'

export const parseDiff = parseDiffImpl
export const diffTotals = diffTotalsImpl
export const isGenerated = isGeneratedImpl
export const isWhitespaceOnly = isWhitespaceOnlyImpl
export const reanchor = reanchorImpl
export const mapLine = mapLineImpl
export const reviewIsStale = reviewIsStaleImpl
export const approvalsSatisfied = approvalsSatisfiedImpl
export const machineAccountsAmong = machineAccountsAmongImpl
export const pullRequestDiff = pullRequestDiffImpl
export const commitsOnBranch = commitsOnBranchImpl

/** The whole-page diff budget, for the banner that names it. */
export const SSR_DIFF_BYTE_LIMIT = SSR_DIFF_BYTE_LIMIT_IMPL

/** The changed paths, cheaply, for single-file navigation. */
export const changedPathsFor = changedPathsForImpl

/** One commit's own diff, for commit-by-commit review. */
export const commitDiff = commitDiffImpl
export const mergeBlockers = mergeBlockersImpl
export const isMergeStrategy = isMergeStrategyImpl

/*
 * The three inputs a branch rule needs that the row alone does not carry.
 *
 * Re-exported so the page decides merge readiness from exactly the values the
 * merge endpoint uses. A page that computed a *nearly* identical answer would
 * be worse than one that computed none: it is where somebody decides to press
 * the button, and being told the branch is ready by the screen and refused by
 * the endpoint is the disagreement that costs the most trust.
 */
export const isBehindBase = isBehindBaseImpl
export const parseRestrictions = parseRestrictionsImpl
export const pushActorFor = pushActorForImpl
export const requirementsSatisfied = requirementsSatisfiedImpl

/**
 * Every check on a commit, shaped for the checks tab.
 *
 * The rollup answers "may this merge"; this answers the questions a person
 * has - which one failed, how long it took, where the output is, and whether
 * the tick belongs to the commit they are looking at.
 */
export const checksPanel = checksPanelImpl

/** Those annotations, keyed by the diff row they belong on. */
export const annotationsByLine = annotationsByLineImpl
export const annotationsForLine = annotationsForLineImpl
export const renderAnnotations = renderAnnotationsImpl
export const requirementSummary = requirementSummaryImpl
export const combinedState = combinedStateImpl
export const refreshMergeability = refreshMergeabilityImpl

/**
 * Rendering a file's diff, and the threads that sit inside it.
 *
 * The same functions the streamed review screen uses. One renderer serves both,
 * so the diff cannot look one way on the conversation page and another on the
 * screen built for reading it.
 */
export const renderDiffFile = renderDiffFileImpl
export const highlightDiffFile = highlightDiffFileImpl
export const loadReviewThreads = loadReviewThreadsImpl
export const anchorThreads = anchorThreadsImpl
export const threadSlotFor = threadSlotForImpl

/** Whether a branch is still in the repository, for offering to restore one. */
export const branchExists = branchExistsImpl

/** Blocks that moved between files, found over the whole diff. */
export const crossFileMoves = crossFileMovesImpl
export const moveNotes = moveNotesImpl

/** Uncovered lines per path, for marking changed lines no test executes. */
export const loadCoverage = loadCoverageImpl

/**
 * The preview environments a pull request has, for the link on its page.
 *
 * Re-exported one name at a time rather than with `export … from`, which the
 * stx composable loader cannot parse - it fails by leaving every binding
 * undefined rather than by saying so.
 */
import { previewsFor as previewsForImpl } from '../../app/Actions/Deploy/previews'

export const previewsFor = previewsForImpl

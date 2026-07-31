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

/**
 * Whether a file should start collapsed.
 *
 * Generated files and very large diffs are collapsed so the changes somebody
 * actually needs to read are on the first screen. Everything stays one click
 * away, and nothing is hidden without saying so.
 */
export function startsCollapsed(file: { path: string, additions: number, deletions: number }, isGeneratedFile: boolean): boolean {
  if (isGeneratedFile)
    return true

  return file.additions + file.deletions > 500
}

/** `1,234` rather than `1234`, which is hard to size at a glance. */
export function formatCount(value: number): string {
  return value.toLocaleString('en-US')
}

/**
 * A short, human sense of when something happened.
 *
 * Takes the current time as an argument rather than reading the clock, so a
 * rendered page is a function of its inputs and the tests are not flaky.
 */
export function relativeTime(iso: string, now: number): string {
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
 * The tokens for one diff line.
 *
 * Keyed by origin and line number rather than by array position, because a
 * hunk's lines are not contiguous in the file and a thread row sits between
 * them. Falls back to the raw content, so a file the highlighter declined
 * still renders.
 */
export function tokensFor(
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
import { approvalsSatisfied as approvalsSatisfiedImpl, mapLine as mapLineImpl, reanchor as reanchorImpl, reviewIsStale as reviewIsStaleImpl } from '../../app/Actions/Pull/anchoring'
import { commitsOnBranch as commitsOnBranchImpl, pullRequestDiff as pullRequestDiffImpl } from '../../app/Actions/Pull/load'
import { isMergeStrategy as isMergeStrategyImpl, mergeBlockers as mergeBlockersImpl } from '../../app/Actions/Pull/merge'
import { combinedState as combinedStateImpl, requirementSummary as requirementSummaryImpl, requirementsSatisfied as requirementsSatisfiedImpl } from '../../app/Actions/Checks/status'
import { labelTextColor as labelTextColorImpl } from '../../app/Actions/Issue/labels'
import { highlightLines as highlightLinesImpl, languageFor as languageForImpl } from '../../app/Actions/Browse/highlight'

export const parseDiff = parseDiffImpl
export const diffTotals = diffTotalsImpl
export const isGenerated = isGeneratedImpl
export const isWhitespaceOnly = isWhitespaceOnlyImpl
export const reanchor = reanchorImpl
export const mapLine = mapLineImpl
export const reviewIsStale = reviewIsStaleImpl
export const approvalsSatisfied = approvalsSatisfiedImpl
export const pullRequestDiff = pullRequestDiffImpl
export const commitsOnBranch = commitsOnBranchImpl
export const mergeBlockers = mergeBlockersImpl
export const isMergeStrategy = isMergeStrategyImpl
export const requirementsSatisfied = requirementsSatisfiedImpl
export const requirementSummary = requirementSummaryImpl
export const combinedState = combinedStateImpl
export const labelTextColor = labelTextColorImpl
export const highlightLines = highlightLinesImpl
export const languageFor = languageForImpl

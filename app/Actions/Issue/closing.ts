/**
 * Issues a pull request says it closes.
 *
 * `closingReferences` in the markdown module finds `fixes #12` in a piece of
 * text. This decides which of those a merge should act on, and it is separate
 * because the answer is a policy question rather than a parsing one.
 *
 * The policy: only issues in the same repository, and only issues. Both
 * exclusions cost something real and both are deliberate.
 */

import { closingReferences } from '../Markdown/references'

export interface ClosingTarget {
  number: number
  keyword: string
}

export interface ClosingScope {
  owner: string
  repository: string
}

/**
 * The issue numbers a text closes in this repository.
 *
 * A cross-repository reference (`other/repo#12`) is dropped rather than
 * followed. Whoever merges here has permission here; closing an issue in a
 * repository they may not even be able to read is not something a merge should
 * be able to do quietly. A reference that names *this* repository explicitly is
 * kept, because it is the same repository written the long way.
 *
 * Duplicates collapse, keeping the first keyword seen, so `fixes #12` twice in
 * one description closes issue 12 once.
 */
export function closingTargets(text: string, scope: ClosingScope): ClosingTarget[] {
  const found = closingReferences(text)
  const targets = new Map<number, string>()

  for (const reference of found) {
    const elsewhere = reference.owner !== null
      && (reference.owner.toLowerCase() !== scope.owner.toLowerCase()
        || String(reference.repository).toLowerCase() !== scope.repository.toLowerCase())

    if (elsewhere)
      continue

    if (!targets.has(reference.number))
      targets.set(reference.number, reference.keyword)
  }

  return [...targets].map(([number, keyword]) => ({ number, keyword }))
}

/**
 * Whether a pull request's own number can be a closing target.
 *
 * It cannot. `fixes #7` inside pull request 7 is somebody describing the
 * change, and the numbering is shared, so without this the merge would close
 * the pull request it just merged and the state would read as both.
 */
export function withoutSelf(targets: ClosingTarget[], selfNumber: number): ClosingTarget[] {
  return targets.filter(target => target.number !== selfNumber)
}

/**
 * Reading a compare URL: which two refs, and which of the two questions.
 *
 * `a...b` is the merge-base compare - what `b` is proposing, the diff a pull
 * request shows. `a..b` is tip to tip, which includes every commit other
 * people landed on `a` in the meantime; the roadmap calls diffing against the
 * tip the single most common way review UIs mislead, so the two spellings are
 * kept apart and the page labels them out loud rather than treating the
 * difference as punctuation.
 *
 * Split on `...` before `..`, which is unambiguous: git forbids `..` inside a
 * refname, so a URL containing either is a separator and not a name.
 */

export interface CompareRequest {
  base: string
  head: string
  mode: 'merge-base' | 'direct'
}

export function parseCompareRefs(refs: string, defaultBranch: string): CompareRequest | null {
  const raw = String(refs ?? '').trim().replace(/^\/+|\/+$/g, '')

  if (raw === '')
    return null

  if (raw.includes('...')) {
    const cut = raw.indexOf('...')
    const base = raw.slice(0, cut).trim()
    const head = raw.slice(cut + 3).trim()

    if (!base || !head)
      return null

    return { base, head, mode: 'merge-base' }
  }

  if (raw.includes('..')) {
    const cut = raw.indexOf('..')
    const base = raw.slice(0, cut).trim()
    const head = raw.slice(cut + 2).trim()

    if (!base || !head)
      return null

    return { base, head, mode: 'direct' }
  }

  // One name compares against the default branch, the way a pushed topic
  // branch is compared before anybody has typed anything.
  return { base: defaultBranch, head: raw, mode: 'merge-base' }
}

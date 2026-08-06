import { describe, expect, it } from 'bun:test'
import { commitRows, refLinks, treeRows } from '../../app/Actions/Browse/rows'

/**
 * What a directory listing and a ref picker look like once the rules are
 * applied - the rules being here rather than in a template, which no test can
 * reach.
 */

const formatSize = (size: number | null) => size === null ? '' : `${size} B`
const shortSha = (sha: string) => sha.slice(0, 7)

const BASE = '/anna/checkout'

function entry(over: Partial<Parameters<typeof treeRows>[0][number]> = {}): any {
  return { mode: '100644', type: 'blob', sha: 'a'.repeat(40), size: 12, name: 'index.ts', ...over }
}

describe('treeRows', () => {
  it('links a file to itself, inside the directory being looked at', () => {
    const [row] = treeRows([entry()], BASE, 'main', 'src', formatSize, shortSha)

    expect(row.href).toBe('/anna/checkout/tree/main/src/index.ts')
    expect(row.meta).toBe('12 B')
  })

  it('links from the root without an empty segment in the middle', () => {
    const [row] = treeRows([entry()], BASE, 'main', '', formatSize, shortSha)

    expect(row.href).toBe('/anna/checkout/tree/main/index.ts')
  })

  /** The reason `joinRefAndPath` exists: the slash in the name is not a separator. */
  it('keeps a branch whose name contains a slash', () => {
    const [row] = treeRows([entry()], BASE, 'fix/rounding', 'src', formatSize, shortSha)

    expect(row.href).toBe('/anna/checkout/tree/fix/rounding/src/index.ts')
  })

  /**
   * Git does not know a directory's size without walking the whole tree, and a
   * number that costs a traversal per row is a number worth doing without.
   */
  it('gives a directory no size', () => {
    const [row] = treeRows([entry({ type: 'tree', name: 'src', size: null })], BASE, 'main', '', formatSize, shortSha)

    expect(row.meta).toBe('')
    expect(row.icon).toContain('folder')
    expect(row.href).toBe('/anna/checkout/tree/main/src')
  })

  /** A submodule points at another repository. There is nothing here to open. */
  it('gives a submodule its sha and no link', () => {
    const [row] = treeRows(
      [entry({ type: 'commit', name: 'vendor', sha: 'b'.repeat(40), size: null })],
      BASE, 'main', '', formatSize, shortSha,
    )

    expect(row.href).toBeNull()
    expect(row.meta).toBe('bbbbbbb')
    expect(row.icon).toContain('git-merge')
  })

  it('has an answer for an empty directory', () => {
    expect(treeRows([], BASE, 'main', '', formatSize, shortSha)).toEqual([])
  })
})

describe('refLinks', () => {
  /**
   * Switching branch from three directories down and landing at the root is
   * the kind of small wrongness that makes a picker not worth using: the whole
   * reason to switch is usually to see this file on the other branch.
   */
  it('keeps you where you are when you switch ref', () => {
    const [link] = refLinks(['main'], BASE, 'main', 'src/pricing')

    expect(link.href).toBe('/anna/checkout/tree/main/src/pricing')
  })

  it('says which one is the ref being looked at', () => {
    const links = refLinks(['main', 'fix/rounding'], BASE, 'fix/rounding', '')

    expect(links.map(l => l.isCurrent)).toEqual([false, true])
  })

  it('does not leave a trailing slash at the root of a repository', () => {
    const [link] = refLinks(['main'], BASE, 'main', '')

    expect(link.href).toBe('/anna/checkout/tree/main')
  })

  it('has an answer for a repository with no refs', () => {
    expect(refLinks([], BASE, 'main', '')).toEqual([])
  })
})

describe('commitRows', () => {
  const relativeTime = (when: string) => `on ${when}`
  const commit = (over: Record<string, unknown> = {}) => ({
    sha: 'c'.repeat(40),
    subject: 'Document the rounding rule',
    authorName: 'Jordan Lewis',
    when: '2026-01-02',
    ...over,
  }) as any

  it('links both the subject and the sha to the same commit', () => {
    const [row] = commitRows([commit()], BASE, relativeTime, shortSha)

    expect(row.href).toBe(`/anna/checkout/commit/${'c'.repeat(40)}`)
    expect(row.short).toBe('ccccccc')
    expect(row.subject).toBe('Document the rounding rule')
  })

  it('says who and how long ago as one sentence', () => {
    const [row] = commitRows([commit()], BASE, relativeTime, shortSha)

    expect(row.byline).toBe('Jordan Lewis committed on 2026-01-02')
  })

  /**
   * `git commit --allow-empty-message` makes this reachable, and a link with
   * nothing in it is unclickable. A row that says less beats a row you cannot
   * open.
   */
  it('falls back to the sha when a commit has no subject', () => {
    const [row] = commitRows([commit({ subject: '' })], BASE, relativeTime, shortSha)

    expect(row.subject).toBe('ccccccc')
  })

  it('has an answer for a repository with no commits', () => {
    expect(commitRows([], BASE, relativeTime, shortSha)).toEqual([])
  })
})

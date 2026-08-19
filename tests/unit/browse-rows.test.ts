import { describe, expect, it } from 'bun:test'
import { commitRows, headCommitRow, refLinks, signatureBadge, treeRows } from '../../app/Actions/Browse/rows'

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

/**
 * What a reader is told about a signature.
 *
 * These are claims about a person, not formatting, which is why they are pinned
 * here rather than left in a template. "Invalid" says a signature did not check
 * out; "Unverified" says this server has nothing to check it against. Only one
 * of those is an accusation, and swapping them would put it on every commit
 * signed with a key nobody happened to register.
 */
describe('signatureBadge', () => {
  it('says nothing about an unsigned commit', () => {
    // Most commits. A mark on nearly every row is a mark people learn to
    // ignore, and it is the same mark that has to mean something on the day a
    // signature really is bad.
    expect(signatureBadge('unsigned').show).toBe(false)
  })

  it('names the signer when one is known', () => {
    const badge = signatureBadge('verified', 'Ada Lovelace')

    expect(badge.show).toBe(true)
    expect(badge.label).toBe('Verified')
    expect(badge.tone).toBe('good')
    expect(badge.detail).toContain('Ada Lovelace')
  })

  it('still says verified when the signer has no name on record', () => {
    const badge = signatureBadge('verified', null)

    expect(badge.label).toBe('Verified')
    expect(badge.detail).not.toContain('null')
  })

  it('accuses only when the signature actually failed', () => {
    expect(signatureBadge('invalid').label).toBe('Invalid')
    expect(signatureBadge('invalid').tone).toBe('bad')
  })

  it.each(['unknown_key', 'unavailable'] as const)('does not accuse on %s', (status) => {
    // A key nobody registered may be perfectly good, and a missing gpg says
    // nothing at all about who wrote the commit. Both are "we do not know".
    const badge = signatureBadge(status)

    expect(badge.label).toBe('Unverified')
    expect(badge.tone).not.toBe('bad')
    expect(badge.tone).not.toBe('good')
  })

  it('distinguishes the two unverified cases in the detail, not the label', () => {
    // The label is what people scan and both mean the same thing to a reader.
    // The reason they differ matters to whoever is debugging it.
    expect(signatureBadge('unknown_key').detail).toContain('nobody here has registered')
    expect(signatureBadge('unavailable').detail).toContain('could not check')
  })

  it('gives every drawn badge a word and an icon, not just a colour', () => {
    for (const status of ['verified', 'invalid', 'unknown_key', 'unavailable'] as const) {
      const badge = signatureBadge(status)

      expect(badge.label.length).toBeGreaterThan(0)
      expect(badge.icon.length).toBeGreaterThan(0)
      expect(badge.detail.length).toBeGreaterThan(0)
    }
  })
})

describe('headCommitRow', () => {
  const relativeTime = (when: string) => when ? '3 days ago' : ''
  const commit = { sha: 'e'.repeat(40), subject: 'fix(strings): split by UTF-16 units', authorName: 'Chris', when: '2026-08-16T00:00:00Z' }

  it('points the sha and the subject at the commit, which is what a reader clicks', () => {
    const row = headCommitRow(commit, BASE, 'main', '', relativeTime, shortSha)

    expect(row.href).toBe(`${BASE}/commit/${'e'.repeat(40)}`)
    expect(row.short).toBe('eeeeeee')
    expect(row.subject).toBe('fix(strings): split by UTF-16 units')
  })

  it('scopes the history to the path being looked at', () => {
    // Somebody standing on `src/parser.ts` is asking about `src/parser.ts`, not
    // about the whole repository.
    const row = headCommitRow(commit, BASE, 'main', 'src/parser.ts', relativeTime, shortSha)

    expect(row.historyHref).toBe(`${BASE}/commits/main/src/parser.ts`)
  })

  it('keeps a slashed branch whole in the history link', () => {
    // `fix/rounding` is one branch. A link that treats the slash as a
    // separator asks for a branch called `fix` holding `rounding`.
    const row = headCommitRow(commit, BASE, 'fix/rounding', 'src', relativeTime, shortSha)

    expect(row.historyHref).toBe(`${BASE}/commits/fix/rounding/src`)
  })

  it('has no trailing slash at the repository root', () => {
    const row = headCommitRow(commit, BASE, 'main', '', relativeTime, shortSha)

    expect(row.historyHref).toBe(`${BASE}/commits/main`)
  })

  it('falls back to the sha when the commit has no subject', () => {
    // `git commit --allow-empty-message` is a real thing, and a link with
    // nothing in it cannot be clicked.
    const row = headCommitRow({ ...commit, subject: '' }, BASE, 'main', '', relativeTime, shortSha)

    expect(row.subject).toBe('eeeeeee')
  })

  it('says nothing about when rather than rendering an empty date', () => {
    const row = headCommitRow({ ...commit, when: '' }, BASE, 'main', '', relativeTime, shortSha)

    expect(row.when).toBe('')
  })
})

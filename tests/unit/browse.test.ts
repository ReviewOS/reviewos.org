import { describe, expect, it } from 'bun:test'
import { parseTreeEntries, type TreeEntry } from '../../app/Actions/Browse/parse'
import {
  breadcrumbs,
  childPath,
  findReadme,
  formatSize,
  isMarkdown,
  shortSha,
  sortEntries,
} from '../../resources/functions/browse'

function entry(overrides: Partial<TreeEntry> = {}): TreeEntry {
  return { mode: '100644', type: 'blob', sha: 'a'.repeat(40), size: 10, name: 'file.ts', ...overrides }
}

/** Build a `ls-tree -z --long` record the way git writes it. */
function record(mode: string, type: string, sha: string, size: string, name: string): string {
  return `${mode} ${type} ${sha} ${size.padStart(7)}\t${name}\0`
}

describe('parseTreeEntries', () => {
  it('parses a normal listing', () => {
    const out
      = record('040000', 'tree', 'b'.repeat(40), '-', 'src')
        + record('100644', 'blob', 'c'.repeat(40), '1024', 'README.md')

    const entries = parseTreeEntries(out)

    expect(entries).toHaveLength(2)
    expect(entries[0]).toMatchObject({ type: 'tree', name: 'src', size: null })
    expect(entries[1]).toMatchObject({ type: 'blob', name: 'README.md', size: 1024 })
  })

  /**
   * The reason this is NUL-delimited rather than line-delimited. A newline is
   * legal in a filename, and splitting on it reports one file as two - a
   * browser inventing files that do not exist.
   */
  it('keeps a filename containing a newline as one entry', () => {
    const out = record('100644', 'blob', 'd'.repeat(40), '12', 'weird\nname.txt')

    const entries = parseTreeEntries(out)

    expect(entries).toHaveLength(1)
    expect(entries[0]!.name).toBe('weird\nname.txt')
  })

  it('keeps a filename containing a tab intact', () => {
    // The name starts at the FIRST tab; splitting on tabs would truncate here.
    const out = record('100644', 'blob', 'e'.repeat(40), '3', 'tabbed\tname.txt')

    expect(parseTreeEntries(out)[0]!.name).toBe('tabbed\tname.txt')
  })

  it('reads submodules as commits rather than dropping them', () => {
    const out = record('160000', 'commit', 'f'.repeat(40), '-', 'vendor/dep')

    expect(parseTreeEntries(out)[0]).toMatchObject({ type: 'commit', name: 'vendor/dep' })
  })

  it('returns nothing for an empty tree', () => {
    expect(parseTreeEntries('')).toEqual([])
    expect(parseTreeEntries('\0')).toEqual([])
  })

  it('skips malformed records instead of emitting a half-built entry', () => {
    // A truncated record must not become an entry with undefined fields that
    // the template then renders as "undefined".
    expect(parseTreeEntries('garbage-with-no-tab\0')).toEqual([])
    expect(parseTreeEntries('100644 blob\tshort.ts\0')).toEqual([])
  })

  it('ignores a type git does not use for entries', () => {
    expect(parseTreeEntries(record('100644', 'tag', 'a'.repeat(40), '1', 'x'))).toEqual([])
  })
})

describe('sortEntries', () => {
  it('puts directories before files', () => {
    const sorted = sortEntries([
      entry({ name: 'a.ts' }),
      entry({ name: 'zzz', type: 'tree', size: null }),
    ])

    expect(sorted.map(e => e.name)).toEqual(['zzz', 'a.ts'])
  })

  it('sorts each group alphabetically', () => {
    const sorted = sortEntries([
      entry({ name: 'b.ts' }),
      entry({ name: 'a.ts' }),
      entry({ name: 'src', type: 'tree', size: null }),
      entry({ name: 'app', type: 'tree', size: null }),
    ])

    expect(sorted.map(e => e.name)).toEqual(['app', 'src', 'a.ts', 'b.ts'])
  })

  it('orders numbered files the way a human reads them', () => {
    const sorted = sortEntries([
      entry({ name: '10-ten.md' }),
      entry({ name: '2-two.md' }),
    ])

    expect(sorted.map(e => e.name)).toEqual(['2-two.md', '10-ten.md'])
  })

  it('does not mutate its input', () => {
    const input = [entry({ name: 'b' }), entry({ name: 'a' })]
    sortEntries(input)

    expect(input.map(e => e.name)).toEqual(['b', 'a'])
  })
})

describe('formatSize', () => {
  it('shows nothing for a directory', () => {
    // "0 B" would read as an empty file rather than a folder.
    expect(formatSize(null)).toBe('')
  })

  it('scales through the units', () => {
    expect(formatSize(512)).toBe('512 B')
    expect(formatSize(2048)).toBe('2.0 KB')
    expect(formatSize(5 * 1024 * 1024)).toBe('5.0 MB')
  })

  it('handles an empty file', () => {
    expect(formatSize(0)).toBe('0 B')
  })
})

describe('breadcrumbs', () => {
  it('is just the repository at the root', () => {
    const crumbs = breadcrumbs('stacks', '')

    expect(crumbs).toHaveLength(1)
    expect(crumbs[0]).toMatchObject({ name: 'stacks', path: '', current: true })
  })

  it('accumulates the full path at each level', () => {
    // Each crumb links to itself, so it needs the whole path, not its segment.
    const crumbs = breadcrumbs('stacks', 'storage/framework/core')

    expect(crumbs.map(c => c.path)).toEqual(['', 'storage', 'storage/framework', 'storage/framework/core'])
    expect(crumbs.map(c => c.name)).toEqual(['stacks', 'storage', 'framework', 'core'])
  })

  it('marks only the last crumb as current', () => {
    const crumbs = breadcrumbs('stacks', 'src/app')

    expect(crumbs.filter(c => c.current)).toHaveLength(1)
    expect(crumbs.at(-1)!.current).toBe(true)
  })

  it('tolerates leading and doubled slashes', () => {
    expect(breadcrumbs('stacks', '/src//app').map(c => c.name)).toEqual(['stacks', 'src', 'app'])
  })
})

describe('findReadme', () => {
  it('finds the conventional spelling', () => {
    expect(findReadme([entry({ name: 'README.md' })])?.name).toBe('README.md')
  })

  it('is case-insensitive, because repositories disagree', () => {
    expect(findReadme([entry({ name: 'readme.md' })])?.name).toBe('readme.md')
    expect(findReadme([entry({ name: 'Readme.markdown' })])?.name).toBe('Readme.markdown')
  })

  it('prefers markdown when several exist', () => {
    const found = findReadme([entry({ name: 'README' }), entry({ name: 'README.md' })])

    expect(found?.name).toBe('README.md')
  })

  it('accepts an extensionless README', () => {
    expect(findReadme([entry({ name: 'README' })])?.name).toBe('README')
  })

  it('ignores a directory named readme', () => {
    expect(findReadme([entry({ name: 'readme', type: 'tree', size: null })])).toBeNull()
  })

  it('is not fooled by a name that merely contains readme', () => {
    expect(findReadme([entry({ name: 'READMENOT.md' })])).toBeNull()
    expect(findReadme([entry({ name: 'my-readme.md' })])).toBeNull()
  })

  it('returns null when there is none', () => {
    expect(findReadme([entry({ name: 'index.ts' })])).toBeNull()
  })
})

describe('childPath', () => {
  it('does not emit a leading slash at the root', () => {
    expect(childPath('', 'src')).toBe('src')
  })

  it('joins with exactly one slash', () => {
    expect(childPath('src', 'index.ts')).toBe('src/index.ts')
  })
})

describe('isMarkdown', () => {
  it('recognises markdown regardless of case', () => {
    expect(isMarkdown('README.md')).toBe(true)
    expect(isMarkdown('docs/Guide.MARKDOWN')).toBe(true)
  })

  it('rejects everything else', () => {
    expect(isMarkdown('index.ts')).toBe(false)
    expect(isMarkdown('notes.md.bak')).toBe(false)
  })
})

describe('shortSha', () => {
  it('shortens to the length git displays', () => {
    expect(shortSha('d72fa0e29523b1fe7ddfe4454fa98a6d933908aa')).toBe('d72fa0e')
  })
})

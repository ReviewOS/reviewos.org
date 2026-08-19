/**
 * Who wrote a repository, out of what git says.
 *
 * The parsing is the part worth pinning, because git's author field is chosen
 * by whoever ran the commit and is therefore adversarial by default: display
 * names contain angle brackets, addresses differ only in case, and one person
 * appears under four spellings of their own name. Every one of those, mishandled,
 * attributes somebody's commits to somebody else - which is the only way this
 * feature can do harm.
 */

import { describe, expect, it } from 'bun:test'
import { contributorRows, displayName, MAX_CONTRIBUTORS, mergeTallies, parseShortlog } from '../../app/Actions/Repo/contributors'

const count = (value: number) => String(value)

describe('parseShortlog', () => {
  it('reads the shape `git shortlog -sne` prints', () => {
    const stdout = '  1247\tChris <chris@example.com>\n     3\tA. N. Other <other@example.org>\n'

    expect(parseShortlog(stdout)).toEqual([
      { name: 'Chris', email: 'chris@example.com', commits: 1247 },
      { name: 'A. N. Other', email: 'other@example.org', commits: 3 },
    ])
  })

  it('lower-cases the address, because git does not and mail does not care', () => {
    expect(parseShortlog('  2\tChris <Chris@Example.COM>')[0]!.email).toBe('chris@example.com')
  })

  it('takes the address from the last brackets, not the first', () => {
    // `Chris <the maintainer> <chris@example.com>` is a real shape, and
    // splitting on the first bracket puts half a name in the column the whole
    // table is keyed on.
    const parsed = parseShortlog('  5\tChris <the maintainer> <chris@example.com>')

    expect(parsed[0]!.email).toBe('chris@example.com')
    expect(parsed[0]!.name).toBe('Chris <the maintainer>')
  })

  it('drops a line with no address rather than collecting them under one key', () => {
    // Git produces these for a malformed author, and one empty key per
    // repository would merge every one of them into a single fictional person.
    expect(parseShortlog('  9\tNo Address Here\n  1\tChris <chris@example.com>')).toHaveLength(1)
  })

  it('ignores blank lines and anything that is not a count', () => {
    expect(parseShortlog('\n\nnot a tally\n  4\tChris <chris@example.com>\n')).toHaveLength(1)
  })

  it('refuses a count of zero, which is not a contributor', () => {
    expect(parseShortlog('  0\tChris <chris@example.com>')).toEqual([])
  })

  it('falls back to the address when the commit carried no name', () => {
    expect(parseShortlog('  4\t<chris@example.com>')[0]!.name).toBe('chris@example.com')
  })

  it('has nothing to say about an empty history', () => {
    expect(parseShortlog('')).toEqual([])
  })
})

describe('mergeTallies', () => {
  it('merges the spellings of one person behind one address', () => {
    // `shortlog` groups by the name *and* the address, so the same person
    // arrives as several rows - which the unique index would reject.
    const merged = mergeTallies([
      { name: 'Chris', email: 'chris@example.com', commits: 40 },
      { name: 'chris', email: 'chris@example.com', commits: 7 },
      { name: 'Chris B', email: 'chris@example.com', commits: 3 },
    ])

    expect(merged).toHaveLength(1)
    expect(merged[0]!.commits).toBe(50)
  })

  it('keeps the spelling on the most commits, which is the one they use', () => {
    const merged = mergeTallies([
      { name: 'chris', email: 'chris@example.com', commits: 7 },
      { name: 'Chris', email: 'chris@example.com', commits: 40 },
    ])

    expect(merged[0]!.name).toBe('Chris')
  })

  it('keeps two addresses apart, however alike the names are', () => {
    // Guessing that two people with the same display name are one person is
    // the guess that credits somebody else's work to a stranger.
    const merged = mergeTallies([
      { name: 'Chris', email: 'chris@work.example', commits: 10 },
      { name: 'Chris', email: 'chris@home.example', commits: 4 },
    ])

    expect(merged).toHaveLength(2)
  })

  it('orders by commits, biggest first', () => {
    const merged = mergeTallies([
      { name: 'B', email: 'b@example.com', commits: 2 },
      { name: 'A', email: 'a@example.com', commits: 9 },
    ])

    expect(merged.map(row => row.email)).toEqual(['a@example.com', 'b@example.com'])
  })

  it('breaks a tie the same way twice', () => {
    // A list that shuffles between page loads reads as data that is changing.
    const input = [
      { name: 'Z', email: 'z@example.com', commits: 5 },
      { name: 'A', email: 'a@example.com', commits: 5 },
    ]

    expect(mergeTallies(input).map(row => row.email)).toEqual(mergeTallies(input).map(row => row.email))
    expect(mergeTallies(input)[0]!.email).toBe('a@example.com')
  })

  it('caps the list, because four thousand rows credit nobody', () => {
    const many = Array.from({ length: MAX_CONTRIBUTORS + 40 }, (_, index) => ({
      name: `P${index}`,
      email: `p${index}@example.com`,
      commits: index + 1,
    }))

    expect(mergeTallies(many)).toHaveLength(MAX_CONTRIBUTORS)
    // The cap keeps the *top*, not the first hundred it happened to see.
    expect(mergeTallies(many)[0]!.commits).toBe(MAX_CONTRIBUTORS + 40)
  })
})

describe('contributorRows', () => {
  const contributors = [
    { name: 'Chris', email: 'chris@example.com', commits: 40 },
    { name: 'A Stranger', email: 'nobody@example.org', commits: 3 },
  ]

  const accounts = new Map([
    ['chris@example.com', { handle: 'chrisbbreuer', name: 'Chris', avatarUrl: 'https://example.com/a.png' }],
  ])

  it('links the people with an account here to their profile', () => {
    const rows = contributorRows(contributors, accounts, count)

    expect(rows[0]!.href).toBe('/chrisbbreuer')
    expect(rows[0]!.known).toBe(true)
    expect(rows[0]!.avatarUrl).toBe('https://example.com/a.png')
  })

  it('still names everybody else, with no link', () => {
    // On a mirror almost nobody has an account here. A list of only the people
    // who do would credit four of the two hundred who wrote the code.
    const rows = contributorRows(contributors, accounts, count)

    expect(rows[1]!.name).toBe('A Stranger')
    expect(rows[1]!.href).toBe('')
    expect(rows[1]!.known).toBe(false)
  })

  it('never renders the address', () => {
    // It is the key this is grouped by, and a public page is a different
    // audience from somebody who has cloned the repository.
    const rows = contributorRows(contributors, accounts, count)

    expect(JSON.stringify(rows)).not.toContain('@example.com')
    expect(JSON.stringify(rows)).not.toContain('@example.org')
  })

  it('gives everybody an initial to stand in for an avatar', () => {
    const rows = contributorRows(contributors, accounts, count)

    expect(rows[1]!.initial).toBe('A')
  })

  it('matches an account whatever case the commit used', () => {
    const rows = contributorRows([{ name: 'Chris', email: 'CHRIS@Example.com', commits: 1 }], accounts, count)

    expect(rows[0]!.known).toBe(true)
  })

  it('names a commit with no author by the part before the `@`, never the address', () => {
    // The domain is the half that makes an address deliverable, and a public
    // page is exactly where harvesting happens.
    const rows = contributorRows([{ name: '', email: 'ghost@example.net', commits: 1 }], new Map(), count)

    expect(rows[0]!.name).toBe('ghost')
    expect(rows[0]!.name).not.toContain('@')
  })
})

describe('displayName', () => {
  it('uses the name git recorded when there is one', () => {
    expect(displayName('Chris', 'chris@example.com')).toBe('Chris')
  })

  it('falls back to the local part, and never to the whole address', () => {
    expect(displayName('', 'chris@example.com')).toBe('chris')
    expect(displayName('   ', 'chris@example.com')).toBe('chris')
  })

  it('has something to say even with neither', () => {
    expect(displayName('', '')).toBe('Unknown')
  })
})

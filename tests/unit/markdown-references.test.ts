// References inside user-written text.
//
// Two of these have consequences beyond display: a closing keyword closes
// somebody's issue, and a mention notifies somebody. So the tests lean on the
// cases where text lies: references inside code samples, email addresses that
// look like mentions, and numbers that look like SHAs.

import { describe, expect, test } from 'bun:test'
import {
  closingReferences,
  codeSpans,
  commitReferences,
  issueReferences,
  userReferences,
} from '../../app/Actions/Markdown/references'

describe('issueReferences', () => {
  test('finds a plain reference', () => {
    expect(issueReferences('see #12 for context')).toEqual([{ owner: null, repository: null, number: 12 }])
  })

  test('finds a cross-repository reference', () => {
    expect(issueReferences('see reviewos/core#7')).toEqual([
      { owner: 'reviewos', repository: 'core', number: 7 },
    ])
  })

  test('finds several in one body', () => {
    expect(issueReferences('#1 and #2 and #3')).toHaveLength(3)
  })

  test('ignores a reference inside inline code', () => {
    expect(issueReferences('use `#12` as the anchor')).toEqual([])
  })

  test('ignores a reference inside a fenced block', () => {
    const body = ['before', '```sh', 'grep #12 file', '```', 'after'].join('\n')

    expect(issueReferences(body)).toEqual([])
  })

  test('still finds references outside a fenced block', () => {
    const body = ['fixes #5', '```', '#6', '```', 'and #7'].join('\n')
    const numbers = issueReferences(body).map(reference => reference.number)

    expect(numbers).toContain(5)
    expect(numbers).toContain(7)
    expect(numbers).not.toContain(6)
  })

  test('ignores a URL fragment', () => {
    // `page#12` is an anchor, not an issue.
    expect(issueReferences('https://example.com/page#12')).toEqual([])
  })

  test('ignores #0, which is never an issue', () => {
    expect(issueReferences('#0')).toEqual([])
  })

  test('reads the number, not the digits around it', () => {
    expect(issueReferences('#123abc')).toEqual([])
  })
})

describe('userReferences', () => {
  test('finds a mention', () => {
    expect(userReferences('cc @chris')).toEqual([{ handle: 'chris' }])
  })

  test('lowercases, so a mention matches the stored handle', () => {
    expect(userReferences('cc @Chris')).toEqual([{ handle: 'chris' }])
  })

  test('ignores an email address', () => {
    // This is the one that notifies a stranger if it goes wrong.
    expect(userReferences('mail chris@example.com')).toEqual([])
  })

  test('ignores a mention inside code', () => {
    expect(userReferences('`@chris`')).toEqual([])
    expect(userReferences('```\n@chris\n```')).toEqual([])
  })

  test('finds a hyphenated handle', () => {
    expect(userReferences('@review-os')).toEqual([{ handle: 'review-os' }])
  })

  test('does not run past the handle', () => {
    expect(userReferences('@chris, hello')).toEqual([{ handle: 'chris' }])
  })
})

describe('commitReferences', () => {
  test('finds an abbreviated sha', () => {
    expect(commitReferences('see 1a2b3c4 for the fix')).toEqual(['1a2b3c4'])
  })

  test('finds a full sha', () => {
    const sha = 'a'.repeat(40)

    expect(commitReferences(`see ${sha}`)).toEqual([sha])
  })

  test('ignores a plain number', () => {
    expect(commitReferences('build 1234567 passed')).toEqual([])
  })

  test('ignores a sha inside code', () => {
    expect(commitReferences('`1a2b3c4`')).toEqual([])
  })

  test('ignores something too short to be a sha', () => {
    expect(commitReferences('deadbe')).toEqual([])
  })
})

describe('closingReferences', () => {
  test('finds every keyword form', () => {
    for (const keyword of ['close', 'closes', 'closed', 'fix', 'fixes', 'fixed', 'resolve', 'resolves', 'resolved'])
      expect(closingReferences(`${keyword} #4`)).toHaveLength(1)
  })

  test('is case insensitive', () => {
    expect(closingReferences('Fixes #4')).toHaveLength(1)
    expect(closingReferences('FIXES #4')).toHaveLength(1)
  })

  test('accepts a colon after the keyword', () => {
    expect(closingReferences('fixes: #4')).toHaveLength(1)
  })

  test('finds a cross-repository closing reference', () => {
    expect(closingReferences('fixes reviewos/core#9')[0]).toEqual({
      keyword: 'fixes',
      owner: 'reviewos',
      repository: 'core',
      number: 9,
    })
  })

  test('ignores a keyword that is part of another word', () => {
    // `prefixes #4` must not close issue 4.
    expect(closingReferences('prefixes #4')).toEqual([])
    expect(closingReferences('unclosed #4')).toEqual([])
  })

  test('ignores a keyword with no reference after it', () => {
    expect(closingReferences('this fixes the problem')).toEqual([])
  })

  test('ignores a closing keyword inside a code sample', () => {
    // Documentation that shows how to close an issue must not close one.
    const body = ['Write this in your commit:', '```', 'fixes #12', '```'].join('\n')

    expect(closingReferences(body)).toEqual([])
  })

  test('ignores a keyword separated from the reference by other words', () => {
    expect(closingReferences('fixes the thing in #12')).toEqual([])
  })
})

describe('codeSpans', () => {
  test('covers a fenced block', () => {
    const body = 'a\n```\nb\n```\nc'

    expect(codeSpans(body).length).toBeGreaterThan(0)
  })

  test('covers inline code', () => {
    expect(codeSpans('a `b` c')).toHaveLength(1)
  })

  test('covers a tilde fence', () => {
    expect(codeSpans('~~~\nx\n~~~').length).toBeGreaterThan(0)
  })

  test('finds nothing in plain prose', () => {
    expect(codeSpans('just words here')).toEqual([])
  })
})

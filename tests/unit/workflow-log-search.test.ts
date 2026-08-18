// Finding a line in a run's output.
//
// A failed job prints ten thousand lines and the one that matters says
// `error TS2345`. What people do instead of searching is scroll, and the reason
// is that the box does not exist.

import { describe, expect, test } from 'bun:test'
import { MAX_MATCHES, searchLog } from '../../app/Actions/Workflow/logSearch'

const LOG = [
  'installing dependencies',
  'compiling src/a.ts',
  'src/a.ts(12,5): error TS2345: not assignable',
  'compiling src/b.ts',
  'src/b.ts(3,1): error TS2304: cannot find name',
  'done',
].join('\n')

describe('what it finds', () => {
  test('the lines that contain the query, with numbers a link can point at', () => {
    const matches = searchLog({ jobId: 7, jobName: 'Typecheck', text: LOG, query: 'error TS' })

    // Counting from one, because that is what an editor, a compiler and a
    // person all mean by a line number.
    expect(matches.map(one => one.line)).toEqual([3, 5])
    expect(matches[0]!.text).toContain('TS2345')
    expect(matches[0]!.jobName).toBe('Typecheck')
  })

  test('case-insensitively, because nobody types the case of an error', () => {
    expect(searchLog({ jobId: 1, jobName: 'j', text: LOG, query: 'ts2345' }).length).toBe(1)
  })

  test('and nothing at all for an empty query', () => {
    // A blank search box submitted by accident should not report every line in
    // the run as a match.
    expect(searchLog({ jobId: 1, jobName: 'j', text: LOG, query: '   ' })).toEqual([])
  })
})

describe('what it does not do', () => {
  test('treat the query as a pattern', () => {
    /*
     * A regular expression box on a log search is a way to hang the server on
     * something somebody pasted, and what people actually type is a symbol name
     * or an error code.
     */
    expect(searchLog({ jobId: 1, jobName: 'j', text: 'a.b.c', query: 'a.b' }).length).toBe(1)
    expect(searchLog({ jobId: 1, jobName: 'j', text: 'axbxc', query: 'a.b' }).length).toBe(0)
  })

  test('or report more matches than anybody would read', () => {
    const many = Array.from({ length: 500 }, () => 'error here').join('\n')
    const matches = searchLog({ jobId: 1, jobName: 'j', text: many, query: 'error' })

    // Past this the thing to change is the query, not the page.
    expect(matches.length).toBe(MAX_MATCHES)
  })
})

describe('a very long line', () => {
  test('is clipped around the match rather than at the end', () => {
    /*
     * A match on a minified line is a thousand characters of noise around six
     * that matter, and clipping at the end usually cuts off the part somebody
     * searched for.
     */
    const line = `${'x'.repeat(400)}NEEDLE${'y'.repeat(400)}`
    const [match] = searchLog({ jobId: 1, jobName: 'j', text: line, query: 'needle' })

    expect(match!.text).toContain('NEEDLE')
    expect(match!.text.length).toBeLessThan(300)
    expect(match!.text.startsWith('…')).toBe(true)
    expect(match!.text.endsWith('…')).toBe(true)
  })
})

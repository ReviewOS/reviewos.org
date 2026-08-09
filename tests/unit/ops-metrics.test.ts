/**
 * Metrics, in the format a scraper reads.
 *
 * Two things go wrong with a metrics endpoint, and only one of them is
 * noticeable: a malformed scrape is rejected loudly, and a **cardinality
 * explosion** is silent right up until the scraper falls over. So the tests
 * that matter here are about labels and about the exposition format being
 * exactly what a collector expects, character for character.
 */

import { beforeEach, describe, expect, it } from 'bun:test'
import { gauge, increment, observe, observeGit, render, resetMetrics, snapshot } from '../../app/Ops/metrics'

beforeEach(() => {
  resetMetrics()
})

describe('counting', () => {
  it('adds up', () => {
    increment('reviewos_http_requests_total', { method: 'GET' })
    increment('reviewos_http_requests_total', { method: 'GET' })

    expect(snapshot().counters['reviewos_http_requests_total{method="GET"}']).toBe(2)
  })

  it('keeps different labels apart', () => {
    increment('reviewos_http_requests_total', { method: 'GET' })
    increment('reviewos_http_requests_total', { method: 'POST' })

    expect(Object.keys(snapshot().counters)).toHaveLength(2)
  })

  it('sorts labels, so one series has one key', () => {
    /*
     * `{a="1",b="2"}` and `{b="2",a="1"}` are the same series and would
     * otherwise be counted as two - which shows up as a graph that reads half
     * the real number, and nobody suspects the label order.
     */
    increment('thing', { b: '2', a: '1' })
    increment('thing', { a: '1', b: '2' })

    expect(snapshot().counters['thing{a="1",b="2"}']).toBe(2)
  })
})

describe('timing', () => {
  it('puts a value in the right bucket', () => {
    observe('reviewos_http_request_seconds', 0.05)

    const histogram = snapshot().histograms.reviewos_http_request_seconds

    expect(histogram?.count).toBe(1)
    // 0.05 is over 0.01 and under 0.1.
    expect(histogram?.buckets['0.1']).toBe(1)
    expect(histogram?.buckets['0.01']).toBe(0)
  })

  it('gives git its own, wider buckets', () => {
    /*
     * A `rev-parse` is a millisecond and a clone is minutes. Sharing the HTTP
     * buckets would put every real git operation in the overflow and every
     * trivial one in the first, which is a histogram that answers nothing.
     */
    observeGit('clone', 45)

    const text = render()

    expect(text).toContain('reviewos_git_operation_seconds_bucket{operation="clone",le="60"} 1')
  })
})

describe('the exposition format', () => {
  it('declares a type and a meaning for every metric', () => {
    // A metric without them is a metric whose meaning lives in somebody's head.
    increment('reviewos_http_requests_total', { method: 'GET', route: '/api', status: '2xx' })

    const text = render()

    expect(text).toContain('# TYPE reviewos_http_requests_total counter')
    expect(text).toContain('# HELP reviewos_http_requests_total')
  })

  it('emits cumulative buckets and a +Inf', () => {
    /*
     * Prometheus histograms are cumulative: each bucket counts everything at or
     * below its bound. A histogram without `+Inf` is one a collector reports as
     * malformed rather than as missing a bucket.
     */
    observe('thing_seconds', 0.005)
    observe('thing_seconds', 0.05)
    observe('thing_seconds', 100)

    const text = render()

    expect(text).toContain('thing_seconds_bucket{le="0.01"} 1')
    expect(text).toContain('thing_seconds_bucket{le="0.1"} 2')
    expect(text).toContain('thing_seconds_bucket{le="+Inf"} 3')
    expect(text).toContain('thing_seconds_count 3')
  })

  it('keeps the extra bucket label alongside the ones already there', () => {
    // `le` is appended to an existing label set rather than replacing it, or
    // every operation's histogram collapses into one.
    observeGit('diff', 1)

    expect(render()).toContain('reviewos_git_operation_seconds_bucket{operation="diff",le="2"} 1')
  })

  it('escapes a label value', () => {
    /*
     * A repository name reaches these. A quote or a newline in one produces a
     * scrape the collector rejects wholesale, so one badly named repository
     * would take every metric on the instance with it.
     */
    gauge('thing', 1, { name: 'a"quote' })

    const text = render()

    expect(text).toContain('a\\"quote')
    expect(text).not.toContain('a"quote"}')
  })

  it('ends with a newline, which the format requires', () => {
    increment('thing')

    expect(render().endsWith('\n')).toBe(true)
  })
})

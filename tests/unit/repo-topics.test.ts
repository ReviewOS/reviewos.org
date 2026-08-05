// Topics, and why they are normalised.
//
// The value of a topic is the query that runs the other way - every repository
// tagged `rust` - and that only works if `Rust` and `rust` are one topic. So
// this is a rule with tests rather than a `toLowerCase()` at whichever call
// site remembered.

import { describe, expect, test } from 'bun:test'
import { decideTopics, MAX_TOPIC_LENGTH, MAX_TOPICS, normalizeTopic, topicChanges } from '../../app/Actions/Repo/topics'

describe('normalizeTopic', () => {
  test('folds case, so one topic is one topic', () => {
    expect(normalizeTopic('TypeScript')).toBe('typescript')
    expect(normalizeTopic('RUST')).toBe('rust')
  })

  test('spaces and underscores become dashes', () => {
    expect(normalizeTopic('code review')).toBe('code-review')
    expect(normalizeTopic('code_review')).toBe('code-review')
    expect(normalizeTopic('  code   review  ')).toBe('code-review')
  })

  test('runs of dashes collapse, and the ends are trimmed', () => {
    expect(normalizeTopic('--code---review--')).toBe('code-review')
  })

  /** `3d`, `2fa` and `c99` are real topics. */
  test('a topic may start with a digit', () => {
    expect(normalizeTopic('3D')).toBe('3d')
    expect(normalizeTopic('2FA')).toBe('2fa')
  })

  test('keeps the punctuation that is part of a name', () => {
    expect(normalizeTopic('c++')).toBe('c++')
    expect(normalizeTopic('c#')).toBe('c#')
    expect(normalizeTopic('vue.js')).toBe('vue.js')
  })

  test('anything left with nothing in it is null', () => {
    for (const value of ['', '   ', '---', '!!!', '😀', null, undefined])
      expect(normalizeTopic(value), JSON.stringify(value)).toBeNull()
  })

  test('refuses a topic nobody could read', () => {
    expect(normalizeTopic('x'.repeat(MAX_TOPIC_LENGTH))).not.toBeNull()
    expect(normalizeTopic('x'.repeat(MAX_TOPIC_LENGTH + 1))).toBeNull()
  })
})

describe('decideTopics', () => {
  test('reads a list, an array or a comma-separated string', () => {
    expect(decideTopics(['git', 'forge']).topics).toEqual(['git', 'forge'])
    expect(decideTopics('git, forge').topics).toEqual(['git', 'forge'])
    expect(decideTopics('git\nforge').topics).toEqual(['git', 'forge'])
  })

  test('the same topic typed twice is one topic, not an error', () => {
    const decision = decideTopics(['TypeScript', 'typescript', 'TYPESCRIPT'])

    expect(decision.topics).toEqual(['typescript'])
    expect(decision.rejected).toEqual([])
  })

  /**
   * A space is a dash, not nothing. `code review` and `code-review` have to be
   * the same topic, which means `type script` is `type-script` - a different
   * topic from `typescript`, and correctly so: collapsing spaces away would
   * make `go lang` and `golang` the same and `no de` and `node` too.
   */
  test('a space is a dash, so spacing is not silently significant', () => {
    expect(decideTopics(['code review', 'code-review']).topics).toEqual(['code-review'])
    expect(decideTopics(['type script', 'typescript']).topics).toEqual(['type-script', 'typescript'])
  })

  /**
   * A form that silently discards one of the six things you typed is a form
   * you stop trusting.
   */
  test('says what it could not use rather than dropping it quietly', () => {
    const decision = decideTopics(['git', '!!!', 'x'.repeat(80)])

    expect(decision.topics).toEqual(['git'])
    expect(decision.rejected).toEqual(['!!!', 'x'.repeat(80)])
  })

  test('keeps the order they were given in', () => {
    expect(decideTopics(['zebra', 'apple', 'mango']).topics).toEqual(['zebra', 'apple', 'mango'])
  })

  test('caps the list, and reports what did not fit', () => {
    const many = Array.from({ length: MAX_TOPICS + 3 }, (_, index) => `topic-${index}`)
    const decision = decideTopics(many)

    expect(decision.topics).toHaveLength(MAX_TOPICS)
    expect(decision.rejected).toHaveLength(3)
  })

  test('an empty list is empty rather than an error', () => {
    expect(decideTopics([])).toEqual({ topics: [], rejected: [] })
    expect(decideTopics('')).toEqual({ topics: [], rejected: [] })
  })

  test('blank entries between commas are skipped, not rejected', () => {
    expect(decideTopics('git,,forge,')).toEqual({ topics: ['git', 'forge'], rejected: [] })
  })
})

describe('topicChanges', () => {
  /**
   * Computed rather than delete-all-and-reinsert, so a topic that did not
   * change keeps its row - and its created_at, which is the only record of when
   * a repository started calling itself that.
   */
  test('touches only what changed', () => {
    expect(topicChanges(['git', 'forge'], ['git', 'review'])).toEqual({ add: ['review'], remove: ['forge'] })
  })

  test('an unchanged list changes nothing', () => {
    expect(topicChanges(['git', 'forge'], ['forge', 'git'])).toEqual({ add: [], remove: [] })
  })

  test('clearing removes everything', () => {
    expect(topicChanges(['git'], [])).toEqual({ add: [], remove: ['git'] })
  })

  test('starting from nothing adds everything', () => {
    expect(topicChanges([], ['git'])).toEqual({ add: ['git'], remove: [] })
  })
})

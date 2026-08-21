// The fixed corpus, and whether it still describes the diffs it names.
//
// A manifest of shas is only worth having if the numbers beside them are true.
// These check the shape without needing a clone; the counts themselves are
// verified against git by `buddy bench --verify`, which needs one.

import { describe, expect, test } from 'bun:test'
import { CORPUS, CORPUS_REMOTE, CORPUS_SOURCES, changedLines, cloneCommands, corpusEntry } from '../../app/Actions/Bench/corpus'

describe('the corpus', () => {
  test('pins commits rather than tags', () => {
    // `v6.17~75` is a moving target the moment anybody rewrites history, and a
    // benchmark whose input changed underneath it reports a regression that
    // never happened.
    for (const entry of CORPUS) {
      expect(entry.base).toMatch(/^[0-9a-f]{40}$/)
      expect(entry.head).toMatch(/^[0-9a-f]{40}$/)
    }
  })

  test('covers four orders of magnitude, because one size proves nothing', () => {
    const sizes = CORPUS.map(changedLines).sort((a, b) => a - b)

    expect(sizes.length).toBe(4)
    // Smallest is an ordinary review; largest is the perf bar. A corpus whose
    // entries are all the same size measures one thing four times.
    expect(sizes[0]).toBeLessThan(1000)
    expect(sizes[sizes.length - 1]!).toBeGreaterThan(1_000_000)
  })

  test('says what each entry is for', () => {
    for (const entry of CORPUS) {
      expect(entry.purpose.length).toBeGreaterThan(30)
      expect(entry.files).toBeGreaterThan(0)
    }
  })

  test('names are unique and findable', () => {
    expect(new Set(CORPUS.map(entry => entry.name)).size).toBe(CORPUS.length)
    expect(corpusEntry('kernel')?.files).toBe(80610)
    expect(corpusEntry('nothing-like-this')).toBeUndefined()
  })
})

describe('where the corpus comes from', () => {
  /**
   * A fixed corpus is only fixed if somebody can get it.
   *
   * The manifest named GitHub alone, so every machine that wanted to reproduce
   * a number this project publishes cloned six and a half gigabytes from
   * somebody else's servers to do it. Serving the input to our own benchmark is
   * our job, and this instance already mirrors the repository.
   */
  test('this instance is tried first', () => {
    expect(CORPUS_SOURCES[0]!.url).toContain('reviewos.org')
    expect(CORPUS_REMOTE).toBe(CORPUS_SOURCES[0]!.url)
  })

  test('and upstream stays, so the shas can be checked against it', () => {
    // A corpus only one host can serve stops existing when that host does - and
    // nobody should have to take our word for what is in a sha.
    expect(CORPUS_SOURCES.some(source => source.url.includes('github.com/torvalds/linux'))).toBe(true)
  })

  test('every source says why it is in the list', () => {
    for (const source of CORPUS_SOURCES) {
      expect(source.url.startsWith('https://')).toBe(true)
      expect(source.why.length).toBeGreaterThan(30)
    }
  })

  test('the clone commands are bare, because nothing here reads a working tree', () => {
    const commands = cloneCommands('storage/repos/reviewos/linux.git')

    expect(commands.length).toBe(CORPUS_SOURCES.length)
    expect(commands.every(command => command.includes('--bare'))).toBe(true)
    expect(commands.every(command => command.includes('storage/repos/reviewos/linux.git'))).toBe(true)
  })
})

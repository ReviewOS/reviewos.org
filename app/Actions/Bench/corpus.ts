/**
 * The fixed corpus the diff engine is measured against.
 *
 * Written as a **manifest rather than as committed bytes**: every entry is a
 * pair of commit shas in `torvalds/linux`, so anybody with a clone rebuilds the
 * identical diff and nobody commits six gigabytes to get one. The shas are
 * pinned rather than the tag names resolved at run time, because `v6.17~75` is
 * a moving target the moment somebody rewrites history and a number that
 * changed underneath a benchmark is worse than no benchmark.
 *
 * ## Why this exists at all
 *
 * A measurement taken on whatever diff was to hand is a measurement that cannot
 * be repeated, and one of those cost three wrong diagnoses in a single sitting:
 * a "226 files in two minutes" figure was recorded against a cold git object
 * cache, could not be reproduced afterwards, and sent the search for a
 * bottleneck through the client, the row endpoint and the viewer before a
 * control run showed the baseline was the thing at fault.
 *
 * So the corpus is fixed, and `warm` is part of it. Git's object cache is worth
 * a hundredfold on these ranges, which is larger than any effect a change to
 * this codebase is likely to have - so a run that does not say which state it
 * was in is a run that says nothing.
 */

export interface CorpusEntry {
  /** How it is referred to in a result table. */
  name: string
  /** What shape of change it stands for. */
  purpose: string
  base: string
  head: string
  /** Counted with `--no-renames`, which is how the engine reads it. */
  files: number
  additions: number
  deletions: number
}

/**
 * Where the corpus is cloned from, in the order to try.
 *
 * **This instance first**, which is the half that was missing: the manifest
 * named GitHub, so every machine that wanted to run a benchmark cloned six and
 * a half gigabytes from somebody else's servers to reproduce a number this
 * project publishes. Pierre host their own demo repositories for the same
 * reason and it is the obvious courtesy - the corpus is a fixed input to *our*
 * benchmark, so serving it is our job.
 *
 * `reviewos/linux` is the mirror this instance already keeps (phase 13), so
 * there is nothing to set up: it is the same objects, reachable over the same
 * smart HTTP this product serves to everybody else, and cloning it is a
 * demonstration of the thing being benchmarked.
 *
 * GitHub stays as the fallback, because a fixed corpus that only one host can
 * serve is a corpus that stops existing when that host is down - and because
 * anybody reading this should be able to check the shas against upstream
 * without taking our word for what is in them.
 */
export const CORPUS_SOURCES: readonly { name: string, url: string, why: string }[] = [
  {
    name: 'this instance',
    url: 'https://reviewos.org/reviewos/linux.git',
    why: 'The mirror this project serves, so a benchmark does not clone six gigabytes from somebody else.',
  },
  {
    name: 'upstream',
    url: 'https://github.com/torvalds/linux.git',
    why: 'The same objects, so the shas can be checked against upstream rather than taken on trust.',
  },
]

/** The first source to try. Kept as a name because the commands print it. */
export const CORPUS_REMOTE = CORPUS_SOURCES[0]!.url

/**
 * The clone commands, in order, for a command that has to tell somebody how to
 * get the corpus.
 *
 * `--bare`, because nothing here reads a working tree and checking one out of
 * the kernel is a gigabyte of files nobody looks at.
 */
export function cloneCommands(path: string): string[] {
  return CORPUS_SOURCES.map(source => `git clone --bare ${source.url} ${path}   # ${source.name}`)
}

/**
 * Four sizes, each standing for a case the engine has to be good at.
 *
 * The small one is the everyday review and the one a regression would be felt
 * on first. The large one is the case nothing else in this project can produce:
 * eighty thousand files, where every assumption about holding a diff in memory
 * stops being theoretical.
 */
export const CORPUS: readonly CorpusEntry[] = [
  {
    name: 'small',
    purpose: 'An ordinary pull request - the case a regression is felt on first.',
    base: '51a24b7deaae5c3561965f5b4b27bb9d686add1c',
    head: '6063257da111c7639d020c5f15bfb37fb839d8b6',
    files: 19,
    additions: 116,
    deletions: 50,
  },
  {
    name: 'medium',
    purpose: 'A few thousand changed lines: a large feature branch, or a week of a busy repository.',
    base: '22f20375f5b71f30c0d6896583b93b6e4bba7279',
    head: '6063257da111c7639d020c5f15bfb37fb839d8b6',
    files: 452,
    additions: 4407,
    deletions: 1877,
  },
  {
    name: 'large',
    purpose: 'Thirty thousand changed lines, where virtualization stops being optional.',
    base: 'cca7a0aae8958c9b1cd14116cb8b2f22ace2205e',
    head: '6063257da111c7639d020c5f15bfb37fb839d8b6',
    files: 2186,
    additions: 28567,
    deletions: 12710,
  },
  {
    name: 'kernel',
    purpose: 'Linux v6.0 to v7.0 - the perf bar, and the only diff here git itself is slow on.',
    base: '45eb8ae5370d5df1ee8236f45df3f29103ba6e12',
    head: '3131ff5a117498bb4b9db3a238bb311cbf8383ce',
    files: 80610,
    additions: 12753613,
    deletions: 5629917,
  },
]

/** Total changed lines, which is the number that predicts the work. */
export function changedLines(entry: CorpusEntry): number {
  return entry.additions + entry.deletions
}

/** The entry by name, for a command that takes one. */
export function corpusEntry(name: string): CorpusEntry | undefined {
  return CORPUS.find(entry => entry.name === name)
}

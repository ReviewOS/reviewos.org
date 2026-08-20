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

/** The repository these shas belong to, said once. */
export const CORPUS_REMOTE = 'https://github.com/torvalds/linux.git'

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

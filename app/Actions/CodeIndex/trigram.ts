/**
 * Trigrams, and the posting lists made of them.
 *
 * The pure half of instance-wide code search. Nothing here touches git, the
 * database or the filesystem, which is what makes the index format something a
 * test can hold in memory rather than something only a running instance can be
 * asked about.
 *
 * ## Why trigrams, and what they are allowed to answer
 *
 * A trigram index answers exactly one question: *which files could possibly
 * contain this string*. It cannot answer whether they do - a file holding
 * `abc`, `bcd` and `cde` in three unrelated places matches the trigrams of
 * `abcde` without containing it. So this narrows and `git grep` decides, which
 * is the whole design: the index may be stale or permissive and the answer is
 * still exact, because the answer is read out of the tree at the ref the way
 * in-repository search already works.
 *
 * The direction of the error is the property to protect, and the tests assert
 * it: a false *positive* costs a grep of a file that turns out not to match, a
 * false *negative* is a result nobody ever sees. Everything here is arranged so
 * the second cannot happen - a query the index cannot narrow returns "search
 * everything" rather than "nothing".
 */

/** How many bytes make a gram. Three: the smallest that is selective enough. */
export const GRAM = 3

/**
 * The distinct trigrams of a string, lowercased.
 *
 * Case is folded at both ends - here and when a document is indexed - so a
 * case-insensitive search is the cheap path. A case-*sensitive* search still
 * narrows with the folded index and then greps with the case it was given,
 * which is correct because folding only ever widens the candidate set.
 *
 * Bytes rather than characters: a multi-byte character is several trigrams and
 * that is fine, because the same bytes are indexed on the way in. Splitting on
 * code points would build an index that agrees with itself and disagrees with
 * `git grep`, which searches bytes.
 */
export function trigrams(value: string): Set<string> {
  const found = new Set<string>()
  const bytes = new TextEncoder().encode(value.toLowerCase())

  for (let index = 0; index + GRAM <= bytes.length; index += 1) {
    // Latin-1 on the way back: the key is an opaque three-byte token, and
    // decoding it as text would fold distinct byte sequences onto one
    // replacement character.
    found.add(String.fromCharCode(bytes[index]!, bytes[index + 1]!, bytes[index + 2]!))
  }

  return found
}

/**
 * The trigrams a *query* must have, or null when it cannot be narrowed.
 *
 * Null is the honest answer for a query shorter than a trigram, and for a regex
 * whose literal runs are all too short. An empty set would read as "no
 * candidates" to one caller and "every file" to another, and the first finds
 * nothing.
 */
export function queryTrigrams(pattern: string, regex = false): Set<string> | null {
  if (!regex) {
    const grams = trigrams(pattern)

    return grams.size > 0 ? grams : null
  }

  /*
   * A regex narrows only by the literal runs inside it, and only when *every*
   * path through the pattern must contain them.
   *
   * Two constructs break that and both are refused rather than guessed at:
   * alternation, because `foo|bar` matches a file holding none of `foo`; and a
   * quantifier over a *literal*, because `colou?r` matches `color`, which does
   * not contain `our`. Being conservative is the whole reason this can be
   * trusted - an index that declines to help is a slow search, and one that
   * excludes the file somebody wants is a search nobody believes.
   *
   * A quantifier over a class or an escape is fine and common:
   * `^\s*function handleRequest` must still contain `function handleRequest`,
   * and refusing it would decline the shape people actually type. So classes
   * and escapes are removed *with* their quantifiers first, and what is left is
   * checked for the dangerous kind.
   */
  const withoutClasses = pattern
    .replace(/\\[a-zA-Z][*+?]?(?:\{\d*(?:,\d*)?\})?/g, ' ')
    .replace(/\[[^\]]*\][*+?]?(?:\{\d*(?:,\d*)?\})?/g, ' ')
    .replace(/\\./g, ' ')

  if (/[|?*+{]/.test(withoutClasses))
    return null

  const runs = withoutClasses
    .split(/[.^$()]/)
    .map(run => run.trim())
    .filter(run => run.length >= GRAM)

  if (runs.length === 0)
    return null

  // Every match must contain the longest run in full, so every matching
  // document holds all of that run's trigrams.
  const longest = runs.reduce((best, run) => (run.length > best.length ? run : best), '')
  const grams = trigrams(longest)

  return grams.size > 0 ? grams : null
}

/**
 * One repository's index: which files hold which trigrams.
 *
 * `paths` is the file table and a posting list is a list of *indices into it*,
 * which is what keeps a shard small - a path is stored once however many
 * trigrams it contains.
 */
export interface Shard {
  /** The commit it was built from, so staleness is a fact rather than a guess. */
  commit: string
  /** The ref it was built from, because a repository has more than one. */
  ref: string
  paths: string[]
  /** trigram -> ascending file indices. */
  postings: Map<string, number[]>
  /** Files skipped for being binary or oversized, so a reader knows the gap. */
  skipped: number
}

/**
 * The summary that decides whether a shard is worth opening at all.
 *
 * A shard for a real repository is megabytes. Measured on this codebase: 10MB,
 * and decoding one costs about 150ms - which across a thousand repositories is
 * two and a half minutes before a single line is searched. So every shard opens
 * with a bitmap of the trigrams it holds, and a repository that cannot match is
 * dismissed by reading the first few tens of kilobytes and testing some bits.
 *
 * 2^18 bits is 32KB. On a repository with 78,000 distinct trigrams that is a
 * load factor of about 0.3, and a false positive costs a shard read rather than
 * a wrong answer.
 */
export const SUMMARY_BITS = 1 << 18

/** Where a trigram lands in the bitmap. */
export function summaryBit(gram: string): number {
  // FNV-1a over the three bytes. Not for security: for spread. The bytes used
  // directly would put every gram of ASCII source into the low quarter of the
  // map and leave the rest empty.
  let hash = 0x811C9DC5

  for (let index = 0; index < gram.length; index += 1) {
    hash ^= gram.charCodeAt(index) & 0xFF
    hash = Math.imul(hash, 0x01000193) >>> 0
  }

  return hash % SUMMARY_BITS
}

/** The bitmap of everything a shard holds. */
export function summaryOf(shard: Shard): Uint8Array {
  const bitmap = new Uint8Array(SUMMARY_BITS / 8)

  for (const gram of shard.postings.keys()) {
    const bit = summaryBit(gram)
    bitmap[bit >> 3]! |= 1 << (bit & 7)
  }

  return bitmap
}

/**
 * Whether this shard could hold every one of these trigrams.
 *
 * False is certain - a bit that is not set was never indexed - and true is a
 * maybe, which is the direction that keeps the index from hiding anything.
 */
export function summaryMightHold(bitmap: Uint8Array, grams: Set<string>): boolean {
  for (const gram of grams) {
    const bit = summaryBit(gram)

    if ((bitmap[bit >> 3]! & (1 << (bit & 7))) === 0)
      return false
  }

  return true
}

/** An empty shard, which narrows nothing and hides nothing. */
export function emptyShard(ref: string, commit: string): Shard {
  return { ref, commit, paths: [], postings: new Map(), skipped: 0 }
}

/** Add one file's contents to a shard under construction. */
export function addDocument(shard: Shard, path: string, contents: string): void {
  const id = shard.paths.length

  shard.paths.push(path)

  for (const gram of trigrams(contents)) {
    const list = shard.postings.get(gram)

    if (list)
      list.push(id)
    else
      shard.postings.set(gram, [id])
  }
}

/**
 * The files that could contain every one of these trigrams.
 *
 * An intersection, smallest list first, because the cost is dominated by the
 * first list. A trigram the shard has never seen means *no* file contains it,
 * which is the one case where the index can honestly answer "nothing here" -
 * and it is the common case for a specific identifier across an instance, which
 * is what makes this worth building.
 */
export function candidates(shard: Shard, grams: Set<string>): string[] {
  if (grams.size === 0)
    return shard.paths.slice()

  const lists: number[][] = []

  for (const gram of grams) {
    const list = shard.postings.get(gram)

    if (!list)
      return []

    lists.push(list)
  }

  lists.sort((left, right) => left.length - right.length)

  let living = new Set(lists[0])

  for (const list of lists.slice(1)) {
    const next = new Set<number>()

    for (const id of list) {
      if (living.has(id))
        next.add(id)
    }

    living = next

    if (living.size === 0)
      return []
  }

  return [...living].sort((left, right) => left - right).map(id => shard.paths[id]!).filter(Boolean)
}

/** A trigram as it is written in a shard: three bytes, hex. */
export function gramKey(gram: string): string {
  return [...gram].map(char => char.charCodeAt(0).toString(16).padStart(2, '0')).join('')
}

/**
 * A shard as bytes.
 *
 * A plain, self-describing text format rather than something clever: a shard is
 * rebuilt from the repository whenever it is wrong, so nothing here needs to
 * survive a format change - and the first time somebody debugs a wrong result,
 * being able to read the file is worth more than the bytes a bitmap would save.
 *
 * Postings are delta-encoded because the ids ascend, which is what makes that
 * plain format compact enough to keep: `4 5 6 7` becomes `4 1 1 1`, and a
 * common trigram in a large repository is thousands of ones.
 */
export function encodeShard(shard: Shard): string {
  const lines: string[] = [
    '# reviewos code index v1',
    `ref ${shard.ref}`,
    `commit ${shard.commit}`,
    `skipped ${shard.skipped}`,
    // Base64 rather than hex: half the bytes, and this line is read on every
    // query of every repository.
    `summary ${Buffer.from(summaryOf(shard)).toString('base64')}`,
    `paths ${shard.paths.length}`,
    ...shard.paths,
    `postings ${shard.postings.size}`,
  ]

  for (const [gram, list] of shard.postings) {
    const sorted = [...new Set(list)].sort((left, right) => left - right)
    const deltas: number[] = []
    let previous = 0

    for (const id of sorted) {
      deltas.push(id - previous)
      previous = id
    }

    // Hex, so a byte that is a newline, a space or unprintable cannot break the
    // line it is on.
    lines.push(`${gramKey(gram)} ${deltas.join(' ')}`)
  }

  return `${lines.join('\n')}\n`
}

/**
 * And back. Null for anything unrecognised, so a corrupt or older shard is
 * rebuilt rather than half-read.
 */
export function decodeShard(text: string): Shard | null {
  const lines = text.split('\n')

  if (lines[0] !== '# reviewos code index v1')
    return null

  const ref = lines[1]?.startsWith('ref ') ? lines[1].slice(4) : null
  const commit = lines[2]?.startsWith('commit ') ? lines[2].slice(7) : null
  const skipped = lines[3]?.startsWith('skipped ') ? Number(lines[3].slice(8)) : 0

  if (!lines[4]?.startsWith('summary '))
    return null

  const pathCount = lines[5]?.startsWith('paths ') ? Number(lines[5].slice(6)) : Number.NaN

  if (ref === null || commit === null || !Number.isInteger(pathCount))
    return null

  const paths = lines.slice(6, 6 + pathCount)
  const postingsHeader = lines[6 + pathCount]

  if (paths.length !== pathCount || !postingsHeader?.startsWith('postings '))
    return null

  const postings = new Map<string, number[]>()

  for (const line of lines.slice(7 + pathCount)) {
    if (!line)
      continue

    const [key, ...deltas] = line.split(' ')

    if (!key || key.length !== GRAM * 2)
      return null

    const gram = String.fromCharCode(
      Number.parseInt(key.slice(0, 2), 16),
      Number.parseInt(key.slice(2, 4), 16),
      Number.parseInt(key.slice(4, 6), 16),
    )

    const ids: number[] = []
    let running = 0

    for (const delta of deltas) {
      running += Number(delta)
      ids.push(running)
    }

    postings.set(gram, ids)
  }

  return { ref, commit, paths, postings, skipped }
}

/**
 * The header of a shard, read from a prefix of the file.
 *
 * Everything before the file table - the commit it was built from and the
 * bitmap - so a caller can decide whether to read the rest.
 */
export function decodeSummary(prefix: string): { ref: string, commit: string, bitmap: Uint8Array } | null {
  const lines = prefix.split('\n')

  if (lines[0] !== '# reviewos code index v1')
    return null

  const ref = lines[1]?.startsWith('ref ') ? lines[1].slice(4) : null
  const commit = lines[2]?.startsWith('commit ') ? lines[2].slice(7) : null
  const summary = lines[4]?.startsWith('summary ') ? lines[4].slice(8) : null

  if (ref === null || commit === null || summary === null)
    return null

  const bitmap = new Uint8Array(Buffer.from(summary, 'base64'))

  // A truncated read gives a short bitmap, and testing bits against one reads
  // past the end and answers "not present" for everything - the one answer this
  // must never give wrongly.
  if (bitmap.byteLength !== SUMMARY_BITS / 8)
    return null

  return { ref, commit, bitmap }
}

/**
 * The candidates for a query, read straight out of an encoded shard.
 *
 * Decoding a whole shard builds a map of every trigram in the repository -
 * 78,000 entries and millions of file ids on this codebase, about 150ms - to
 * answer a question about twenty of them. This parses only the lines it was
 * asked about, which is the difference between the index costing more than the
 * grep and costing almost nothing.
 *
 * The file is still read whole, deliberately: a sequential read of a few
 * megabytes is milliseconds, and the alternative - an offset table and a seek
 * per trigram - is a format that must be rebuilt when it is wrong and a bug
 * that presents as missing search results.
 */
export function candidatesFromText(text: string, grams: Set<string>): string[] | null {
  const lines = text.split('\n')

  if (lines[0] !== '# reviewos code index v1')
    return null

  const pathCount = lines[5]?.startsWith('paths ') ? Number(lines[5].slice(6)) : Number.NaN

  if (!Number.isInteger(pathCount))
    return null

  const paths = lines.slice(6, 6 + pathCount)

  if (grams.size === 0)
    return paths

  const wanted = new Set<string>()

  for (const gram of grams)
    wanted.add(gramKey(gram))

  const found = new Map<string, number[]>()

  for (let index = 7 + pathCount; index < lines.length; index += 1) {
    const line = lines[index]

    if (!line)
      continue

    // The key is the first six characters, so this is a compare against a small
    // set rather than a split of every line in the file.
    const key = line.slice(0, GRAM * 2)

    if (!wanted.has(key))
      continue

    const ids: number[] = []
    let running = 0

    for (const delta of line.slice(GRAM * 2 + 1).split(' ')) {
      running += Number(delta)
      ids.push(running)
    }

    found.set(key, ids)

    if (found.size === wanted.size)
      break
  }

  // A trigram with no line at all is one no file holds: nothing can match.
  for (const key of wanted) {
    if (!found.has(key))
      return []
  }

  const lists = [...found.values()].sort((left, right) => left.length - right.length)
  let living = new Set(lists[0] ?? [])

  for (const list of lists.slice(1)) {
    const next = new Set<number>()

    for (const id of list) {
      if (living.has(id))
        next.add(id)
    }

    living = next

    if (living.size === 0)
      return []
  }

  return [...living].sort((left, right) => left - right).map(id => paths[id]!).filter(Boolean)
}

import { describe, expect, it } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { recountComments, recountForks, recountOpenIssues, recountStars } from '../../app/Actions/Repo/counters'

/**
 * Every writer that changes a counted thing recounts it.
 *
 * The counters are denormalized on purpose: `repositories.open_issues_count`
 * and the rest exist so a list does not run a `COUNT` per row. What makes a
 * denormalized counter go wrong is not the arithmetic, it is the eighth call
 * site somebody adds a year later without knowing the other seven exist.
 *
 * This is that knowledge, written down where it fails loudly. It reads the
 * action and job sources, finds the writes that change something counted, and
 * insists the same file recounts it. It found `MirrorMetadataSyncJob` on its
 * first run: a mirror imported hundreds of issues at once and the repository
 * went on reading `0 open issues`, which is exactly the kind of wrong nobody
 * files a bug about because it looks like a repository with no issues.
 *
 * It cannot prove the recount happens on every path through a file, only that
 * the file knows it has to. That is the part that gets forgotten; the rest is
 * visible in review.
 */

const ROOTS = ['app/Actions', 'app/Jobs']

interface Rule {
  counted: string
  recount: string
  writes: RegExp[]
  /** Files that write but legitimately leave the recount to their caller, with the caller named. */
  deferredTo?: Record<string, string>
}

const RULES: Rule[] = [
  {
    counted: 'open issues',
    recount: 'recountOpenIssues',
    /**
     * Anything that inserts an issue, deletes one, or moves its state. The
     * state write is the one that hides: closing an issue is an update to a
     * column nobody thinks of as a counter's input.
     */
    writes: [
      /insertInto\(['"]issues['"]\)/,
      /deleteFrom\(['"]issues['"]\)/,
      /updateTable\(['"]issues['"]\)[\s\S]{0,400}?state/,
      /updateWhereIn\(\s*['"]issues['"][\s\S]{0,200}?state/,
    ],
  },
  {
    counted: 'comments',
    recount: 'recountComments',
    writes: [
      /insertInto\(['"]issue_comments['"]\)/,
      /deleteFrom\(['"]issue_comments['"]\)/,
    ],
  },
  {
    counted: 'stars',
    recount: 'recountStars',
    writes: [
      /insertInto\(['"]stars['"]\)/,
      /deleteFrom\(['"]stars['"]\)/,
    ],
  },
  {
    counted: 'forks',
    recount: 'recountForks',
    /**
     * A fork is a repository whose `parent_id` points at another, so the count
     * changes when one is created and when one is detached - which is what
     * deleting a repository does to the forks of it.
     *
     * Anchored to the write rather than to the column name, and for two
     * reasons this rule got wrong before it got right: a pull request has a
     * `stack_parent_id` that counts nothing, and reading `parent_id` into a
     * shape is not writing it. Both made this fail on files with no forks
     * anywhere near them, which is how a test like this stops being read.
     */
    writes: [
      /insertInto\(['"]repositories['"]\)[\s\S]{0,600}?[^_]parent_id:/,
      /updateTable\(['"]repositories['"]\)[\s\S]{0,400}?[^_]parent_id/,
    ],
  },
]

function sources(): { path: string, text: string }[] {
  const found: { path: string, text: string }[] = []

  function walk(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name)

      if (entry.isDirectory())
        walk(full)
      else if (entry.name.endsWith('.ts'))
        found.push({ path: full, text: readFileSync(full, 'utf8') })
    }
  }

  for (const root of ROOTS)
    walk(root)

  return found
}

const FILES = sources()

describe('counted things are recounted by whoever changes them', () => {
  it('finds the sources at all, so a passing run means something', () => {
    expect(FILES.length).toBeGreaterThan(40)
  })

  for (const rule of RULES) {
    it(`recounts ${rule.counted} in every file that writes them`, () => {
      const writers = FILES.filter(file => rule.writes.some(pattern => pattern.test(file.text)))

      // A rule that matches nothing passes forever and proves nothing. Every
      // one of these has real writers today, so a pattern that stops matching
      // is a pattern that broke rather than a codebase that got tidier.
      expect(writers.map(file => file.path).length).toBeGreaterThan(0)

      const missing = writers
        .filter(file => !file.text.includes(rule.recount))
        .map(file => file.path)
        .filter(path => !(rule.deferredTo && path in rule.deferredTo))

      expect(missing).toEqual([])
    })
  }

  /** An allowlist nobody prunes is an allowlist that hides the next real one. */
  it('has no stale entries in the deferred list', () => {
    const stale: string[] = []

    for (const rule of RULES) {
      for (const path of Object.keys(rule.deferredTo ?? {})) {
        const file = FILES.find(candidate => candidate.path === path)

        if (!file || !rule.writes.some(pattern => pattern.test(file.text)))
          stale.push(path)
      }
    }

    expect(stale).toEqual([])
  })
})

describe('the counters themselves', () => {
  // Comments stripped first: this file explains the increment bug at length,
  // and matching the explanation is not the same as matching the code.
  const code = readFileSync('app/Actions/Repo/counters.ts', 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')

  /**
   * The reason this module exists. `.set(eb => ...)` emits an empty `SET`,
   * which Postgres rejects and the surrounding `try` swallows - so not one
   * counter in this product moved until they were recomputed instead. An
   * increment reintroduced here would fail the same way and just as quietly.
   */
  it('recomputes rather than incrementing', () => {
    expect(code).not.toMatch(/\.set\(\s*eb\s*=>/)
    expect(code).toContain('db.fn.count')
  })

  /**
   * A wrong number on a list is never worth failing the close, the comment or
   * the merge that prompted it. These reach no database: an id that cannot
   * name a row is refused before the query, which is also what stops a
   * `COUNT` running for every `undefined` a caller passes.
   */
  it('refuses an id that cannot name a row, without touching the database', async () => {
    for (const recount of [recountOpenIssues, recountStars, recountForks, recountComments]) {
      expect(await recount(0)).toBeNull()
      expect(await recount(-1)).toBeNull()
      expect(await recount(Number.NaN)).toBeNull()
      expect(await recount(undefined as unknown as number)).toBeNull()
    }
  })
})

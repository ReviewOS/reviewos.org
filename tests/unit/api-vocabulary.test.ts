/**
 * One vocabulary.
 *
 * The API says `repository`, `pull request`, `review thread` and `stack`,
 * matching the table in `AGENTS.md`, rather than a second set of names for the
 * same things. A forge that calls it a pull request on one endpoint and a merge
 * request on another has doubled the size of its API in the only dimension that
 * matters to somebody learning it.
 *
 * This reads the generated OpenAPI document rather than the source, because the
 * document is what a client sees, and a name that never reaches the document is
 * an internal one this rule does not govern.
 *
 * It is a guard against drift rather than proof of correctness. The vocabulary
 * is right today; what this makes expensive is the day somebody adds
 * `/api/repos/merge-requests` because that is what they called it at their last
 * job.
 */

import { describe, expect, it } from 'bun:test'

/**
 * Words that mean something this product already has a word for.
 *
 * Each entry is a synonym somebody will reach for, paired with the term that
 * wins. The pairs are the point: a bare blocklist reads as arbitrary, and the
 * next person deletes the line rather than renaming their endpoint.
 */
const SYNONYMS: Array<{ banned: RegExp, instead: string }> = [
  { banned: /merge[-_]?request/i, instead: 'pull request' },
  { banned: /\bmrs?\b/i, instead: 'pull request' },
  { banned: /\bticket/i, instead: 'issue' },
  { banned: /\bdiscussion/i, instead: 'review thread' },
  { banned: /code[-_]?review/i, instead: 'review' },
  { banned: /\bchangeset/i, instead: 'commit, or diff' },
  { banned: /\bpatchset/i, instead: 'commit, or diff' },
  // `repo` is fine as a query parameter and in `/repos/...`, which is what
  // every client of every forge already types. What is banned is a *third*
  // spelling.
  { banned: /\brepos(itor(y|ies))?_id\b/i, instead: 'repository, as a path or a query parameter' },
]

/** Only this application's surface. Framework and dashboard routes are not ours to rename. */
function ours(path: string): boolean {
  return !path.startsWith('/api/dashboard')
    && !path.startsWith('/api/commerce')
    && !path.startsWith('/api/cms')
    && !path.startsWith('/_stacks')
    && !path.startsWith('/__')
}

async function document(): Promise<any> {
  return await Bun.file('storage/framework/api/openapi.json').json()
}

describe('the names in the API', () => {
  it('uses no synonym for something already named', async () => {
    const spec = await document()

    const problems: string[] = []

    for (const path of Object.keys(spec.paths ?? {})) {
      if (!ours(path))
        continue

      for (const { banned, instead } of SYNONYMS) {
        if (banned.test(path))
          problems.push(`${path} - say ${instead}`)
      }
    }

    expect(problems).toEqual([])
  })

  it('and no synonym in a parameter name either', async () => {
    // A path can be right while the thing it takes is called something else,
    // and a parameter name is the part a client actually types.
    const spec = await document()

    const problems: string[] = []

    for (const [path, item] of Object.entries(spec.paths ?? {}) as Array<[string, any]>) {
      if (!ours(path))
        continue

      for (const operation of Object.values(item) as any[]) {
        for (const parameter of operation?.parameters ?? []) {
          for (const { banned, instead } of SYNONYMS) {
            if (banned.test(String(parameter.name)))
              problems.push(`${path} takes ${parameter.name} - say ${instead}`)
          }
        }
      }
    }

    expect(problems).toEqual([])
  })

  it('spells every parameter in snake case', async () => {
    /*
     * `per_page` next to `productId` is two conventions in one document, and a
     * client written against one of them fails on the other in a way that reads
     * as a typo rather than as a rule.
     *
     * Scoped to this application's routes: the framework's own surface is not
     * ours to rename, and failing on it would mean either a permanently red
     * test or an exclusion that quietly grows.
     */
    const spec = await document()

    const problems: string[] = []

    for (const [path, item] of Object.entries(spec.paths ?? {}) as Array<[string, any]>) {
      if (!ours(path))
        continue

      for (const operation of Object.values(item) as any[]) {
        for (const parameter of operation?.parameters ?? []) {
          if (/[A-Z]/.test(String(parameter.name)))
            problems.push(`${path} takes ${parameter.name}`)
        }
      }
    }

    expect(problems).toEqual([])
  })
})

describe('the two spellings that are deliberate', () => {
  it('keeps `repository` in a browsable path and `repo` in a query', async () => {
    /*
     * Not an inconsistency, and worth pinning so nobody "fixes" it in either
     * direction.
     *
     * `/{owner}/{repository}` is the URL a person reads and the one `git clone`
     * produces - the domain table says never "repo" in user-visible copy, and a
     * URL is the most visible copy there is. `?repo=` is the compact parameter
     * every forge's clients already type, and shortening it there costs nobody
     * anything.
     *
     * Both resolve through the same `authorizeRepository`, which accepts either,
     * so a caller that guesses wrong is answered rather than refused.
     */
    const spec = await document()
    const paths = Object.keys(spec.paths ?? {})

    expect(paths.some(path => path.includes('/{repository}'))).toBe(true)
    expect(paths.some(path => path.startsWith('/api/repos/'))).toBe(true)
  })
})

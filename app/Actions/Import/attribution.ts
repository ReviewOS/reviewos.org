/**
 * Who wrote an imported issue, and what to say when we cannot be sure.
 *
 * The decision every importer gets wrong in one of two directions, and both are
 * worse than they sound.
 *
 * **Reassigning silently** is the common one: an importer matches `alice` at
 * GitHub to `alice` here and moves on, and now a different person's name is on
 * two thousand comments they did not write. Handles are not identities across
 * forges - `alice` on GitHub and `alice` on a private instance are the same
 * string and usually different people.
 *
 * **Attributing everything to the importer** is the other, and it destroys the
 * history it was meant to preserve. A repository where every comment was written
 * by `migration-bot` has kept the words and lost the conversation.
 *
 * ## This extends the mirror's rule rather than replacing it
 *
 * `app/Actions/Mirror/github.ts` already decides authorship, from a map of
 * `login -> local user id` built out of accounts that have *linked* their
 * GitHub identity. That rule is right and this reuses it: everything here
 * produces a richer map to hand the same mappers, so there is one implementation
 * of "who wrote this" and one set of row builders.
 *
 * What import adds is two more sources of evidence, because a migration happens
 * before anybody has linked anything:
 *
 * - a **verified email** that matches a local account, which is the same person
 *   by construction rather than by coincidence;
 * - an operator's explicit **claims**, `alice=alice`, which is a human saying *I
 *   know these are the same person* once, rather than a guess made two thousand
 *   times.
 */

export interface ExternalAuthor {
  login?: string
  email?: string | null
  name?: string | null
}

export interface LocalAccount {
  id: number
  handle: string
  email: string | null
}

/**
 * Parse an operator's `--map alice=alice,bob=robert` into claims.
 *
 * Deliberately explicit and deliberately small. An importer that read a mapping
 * file with a hundred entries would be doing the same guessing at one remove;
 * this is a person writing down the pairs they actually know.
 */
export function parseClaims(input: string): Map<string, string> {
  const claims = new Map<string, string>()

  for (const pair of String(input ?? '').split(/[\s,]+/)) {
    const [external, local] = pair.split('=')

    if (external && local)
      claims.set(external.trim().toLowerCase(), local.trim().toLowerCase())
  }

  return claims
}

/**
 * The `login -> local user id` map the mirror's mappers already take.
 *
 * Built from three sources, in descending order of how much they prove:
 * accounts that linked their GitHub identity themselves, an address the source
 * asserted that matches a local one, and the operator's claims. A login with no
 * evidence is simply absent, which is what makes the mapper record it as an
 * external author instead of attributing it to somebody.
 *
 * Emails come from the authors seen in the import, because GitHub's API returns
 * an address on almost nothing - so in practice most logins arrive with no
 * evidence at all, and being unmapped is the honest answer rather than a
 * failure.
 */
export function buildLinkMap(input: {
  linked: ReadonlyMap<string, number>
  authors: readonly ExternalAuthor[]
  accounts: readonly LocalAccount[]
  claims: ReadonlyMap<string, string>
}): Map<string, number> {
  const map = new Map<string, number>(input.linked)

  const byEmail = new Map<string, number>()
  const byHandle = new Map<string, number>()

  for (const account of input.accounts) {
    if (account.email)
      byEmail.set(account.email.toLowerCase(), account.id)

    byHandle.set(account.handle.toLowerCase(), account.id)
  }

  for (const author of input.authors) {
    const login = String(author.login ?? '').trim().toLowerCase()

    // A linked account wins. Somebody who said "this is me" outranks anything
    // inferred about them.
    if (!login || map.has(login))
      continue

    const email = String(author.email ?? '').trim().toLowerCase()
    const matched = email ? byEmail.get(email) : undefined

    if (matched !== undefined) {
      map.set(login, matched)

      continue
    }

    const claimed = input.claims.get(login)
    const claimedId = claimed ? byHandle.get(claimed) : undefined

    if (claimedId !== undefined)
      map.set(login, claimedId)
  }

  return map
}

/**
 * Rewrite cross references so `#123` still means what it meant.
 *
 * Numbers are preserved on import, so a bare `#123` needs no rewriting at all -
 * it resolves here to the same issue it resolved to there, which is the whole
 * reason for preserving them.
 *
 * What does need rewriting is the *absolute* form. A body saying
 * `https://github.com/acme/api/pull/12` reads as a link off this instance
 * forever, and that is a repository quietly telling its readers that the real
 * conversation is somewhere else. Rewritten to `/acme/api/pull/12`, it lands on
 * the local copy.
 *
 * **Only for repositories that were actually imported.** A reference to a
 * GitHub repository this instance does not have must stay a GitHub link: making
 * it relative would point at a page that does not exist, which is worse than an
 * external link that works.
 */
export function rewriteReferences(body: string, imported: ReadonlyMap<string, string>): string {
  if (!body)
    return body

  return body.replace(
    /https?:\/\/(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+)\/(issues|pull)\/(\d+)\b/gi,
    (whole, owner: string, repository: string, kind: string, number: string) => {
      const local = imported.get(`${owner.toLowerCase()}/${repository.toLowerCase()}`)

      if (!local)
        return whole

      // `pull` and `issues` each live under their own path here, and the number
      // is the same number - which is the point of preserving them.
      return `/${local}/${kind.toLowerCase() === 'pull' ? 'pull' : 'issues'}/${number}`
    },
  )
}

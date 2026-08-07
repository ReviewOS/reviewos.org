/**
 * `CODEOWNERS`: who gets asked, without anybody having to remember.
 *
 * A file of path patterns and the people responsible for what they match. It is
 * the one piece of review configuration that lives in the repository rather
 * than in a settings screen, which is the point: it is reviewed like code, it
 * arrives with the branch that needs it, and it is in the history when somebody
 * asks why a person was asked.
 *
 * ## The rule that surprises people
 *
 * **The last matching pattern wins, not the first, and not all of them.** That
 * is GitHub's rule and it is worth following exactly rather than improving on,
 * because a `CODEOWNERS` file is usually copied from somewhere else and a forge
 * that reads it differently assigns the wrong people quietly. A file that ends
 * with a catch-all is a file where the catch-all owns everything, and people
 * write that deliberately: specific rules at the top, a fallback at the bottom
 * is *wrong* here, and the fallback has to come first.
 *
 * ## What resolves, and what does not
 *
 * Teams (`@org/team`) parse, carry through as owners, and `resolveOwners`
 * turns one into its members through phase 1's model - an organization's
 * handle, a team's slug within it, and the people on it. A team the forge has
 * never heard of resolves to nobody, exactly like a handle that matches no
 * user: the file is checked in and can name anyone, and a stale line in it is
 * not a reason to refuse a pull request.
 *
 * Email addresses are accepted as owners and will simply match no local user,
 * which is the honest outcome: the file says to ask somebody this forge has
 * never heard of.
 */

export interface OwnerRule {
  /** The pattern as written, for saying which line asked. */
  pattern: string
  /** Handles and team names, without the leading `@`. */
  owners: string[]
}

/** Where the file is looked for, in the order GitHub looks. */
export const CODEOWNERS_PATHS = ['CODEOWNERS', '.github/CODEOWNERS', 'docs/CODEOWNERS'] as const

/**
 * Parse a `CODEOWNERS` file into rules, in file order.
 *
 * Blank lines and comments are dropped. A line with a pattern and no owners is
 * kept with an empty owner list, because that is how a later rule is *unset* in
 * some implementations and dropping it would let an earlier rule win a path its
 * author had deliberately released.
 */
export function parseCodeowners(text: string): OwnerRule[] {
  const rules: OwnerRule[] = []

  for (const raw of text.split('\n')) {
    // A `#` only starts a comment at the beginning of a token. A pattern may
    // legitimately contain one, escaped, and splitting on the first `#`
    // anywhere would truncate it.
    const line = raw.replace(/\s+#.*$/, '').trim()
    if (line === '' || line.startsWith('#'))
      continue

    const parts = line.split(/\s+/)
    const pattern = parts[0]!
    const owners = parts.slice(1)
      .filter(part => part.startsWith('@') || part.includes('@'))
      .map(part => (part.startsWith('@') ? part.slice(1) : part))

    rules.push({ pattern, owners })
  }

  return rules
}

/**
 * Whether one `CODEOWNERS` pattern matches one path.
 *
 * gitignore syntax, with the exclusions that do not apply here removed. The
 * cases that matter and that a naive implementation gets wrong:
 *
 * - a pattern with no slash matches at **any depth**, so `*.ts` covers
 *   `src/deep/a.ts` and not only `a.ts`;
 * - a pattern with a leading slash is anchored to the root, so `/docs/` is the
 *   top-level `docs` and not `src/docs`;
 * - a pattern ending in `/` matches a directory and everything under it;
 * - `*` does not cross a slash, `**` does. A `CODEOWNERS` file that says
 *   `src/*` and gets `src/a/b.ts` has been misread by most homegrown matchers.
 */
export function matchesPattern(pattern: string, path: string): boolean {
  if (pattern === '' || pattern === '*')
    return true

  const anchored = pattern.startsWith('/')
  const directory = pattern.endsWith('/')
  const body = pattern.replace(/^\//, '').replace(/\/$/, '')

  if (body === '')
    return true

  // No slash anywhere means "at any depth", which is the rule most often got
  // wrong: `*.ts` is not a top-level-only pattern.
  const floating = !anchored && !body.includes('/')
  const prefix = floating ? '(?:.*/)?' : ''

  // Three endings, and picking the wrong one is how a pattern comes to own
  // files nobody agreed to own:
  //
  // - a trailing slash is a directory, so it needs something *under* it:
  //   `docs/` covers `docs/a.md` and is not a file called `docs`;
  // - a pattern with a wildcard means exactly what it says and no more, which
  //   is why GitHub documents `/docs/*` as covering the directory's files and
  //   not its subdirectories;
  // - a literal path is the gitignore case, matching the file itself or
  //   anything beneath it when it turns out to be a directory.
  const suffix = directory
    ? '/.'
    : body.includes('*') || body.includes('?')
      ? '$'
      : '(?:/|$)'

  return new RegExp(`^${prefix}${globToRegex(body)}${suffix}`).test(path)
}

/** A gitignore-style glob as a regular expression body. */
function globToRegex(glob: string): string {
  let out = ''

  for (let index = 0; index < glob.length; index++) {
    const character = glob[index]!

    if (character === '*') {
      // `**` crosses slashes; a single `*` stops at one. Conflating them is how
      // `src/*` comes to match `src/a/b.ts`, which is a file its owner never
      // agreed to own.
      if (glob[index + 1] === '*') {
        // `**/` may also match nothing at all, so `**/a.ts` covers `a.ts`.
        if (glob[index + 2] === '/') {
          out += '(?:.*/)?'
          index += 2
        }
        else {
          out += '.*'
          index += 1
        }
      }
      else {
        out += '[^/]*'
      }

      continue
    }

    if (character === '?') {
      out += '[^/]'
      continue
    }

    out += character.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }

  return out
}

/**
 * Who owns one path, by the last rule that matches it.
 *
 * Empty when nothing matches, and empty when the last matching rule names
 * nobody - which is a rule saying this path has no owner, not a reason to fall
 * back to an earlier one.
 */
export function ownersOf(rules: readonly OwnerRule[], path: string): string[] {
  let owners: string[] = []

  for (const rule of rules) {
    if (matchesPattern(rule.pattern, path))
      owners = rule.owners
  }

  return owners
}

/**
 * Everybody a set of changed paths asks for, once each.
 *
 * Order is first-asked-first, so the list reads as the diff does rather than
 * alphabetically - the owner of the file somebody actually came to change is
 * the one at the top.
 */
/**
 * The `CODEOWNERS` file for a ref, from the first place it is found.
 *
 * Read from the **base**, not the head. A pull request that adds itself to
 * `CODEOWNERS` would otherwise decide who reviews it, which is a way to be
 * approved by nobody.
 *
 * Never throws. A repository with no such file is the common case and has to
 * read as "nobody is named" rather than as a failure to open a pull request.
 */
export async function codeownersFor(diskPath: string, ref: string): Promise<OwnerRule[]> {
  const { readBlob } = await import('../Browse/load')

  for (const candidate of CODEOWNERS_PATHS) {
    try {
      const blob = await readBlob(diskPath, ref, candidate)
      if (blob?.text)
        return parseCodeowners(blob.text)
    }
    catch {
      // Not there, or not readable. Try the next place it might be.
    }
  }

  return []
}

export function ownersForPaths(rules: readonly OwnerRule[], paths: readonly string[]): string[] {
  const seen = new Set<string>()
  const owners: string[] = []

  for (const path of paths) {
    for (const owner of ownersOf(rules, path)) {
      const key = owner.toLowerCase()
      if (seen.has(key))
        continue

      seen.add(key)
      owners.push(owner)
    }
  }

  return owners
}

/** A person an owner line resolved to. */
export interface ResolvedOwner {
  id: number
  handle: string
}

/**
 * The people a list of owners names, teams expanded to their members.
 *
 * Resolved one owner at a time, in the order `ownersForPaths` produced - the
 * list reads as the diff does, and a team's members arrive where the team was
 * written. A `CODEOWNERS` list is a handful of lines, so a query per line
 * costs nothing worth a cleverer statement.
 *
 * Deduplicated by user: somebody named directly *and* through a team is one
 * person asked once, at their first mention. Anything that resolves to nobody
 * - an unknown handle, an email, a team from another forge's org - contributes
 * nothing rather than failing, for the reason the file header gives.
 */
export async function resolveOwners(named: readonly string[]): Promise<ResolvedOwner[]> {
  const seen = new Set<number>()
  const people: ResolvedOwner[] = []

  const add = (row: { id: unknown, handle: unknown }): void => {
    const id = Number(row.id)
    if (seen.has(id))
      return

    seen.add(id)
    people.push({ id, handle: String(row.handle) })
  }

  for (const owner of named) {
    if (owner.includes('/')) {
      // `org/team`, split at the first slash: an organization's handle cannot
      // contain one, so everything after it is the team's slug.
      const cut = owner.indexOf('/')
      const orgHandle = owner.slice(0, cut).toLowerCase()
      const teamSlug = owner.slice(cut + 1).toLowerCase()

      if (orgHandle === '' || teamSlug === '')
        continue

      const members: any[] = await db
        .selectFrom('team_members')
        .innerJoin('teams', 'teams.id', '=', 'team_members.team_id')
        .innerJoin('organizations', 'organizations.id', '=', 'teams.organization_id')
        .innerJoin('users', 'users.id', '=', 'team_members.user_id')
        .select(['users.id as id', 'users.handle as handle'])
        .where('organizations.handle', '=', orgHandle)
        .where('teams.slug', '=', teamSlug)
        .execute()

      for (const member of members)
        add(member)

      continue
    }

    const person: any = await db
      .selectFrom('users')
      .select(['id', 'handle'])
      .where('handle', '=', owner.toLowerCase())
      .executeTakeFirst()

    if (person)
      add(person)
  }

  return people
}

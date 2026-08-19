/**
 * A workflow the organization carries, over repositories that carry nothing.
 *
 * The one thing a template cannot do. `ownerTemplates.ts` next door writes a
 * commit into a repository, which is the honest way to give somebody a starting
 * point - and it is exactly wrong for a licence check or a secret scan, because
 * a file in a repository is a file the repository can edit, and the whole value
 * of an organization-wide rule is that it holds in the repository whose owner
 * did not want it.
 *
 * So this workflow lives on the owner. `workflows.repository_id` is null, the
 * `selector` says which repositories it covers, and a repository created
 * tomorrow is matched by the same rule rather than by a list somebody expanded
 * once.
 *
 * ## The trust inversion, which is the whole security argument
 *
 * An ordinary run takes its definition from the repository and its secrets from
 * whatever is scoped to that repository. This one takes its definition from the
 * owner - so it must **not** take repository-scoped secrets, or a repository
 * admin could shadow an organization secret by name and read what the scan was
 * given. It runs at the owner's trust level *over the repository's data*, which
 * is the sentence from the roadmap and also the implementation: the repository
 * supplies a checkout, changed paths and metadata, and nothing that grants
 * anything.
 *
 * A fork's pull request never reaches one of these at all. An untrusted run is
 * untrusted whoever wrote the workflow, and the ordinary secret rules already
 * refuse it everything.
 */

import { db } from '@stacksjs/database'

/** What a selector is matched against. */
export interface CoveredRepository {
  name: string
  visibility?: string | null
  /** Whether the repository is archived, which no selector should reach into. */
  archived?: boolean
}

/**
 * Whether an owner-wide workflow covers this repository.
 *
 * A null or empty selector covers every repository under the owner, which is
 * what "owned entirely by the organization" means in the plain case.
 *
 * The syntax is the one this codebase already uses for branches, because a
 * second pattern language is a second thing to be wrong about: comma or newline
 * separated patterns, `*` for any run of characters, and a leading `!` to
 * exclude. Exclusions are applied last and win, so `*, !sandbox-*` reads the
 * way it looks.
 *
 * `visibility:public` and `visibility:private` are the one non-name term,
 * because "every private repository" is the second thing anybody asks for and
 * expressing it by naming them defeats the point.
 */
export function coversRepository(selector: string | null | undefined, repository: CoveredRepository): boolean {
  /*
   * An archived repository is covered by nothing.
   *
   * Not a rule about selectors - a rule about archives. Archiving says "this is
   * finished", and a nightly scan that keeps starting runs on it is a promise
   * broken by a feature that was not thinking about the case.
   */
  if (repository.archived)
    return false

  const terms = String(selector ?? '')
    .split(/[\n,]/)
    .map(one => one.trim())
    .filter(Boolean)

  if (terms.length === 0)
    return true

  const includes = terms.filter(term => !term.startsWith('!'))
  const excludes = terms.filter(term => term.startsWith('!')).map(term => term.slice(1).trim()).filter(Boolean)

  /*
   * A selector of exclusions alone covers everything except them, which is what
   * `!sandbox-*` on its own plainly means. Requiring `*, !sandbox-*` would be a
   * rule whose only purpose is to catch people out.
   */
  const included = includes.length === 0 || includes.some(term => matchesTerm(term, repository))
  const excluded = excludes.some(term => matchesTerm(term, repository))

  return included && !excluded
}

/** One term of a selector, against one repository. */
function matchesTerm(term: string, repository: CoveredRepository): boolean {
  const lowered = term.toLowerCase()

  if (lowered.startsWith('visibility:'))
    return String(repository.visibility ?? '').toLowerCase() === lowered.slice('visibility:'.length)

  return matchesName(lowered, String(repository.name ?? '').toLowerCase())
}

/**
 * A name against a `*` pattern.
 *
 * Escaped before the wildcard is put back, so a repository called `a.b` is not
 * matched by `a-b` - a pattern language whose dots are wildcards is one that
 * silently covers more than it says.
 */
export function matchesName(pattern: string, name: string): boolean {
  if (!pattern.includes('*'))
    return pattern === name

  const expression = pattern
    .split('*')
    .map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*')

  return new RegExp(`^${expression}$`).test(name)
}

/**
 * The owner-wide workflows that cover a repository, newest version first.
 *
 * Shaped exactly like `currentVersions` returns a repository's own, because the
 * dispatcher then treats them identically - which is the property that matters:
 * an owner-wide workflow's run has the same rows, the same triggers, the same
 * restart, and shows in the same list. If a screen can tell which kind produced
 * a run without looking at where the definition came from, something here is
 * doing more than it should.
 */
export async function ownerVersionsFor(repositoryId: number, columns: readonly string[]): Promise<any[]> {
  const repository = await db
    .selectFrom('repositories')
    .select(['id', 'name', 'owner_type', 'owner_id', 'visibility', 'is_archived'])
    .where('id', '=', repositoryId)
    .executeTakeFirst()
    .catch(() => null)

  if (!repository)
    return []

  const workflows = await db
    .selectFrom('workflows')
    .select(['id', 'selector'])
    .where('owner_type', '=', String(repository.owner_type))
    .where('owner_id', '=', Number(repository.owner_id))
    .whereNull('repository_id')
    .where('state', '=', 'active')
    .execute()
    .catch(() => [])

  const covering = workflows.filter(workflow => coversRepository(workflow.selector as string | null, {
    name: String(repository.name ?? ''),
    visibility: repository.visibility as string | null,
    archived: Boolean(repository.is_archived),
  }))

  if (covering.length === 0)
    return []

  return db
    .selectFrom('workflow_versions')
    .innerJoin('workflows', 'workflows.id', '=', 'workflow_versions.workflow_id')
    .select(columns as any)
    .where('workflow_versions.workflow_id', 'in', covering.map(one => Number(one.id)))
    // Newest first, so the caller's one-per-workflow pass keeps the current one.
    .orderBy('workflow_versions.id', 'desc')
    .execute()
    .catch(() => [])
}

/**
 * Whether a run's definition came from the owner rather than the repository.
 *
 * Asked at the claim, where the secrets are chosen. Read through the version
 * rather than stored on the run, because it is a fact about the definition and
 * a copy on the run is a copy that can disagree with it.
 */
export async function isOwnerDefined(runId: number): Promise<boolean> {
  const row: any = await db
    .selectFrom('workflow_runs')
    .innerJoin('workflow_versions', 'workflow_versions.id', '=', 'workflow_runs.workflow_version_id')
    .innerJoin('workflows', 'workflows.id', '=', 'workflow_versions.workflow_id')
    .select(['workflows.repository_id as repository_id'])
    .where('workflow_runs.id', '=', runId)
    .executeTakeFirst()
    .catch(() => null)

  return Boolean(row) && (row.repository_id === null || row.repository_id === undefined)
}

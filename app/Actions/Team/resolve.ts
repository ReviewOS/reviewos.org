import type { RepositoryPermission } from '../../Permissions'

/**
 * Which teams a person effectively belongs to, and what those teams reach.
 *
 * Pure over plain rows, because this is the security boundary and a boundary
 * that needs a database to test is one that gets tested thinly.
 *
 * **Inheritance runs downward: a child team inherits its parent's access.** A
 * member of `platform/reviewers` gets everything `platform` can reach, and
 * `platform`'s members get nothing from `reviewers`. That direction is the one
 * that matches how people describe it - "the reviewers team is part of
 * platform" - and reversing it would silently widen every parent team the day
 * somebody creates a narrow child under it.
 */

/** A team, as far as resolution cares. */
export interface TeamRow {
  id: number
  parentTeamId: number | null
}

/** A grant of one repository to one team. */
export interface TeamGrant {
  teamId: number
  repositoryId: number
  permission: RepositoryPermission
}

/**
 * Every team whose grants a member of `memberOf` receives.
 *
 * That is the teams they joined plus every ancestor of each, because a child
 * inherits the parent's access.
 *
 * **A cycle cannot hang this.** `parent_team_id` is a plain column and nothing
 * stops somebody making A the parent of B and B the parent of A - directly, or
 * around a longer loop that no single write looks wrong. Walking that without a
 * visited set is an infinite loop inside a permission check, which takes the
 * request down rather than answering it wrongly; both are bad and this one is
 * cheap to prevent.
 */
export function effectiveTeams(memberOf: readonly number[], teams: readonly TeamRow[]): number[] {
  const parents = new Map<number, number | null>()

  for (const team of teams)
    parents.set(Number(team.id), team.parentTeamId === null ? null : Number(team.parentTeamId))

  const reached = new Set<number>()

  for (const start of memberOf) {
    // The team they joined is always included: a membership row says so, even
    // if the team row is gone and this is mid-cleanup. It simply grants
    // nothing, because the grants cascaded with it.
    let current: number | null = Number(start)
    reached.add(current)

    while (current !== null) {
      const parent = parents.get(current)

      // Stop at a parent that is not a team here - deleted without re-parenting
      // its children, or in another organization and therefore out of scope.
      // Walking into it would collect a team id that cannot grant anything and
      // put it in a query.
      if (parent === undefined || parent === null || !parents.has(parent) || reached.has(parent)) {
        current = null
        continue
      }

      reached.add(parent)
      current = parent
    }
  }

  return [...reached].sort((a, b) => a - b)
}

/**
 * What those teams grant on one repository.
 *
 * Returns every grant rather than the highest, because the caller unions team
 * grants with the collaborator and organization grants and takes the most
 * permissive of all of them at once. Reducing here would be a second place that
 * decides which permission wins.
 */
export function grantsOn(
  repositoryId: number,
  teamIds: readonly number[],
  grants: readonly TeamGrant[],
): RepositoryPermission[] {
  const mine = new Set(teamIds.map(Number))

  return grants
    .filter(grant => Number(grant.repositoryId) === Number(repositoryId) && mine.has(Number(grant.teamId)))
    .map(grant => grant.permission)
}

/**
 * Every team a person effectively belongs to, from the database.
 *
 * Two queries rather than a recursive one. The team tree in an organization is
 * a handful of rows - GitHub caps nesting at four levels and real ones are
 * flatter - so reading them all and walking in memory is cheaper than a
 * recursive CTE and considerably easier to be sure about. If an installation
 * ever has enough teams for that to be wrong, the fix is an index on
 * `organization_id`, not a cleverer query.
 */
export async function effectiveTeamsFor(userId: number, organizationId: number | null): Promise<number[]> {
  if (!userId)
    return []

  const memberships = await db
    .selectFrom('team_members')
    .select(['team_id'])
    .where('user_id', '=', userId)
    .execute()

  if (memberships.length === 0)
    return []

  let query = db.selectFrom('teams').select(['id', 'parent_team_id'])

  // Scoped to the owning organization when there is one. A team in another
  // organization cannot grant anything here, and reading every team on the
  // instance to walk a parent chain is the query that gets slow first.
  if (organizationId)
    query = query.where('organization_id', '=', organizationId)

  const teams: any[] = await query.execute()

  return effectiveTeams(
    memberships.map(row => Number(row.team_id)),
    teams.map(row => ({ id: Number(row.id), parentTeamId: row.parent_team_id === null ? null : Number(row.parent_team_id) })),
  )
}

/** What a person's teams grant them on one repository. */
export async function teamPermissionsOn(repositoryId: number, teamIds: readonly number[]): Promise<RepositoryPermission[]> {
  if (teamIds.length === 0)
    return []

  const rows = await db
    .selectFrom('team_repositories')
    .select(['permission'])
    .where('repository_id', '=', repositoryId)
    .where('team_id', 'in', [...teamIds])
    .execute()

  return rows.map(row => String(row.permission) as RepositoryPermission)
}

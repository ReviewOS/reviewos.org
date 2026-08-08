import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * A team's access to one repository.
 *
 * **The missing half of teams.** `teams` and `team_members` both existed, and
 * `repositoryPermissionFor` already unions a `teamPermissions` array into its
 * answer - but nothing granted a team anything, and `permissionOn` passed an
 * empty array. So a team was a list of names with no effect on access, and the
 * resolver's team branch had never once been reached with a value in it.
 *
 * The point of granting through a team rather than per person is that
 * membership changes in one place. Adding somebody to the reviewers team gives
 * them every repository that team can reach; removing them takes all of it
 * back. Per-person grants are what leave a departed colleague with write on
 * eleven repositories and nobody able to list them.
 *
 * One row per team per repository, and the unique index is what makes it a
 * grant rather than a log: granting twice is the same grant, and two rows with
 * different permissions would make the answer depend on which came back first.
 */
export default defineModel({
  name: 'TeamRepository',
  table: 'team_repositories',
  primaryKey: 'id',
  autoIncrement: true,

  indexes: [
    { name: 'team_repositories_team_repo_unique', columns: ['team_id', 'repository_id'], unique: true },
    // The lookup the permission resolver does on every request that touches a
    // repository, which is most of them.
    { name: 'team_repositories_repository_index', columns: ['repository_id'] },
  ],

  traits: {
    useTimestamps: true,
  },

  /*
   * Both cascade. A grant to a team that no longer exists, or on a repository
   * that no longer exists, can only ever widen an answer it should not - and a
   * dangling row in an access table is the kind that survives a reorganisation
   * and gives somebody write on something nobody remembers.
   */
  belongsTo: [
    { model: 'Team', onDelete: 'cascade' },
    { model: 'Repository', onDelete: 'cascade' },
  ],

  attributes: {
    team_id: {
      required: true,
      fillable: true,
      validation: { rule: schema.number() },
      factory: () => null,
    },

    repository_id: {
      required: true,
      fillable: true,
      validation: { rule: schema.number() },
      factory: () => null,
    },

    /**
     * What the team may do, from the same five levels a collaborator gets.
     *
     * Deliberately the same vocabulary rather than a team-specific one. The
     * resolver takes the most permissive of every grant a person holds, and it
     * can only do that if they are measured on one scale.
     */
    permission: {
      required: true,
      fillable: true,
      default: 'read',
      validation: {
        rule: schema.enum(['read', 'triage', 'write', 'maintain', 'admin']),
      },
    },
  },
} as const)

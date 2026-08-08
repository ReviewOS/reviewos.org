import type { UserModel } from '@stacksjs/orm'
import type { RepositoryAbility, RepositoryAccessInput } from './Permissions'
import { allowedOnArchivedRepository, canOnRepository, wouldOrphanOrganization } from './Permissions'

/**
 * Authorization gates.
 *
 * **Deliberately thin, and that is the design.** Every rule that decides access
 * lives in `app/Permissions.ts` as a pure function over plain values, and the
 * actions call it directly through `authorizeRepository` and
 * `organizationRoleOf`. These gates give a few of those rules a name for code
 * that reaches for the framework's `Gate`, and add no logic of their own.
 *
 * A gate that re-derived a rule would be a second place that decides, and the
 * one that disagrees quietly is the one that ships. So what is here is the
 * questions that are *not* simple role comparisons - would this leave an
 * organization with no owner, does this ability survive archiving - each
 * delegating to the one implementation.
 *
 * @see https://stacksjs.org/docs/security/authorization
 */

/**
 * Gate definitions
 *
 * Simple ability checks that don't require a model.
 *
 * @example
 * // In your code:
 * import { Gate } from '@stacksjs/auth'
 *
 * if (await Gate.allows('edit-settings', user)) {
 *   // User can edit settings
 * }
 */
export const gates = {
  /**
   * Whether somebody administers this instance.
   *
   * The `is_admin` column, and nothing derived. The framework's default checked
   * an email domain, which on a self-hosted forge means that whoever controls
   * the mail domain in `.env` controls the instance - and that anybody who can
   * register with an address at that domain administers it.
   */
  'access-admin': (user: UserModel | null) => {
    return Boolean((user as any)?.is_admin)
  },

  /**
   * Whether the last owner of an organization may be removed or demoted.
   *
   * A gate rather than a role comparison, which is the distinction this file is
   * for: it is not about who is asking. An owner has every right to leave, and
   * the refusal is about what would be left behind - an organization nobody can
   * administer, which cannot be repaired from the interface because there is
   * nobody left to appoint a replacement.
   *
   * `wouldOrphanOrganization` is the rule and `ChangeMemberRoleAction` and
   * `RemoveMemberAction` both apply it directly. This is here so the same
   * question has one name when it is asked from anywhere else.
   */
  'orphan-organization': (_user: UserModel | null, input: Parameters<typeof wouldOrphanOrganization>[0]) => {
    return !wouldOrphanOrganization(input)
  },

  /**
   * Whether somebody may act on a repository.
   *
   * The resolver, given a name. Every rule that decides access to a repository
   * is in `repositoryPermissionFor` and the abilities table beside it, and this
   * deliberately adds nothing: a second place that decides is a second place
   * that can disagree, and the one that disagrees quietly is the one that gets
   * shipped.
   *
   * The caller resolves the grants - collaborator, team, organization role -
   * because that needs the database, and a gate that queries is a gate that
   * cannot be tested against literals.
   */
  'repository': (_user: UserModel | null, input: RepositoryAccessInput, ability: RepositoryAbility) => {
    return canOnRepository(input, ability)
  },

  /**
   * Whether an ability survives the repository being archived.
   *
   * Not a permission question at all, which is why it is separate: an admin of
   * an archived repository still administers it, and still cannot push to it.
   * Archiving is about the repository's state rather than the reader's rights,
   * and folding the two together is how "unarchive" ends up needing write.
   */
  'archived-repository': (_user: UserModel | null, ability: RepositoryAbility) => {
    return allowedOnArchivedRepository(ability)
  },
}

/**
 * Policy mappings
 *
 * Map model names to their policy classes.
 * Policy files should be in app/Policies/ directory.
 *
 * @example
 * // Simple mapping (uses PostPolicy for Post model)
 * 'Post': 'PostPolicy',
 *
 * // Or with config:
 * 'Post': {
 *   policy: 'PostPolicy',
 *   model: 'Post',
 * },
 */
export const policies: Record<string, string | { policy: string, model?: string }> = {
  // 'Post': 'PostPolicy',
  // 'User': 'UserPolicy',
  // 'Comment': 'CommentPolicy',
}

/**
 * Before callbacks
 *
 * Run before any gate/policy check. Return true to allow,
 * false to deny, or null to continue to the actual check.
 *
 * @example
 * // Super admins bypass all checks
 * (user) => user?.role === 'super-admin' ? true : null
 */
export const before: Array<(user: UserModel | null, ability: string, args: any[]) => boolean | null | Promise<boolean | null>> = [
  // Example: Super admin bypass
  // (user, ability) => {
  //   if (user?.role === 'super-admin') {
  //     return true // Allow everything for super admins
  //   }
  //   return null // Continue to normal checks
  // },
]

/**
 * After callbacks
 *
 * Run after gate/policy checks. Can override the result.
 */
export const after: Array<(user: UserModel | null, ability: string, result: boolean, args: any[]) => boolean | void | Promise<boolean | void>> = [
  // Example: Log all authorization checks
  // (user, ability, result) => {
  //   console.log(`User ${user?.id} ${result ? 'allowed' : 'denied'} for ${ability}`)
  // },
]

export default { gates, policies, before, after }

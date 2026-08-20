import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * Rules a branch enforces at push and at merge.
 *
 * `pattern` is a glob (`main`, `release/*`), so one rule can cover a family of
 * branches. Both the receive-pack path and the merge action read these, since a
 * rule enforced only in the interface is not a rule.
 */
export default defineModel({
  name: 'ProtectedBranch',
  table: 'protected_branches',
  primaryKey: 'id',
  autoIncrement: true,

  indexes: [
    { name: 'protected_branches_repo_index', columns: ['repository_id'] },
  ],

  traits: {
    useTimestamps: true,
    useSeeder: { count: 6 },
  },

  belongsTo: [{ model: 'Repository', onDelete: 'cascade' }],

  attributes: {
    repository_id: {
      order: 1,
      fillable: true,
      validation: { rule: schema.number().required() },
      factory: () => null,
    },

    pattern: {
      order: 2,
      fillable: true,
      validation: { rule: schema.string().required().max(255) },
      factory: () => 'main',
    },

    required_approvals: {
      order: 3,
      fillable: true,
      default: 0,
      validation: { rule: schema.number() },
      factory: faker => faker.number.int({ min: 0, max: 2 }),
    },

    dismiss_stale_reviews: {
      order: 4,
      fillable: true,
      default: false,
      validation: { rule: schema.boolean() },
      factory: () => true,
    },

    require_conversation_resolution: {
      order: 5,
      fillable: true,
      default: false,
      validation: { rule: schema.boolean() },
      factory: () => true,
    },

    /** JSON array of check names that must report success. */
    required_checks: {
      order: 6,
      fillable: true,
      type: 'text',
      validation: { rule: schema.string() },
      factory: () => '[]',
    },

    allow_force_push: {
      order: 7,
      fillable: true,
      default: false,
      validation: { rule: schema.boolean() },
      factory: () => false,
    },

    allow_deletion: {
      order: 8,
      fillable: true,
      default: false,
      validation: { rule: schema.boolean() },
      factory: () => false,
    },

    /**
     * Forbid merge commits on this branch.
     *
     * Enforced at merge time by refusing the merge strategy, and on push by
     * the receive hook: a branch is only linear if both doors are shut.
     */
    require_linear_history: {
      order: 9,
      fillable: true,
      default: false,
      validation: { rule: schema.boolean() },
      factory: () => false,
    },

    /**
     * A change written by a machine account needs a person to approve it.
     *
     * Expressed as a rule rather than left to a convention people remember.
     * "We always look at the bot's pull requests" is true for about three
     * weeks, and the week it stops being true is the week nobody notices,
     * because the thing that changed is nobody's attention rather than any
     * file.
     *
     * Distinct from `count_machine_approvals` on the repository, which is
     * about whose approval *counts*. This is about whose change needs *one*.
     * A repository can reasonably want both: an agent's review is worth
     * counting, and an agent's own change still gets a human.
     *
     * One human approval, not all of them. The requirement is that somebody
     * looked, and a rule that demanded every approval be human would make an
     * agent reviewer useless on exactly the branches most likely to have one.
     */
    require_human_approval_for_agents: {
      order: 10,
      fillable: true,
      default: false,
      validation: { rule: schema.boolean() },
      factory: () => false,
    },

    /**
     * The branch a pull request targets must already be in its head.
     *
     * GitHub spells this `required_status_checks.strict`, and the name hides
     * what it is for: a check that passed on a head which never contained the
     * current tip of the base did not test the code that is about to exist.
     * Two branches that each pass on their own and break together is the
     * failure this catches, and it is the one a green tick makes people stop
     * looking for.
     *
     * Costly on a busy branch - every merge to the base makes every open pull
     * request out of date - so it is off unless somebody asks for it, and it is
     * separate from `required_checks` rather than folded into it. A repository
     * can reasonably want a check to be required without wanting the branch
     * rebased every twenty minutes.
     */
    require_up_to_date: {
      order: 11,
      fillable: true,
      default: false,
      validation: { rule: schema.boolean() },
      factory: () => false,
    },

    /**
     * Whether the rule binds the people who could remove it.
     *
     * **Defaults to true, which is the opposite of GitHub's default and is
     * deliberate.** Every rule on every existing instance was written when
     * there was no bypass at all, so a column defaulting to false would hand
     * every repository admin a silent exemption from protections they believe
     * are in force, on the day the migration ran. A protection that stops
     * applying without anybody changing it is the worst kind of change.
     *
     * Turning it off is a real thing to want - the branch nobody can fix at
     * 3am is its own outage - so the exemption exists, and using it is written
     * to the audit log rather than left to be inferred from the reflog.
     */
    enforce_admins: {
      order: 12,
      fillable: true,
      default: true,
      validation: { rule: schema.boolean() },
      factory: () => true,
    },

    /**
     * Who may write to this branch at all, as JSON.
     *
     * `{"users":["ada"],"teams":["platform"]}`, matching GitHub's
     * `restrictions`. Empty - the column's default - means unrestricted, which
     * is what `restrictions: null` says there.
     *
     * A restriction, not a grant: being named here does not give anybody push
     * access they did not already have. It narrows the set of people who
     * already have it, which is why an empty list is the absence of a rule
     * rather than a branch nobody can write to.
     */
    push_restrictions: {
      order: 13,
      fillable: true,
      type: 'text',
      validation: { rule: schema.string() },
      factory: () => '',
    },
  },
} as const)

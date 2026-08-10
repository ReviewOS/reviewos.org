import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * One CI system's verdict on one commit, under one name.
 *
 * The older and simpler of the two check APIs, and the one almost every
 * existing CI system already speaks. A check run has a lifecycle, output, and
 * annotations; a status is a coloured dot with a link, and that is all most
 * tools want to post.
 *
 * **Both exist because dropping either one costs adoption.** A forge that
 * accepts only check runs cannot be used with the twenty-year-old script
 * somebody has posting statuses; a forge that accepts only statuses cannot show
 * a failing line in a diff. They roll up together, which is the part that has
 * to be right - see `app/Actions/Checks/rollup.ts`.
 *
 * ## Latest-per-context, not a log
 *
 * A CI system posts `pending` and then `success` under the same context, and
 * both rows are kept: the history is occasionally what somebody needs, and the
 * rollup reads only the newest per context. Collapsing on write would make a
 * retry indistinguishable from a first attempt, and "did this always pass, or
 * did somebody re-run it until it did" is a question worth being able to answer.
 */
export default defineModel({
  name: 'CommitStatus',
  table: 'commit_statuses',
  primaryKey: 'id',
  autoIncrement: true,

  indexes: [
    // The only read: this commit's statuses, newest first.
    { name: 'commit_statuses_sha_index', columns: ['repository_id', 'sha'] },
  ],

  traits: {
    useTimestamps: true,
    useSeeder: { count: 0 },
  },

  attributes: {
    repository_id: {
      order: 1,
      fillable: true,
      validation: { rule: schema.number().required() },
      factory: () => null,
    },

    /** The full commit sha. Statuses are about a commit, never about a branch. */
    sha: {
      order: 2,
      fillable: true,
      validation: { rule: schema.string().required().max(64) },
      factory: () => null,
    },

    /**
     * The name the reporter files under, and the key everything else uses.
     *
     * `ci/build`, `security/scan`. A branch rule names required checks by this
     * string, so it is the thing that must stay stable when a CI system is
     * reconfigured - and the reason a rename silently un-requires a check.
     */
    context: {
      order: 3,
      fillable: true,
      validation: { rule: schema.string().required().max(255) },
      factory: () => 'ci/build',
    },

    state: {
      order: 4,
      fillable: true,
      /*
       * `error` is distinct from `failure` on purpose. A failure is "your code
       * is wrong"; an error is "the check could not run". They look the same on
       * a dot and mean opposite things to whoever has to act.
       */
      validation: { rule: schema.enum(['pending', 'success', 'failure', 'error']) },
      factory: () => 'pending',
    },

    /** Where to read about it. A red dot with no link is a dead end. */
    target_url: {
      order: 5,
      fillable: true,
      validation: { rule: schema.string().max(2048) },
      factory: () => null,
    },

    description: {
      order: 6,
      fillable: true,
      validation: { rule: schema.string().max(500) },
      factory: () => null,
    },

    /** Whoever's token posted it, so a wrong verdict has an author. */
    creator_id: {
      order: 7,
      fillable: true,
      validation: { rule: schema.number() },
      factory: () => null,
    },
  },
} as const)

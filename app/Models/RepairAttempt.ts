import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * One attempt at an automated repair, including the ones that were refused.
 *
 * The budgets in `repairPolicy.ts` are counters against something, and this is
 * the something. Without a row per attempt, `maxAttempts` is a number nothing
 * reads and a repair loop is bounded only by whatever stops it by accident.
 *
 * ## Refusals are rows too
 *
 * A refused attempt is written, and that is the point rather than an oversight.
 * The question asked after an incident is "why did nothing try to fix this",
 * and a table holding only the attempts that ran cannot answer it - the
 * repository whose policy was off looks identical to the one nothing ever
 * noticed. It also makes the budget honest in the other direction: a refusal
 * that cost a model call still spent something, and a row is where that is
 * recorded.
 *
 * Refusals do **not** count against `max_attempts`, though. `spentOn` in
 * `repairAttempts.ts` counts only the attempts that ran, because a repository
 * that refused six times for a forbidden path has not used six of its two
 * tries - it has used none, and telling it otherwise would let one misconfigured
 * policy permanently exhaust a budget nothing ever spent.
 *
 * ## Attributable, per the roadmap
 *
 * `proposed_by` is the account the repair acted as, and it is what
 * `mayApproveRepair` compares against when somebody approves the result. A
 * proposal with no attributable actor is one nobody can be stopped from
 * approving themselves.
 */
export default defineModel({
  name: 'RepairAttempt',
  table: 'repair_attempts',
  primaryKey: 'id',
  autoIncrement: true,

  belongsTo: [
    { model: 'Repository', onDelete: 'cascade' },
    { model: 'WorkflowRun', onDelete: 'cascade' },
  ],

  indexes: [
    // The budget question is always "what has this run spent", so that is the
    // index. Asked once per failing job, on the path that decides whether to
    // spend money, which is not a place for a table scan.
    { name: 'repair_attempts_run_index', columns: ['workflow_run_id'] },
    // And "what has this repository been doing", which is the screen somebody
    // opens after an agent pushed something surprising.
    { name: 'repair_attempts_repository_index', columns: ['repository_id', 'created_at'] },
  ],

  traits: { useTimestamps: true, useSeeder: { count: 0 } },

  attributes: {
    repository_id: {
      order: 1,
      fillable: true,
      required: true,
      validation: { rule: schema.number().required() },
      factory: () => 1,
    },

    workflow_run_id: {
      order: 2,
      fillable: true,
      required: true,
      validation: { rule: schema.number().required() },
      factory: () => 1,
    },

    /**
     * The job whose failure started this.
     *
     * Not a declared relation: a job row can be replaced by a rerun, and a
     * foreign key would take the attempt history with it. What happened is
     * still true after the job it happened to is gone.
     */
    workflow_job_id: {
      order: 3,
      fillable: true,
      validation: { rule: schema.number() },
      factory: () => null,
    },

    /** The failed step that triggered it, by name. */
    step: {
      order: 4,
      fillable: true,
      validation: { rule: schema.string().max(255) },
      factory: () => 'test',
    },

    /**
     * Where this attempt got to.
     *
     * `refused` is a decision made before anything ran, `failed` is an attempt
     * that ran and produced nothing usable, and `proposed` is the only one that
     * put a branch in the repository. Kept apart because "the agent could not
     * fix it" and "the agent was not allowed to try" are different answers to
     * the only question anybody asks of this table.
     */
    state: {
      order: 5,
      fillable: true,
      default: 'attempted',
      validation: { rule: schema.enum(['attempted', 'proposed', 'refused', 'failed']) },
      factory: () => 'attempted',
    },

    /** The `RepairRefusal` name, when this was refused. */
    refusal: {
      order: 6,
      fillable: true,
      validation: { rule: schema.string().max(64) },
      factory: () => null,
    },

    /** One sentence, as the policy wrote it, for whoever reads this row. */
    reason: {
      order: 7,
      fillable: true,
      validation: { rule: schema.string().max(2000) },
      factory: () => null,
    },

    /** The branch a successful repair pushed to, and nothing otherwise. */
    branch: {
      order: 8,
      fillable: true,
      validation: { rule: schema.string().max(255) },
      factory: () => null,
    },

    /** The commit it wrote, so the proposal is traceable to an object. */
    commit_sha: {
      order: 9,
      fillable: true,
      validation: { rule: schema.string().max(64) },
      factory: () => null,
    },

    /**
     * The account this repair acted as.
     *
     * What `mayApproveRepair` compares an approver against. Null only for an
     * attempt refused before it had one.
     */
    proposed_by: {
      order: 10,
      fillable: true,
      validation: { rule: schema.number() },
      factory: () => null,
    },

    /** Minutes this attempt took, against the policy's `max_minutes`. */
    minutes: {
      order: 11,
      fillable: true,
      default: 0,
      validation: { rule: schema.number() },
      factory: () => 0,
    },

    /**
     * What it cost, in the operator's unit, against `max_cost`.
     *
     * Stored per attempt rather than summed on the run, because the sum is a
     * number that has to stay right through deletions and reruns, and a column
     * holding it is one more thing that can disagree with the rows.
     */
    cost: {
      order: 12,
      fillable: true,
      default: 0,
      validation: { rule: schema.number() },
      factory: () => 0,
    },

    /** Model tokens spent, which is the budget the roadmap names and money follows. */
    tokens: {
      order: 13,
      fillable: true,
      default: 0,
      validation: { rule: schema.number() },
      factory: () => 0,
    },
  },
})

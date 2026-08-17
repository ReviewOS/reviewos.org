import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * A machine that has been told it may take work.
 *
 * Registration is an administrative act, not a self-service one, and that is
 * the whole security posture of the runner side. By [the threat
 * model](../../docs/ci-threat-model.md) a runner executes hostile code by
 * design; what stops that being an instance compromise is that the instance
 * hands work only to machines an operator chose, and hands each one a
 * credential scoped to a single job.
 *
 * **The token is stored as a hash.** A registration token in the database in
 * plain text is a registration token in every backup, and a runner credential
 * is a credential to receive somebody's source code.
 */
export default defineModel({
  name: 'Runner',
  table: 'runners',
  primaryKey: 'id',
  autoIncrement: true,

  indexes: [
    // The lookup on every claim: find the runner this token belongs to.
    { name: 'runners_token_index', columns: ['token_hash'], unique: true },
    // The dispatcher's question: which runners serve this scope.
    { name: 'runners_scope_index', columns: ['scope_type', 'scope_id', 'state'] },
  ],

  traits: {
    useUuid: true,
    useTimestamps: true,
    useSeeder: { count: 0 },
  },

  attributes: {
    /**
     * The queue this machine serves, when the fleet has been given a shape.
     *
     * Null is the ordinary case and is not a gap: a runner in no queue is
     * matched by label and by scope exactly as every runner was before pools
     * existed, so an instance that never opens the fleet screen never notices
     * it. Joining a queue is what puts a machine inside a pool's boundary.
     */
    runner_queue_id: {
      order: 12,
      fillable: true,
      validation: { rule: schema.number() },
      factory: () => null,
    },

    /**
     * A stop somebody asked for: `graceful` or `forced`.
     *
     * Set by an operator, cleared when the machine acknowledges by polling.
     * The two differ in what happens to the job it is holding: a graceful stop
     * lets it finish, and a forced one puts it back in the queue for another
     * machine - **not** cancelled, because the work is fine and it is the
     * machine that is going away.
     *
     * A column rather than a signal, because the instance cannot signal
     * anything: the runner is somebody else's machine, possibly behind a
     * firewall, and the only moment it can be told anything is when it asks
     * for work.
     */
    stop_requested: {
      order: 13,
      fillable: true,
      validation: { rule: schema.enum(['graceful', 'forced']) },
      factory: () => null,
    },

    /**
     * `key=value` per line: what this machine *is*, beyond a label.
     *
     * Labels answer "may this job run here" as a set membership test, which is
     * the right shape for `runs-on: ubuntu-latest` and the wrong one for
     * everything with a value in it - a GPU model, a region, a kernel version.
     * A tag query says `gpu=a100` and means it, where a label called
     * `gpu-a100` means whatever the person who typed it was thinking.
     *
     * Set at registration and by whatever the machine's startup script knows
     * about itself, which is the only thing that *does* know it.
     */
    tags: {
      order: 15,
      fillable: true,
      validation: { rule: schema.string().max(2000) },
      factory: () => null,
    },

    /**
     * The registration token this machine registered with, when it did.
     *
     * Kept so "which credential put this machine here" has an answer after the
     * token is revoked - which is exactly when somebody asks. Null for a runner
     * an operator created by hand.
     */
    runner_registration_token_id: {
      order: 14,
      fillable: true,
      validation: { rule: schema.number() },
      factory: () => null,
    },

    /** What a person calls it in a list: `mac-mini-01`. */
    name: {
      order: 1,
      fillable: true,
      validation: { rule: schema.string().required().max(200) },
      factory: () => 'runner-1',
    },

    /**
     * How far this runner's reach goes.
     *
     * `instance` serves everything, `organization` and `repository` narrow it.
     * Narrowing matters more than it looks: a runner registered for one
     * repository must never be handed another's source, and the scope is the
     * only thing that decides which jobs it is offered.
     */
    scope_type: {
      order: 2,
      fillable: true,
      default: 'instance',
      validation: { rule: schema.enum(['instance', 'organization', 'repository']) },
      factory: () => 'instance',
    },

    /** Null when the scope is the whole instance. */
    scope_id: {
      order: 3,
      fillable: true,
      validation: { rule: schema.number() },
      factory: () => null,
    },

    /** SHA-256 of the registration token. The token itself is never stored. */
    token_hash: {
      order: 4,
      fillable: true,
      validation: { rule: schema.string().required().max(64) },
      factory: () => null,
    },

    /**
     * What it can run, one label per line.
     *
     * A job's `runs-on` is matched against these. A runner that claims labels
     * it does not have is a job that fails on a missing toolchain rather than
     * one that waits for a machine that has it, so this is a promise the
     * operator makes and the scheduler believes.
     */
    labels: {
      order: 5,
      fillable: true,
      validation: { rule: schema.string().max(1000) },
      factory: () => 'ubuntu-latest',
    },

    /**
     * Disabled rather than deleted, for the same reason a workflow is.
     *
     * A runner that misbehaved gets turned off, and the runs it already
     * executed have to stay attributable to it - which deleting the row would
     * take with them.
     */
    state: {
      order: 6,
      fillable: true,
      default: 'active',
      validation: { rule: schema.enum(['active', 'disabled']) },
      factory: () => 'active',
    },

    /** What the runner says it is, for compatibility negotiation. */
    version: {
      order: 7,
      fillable: true,
      validation: { rule: schema.string().max(60) },
      factory: () => null,
    },

    /**
     * When it last spoke, whether or not it was holding work.
     *
     * The list of runners is a list of machines somebody is paying for, and
     * "last seen three weeks ago" is the only way to notice one that quietly
     * stopped.
     */
    last_seen_at: {
      order: 8,
      fillable: true,
      validation: { rule: schema.string().max(40) },
      factory: () => null,
    },
  },
})

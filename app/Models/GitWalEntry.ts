import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * One push, written down before it is acknowledged.
 *
 * The write-ahead log from phase 18b, and the thing to understand about it is
 * that it is two halves with different jobs. **The row is the truth**: which
 * refs moved, from what to what, in what order, for which repository. **The
 * blob is the payload**: a `git bundle` of the objects the push brought,
 * living in the blob store because it is large and immutable. A ref deletion
 * or a pure ref move - a branch pointed at a commit that is already here -
 * carries no bundle at all, and that is not a missing blob, it is a push with
 * no new objects in it.
 *
 * ## Why this is worth having on one box
 *
 * It is sold as scale-out machinery and it pays for itself long before any
 * second node: a bundle per push, streamed to storage, **is** continuous
 * point-in-time backup. `buddy git:restore` replays it. An instance that never
 * grows past one machine still gets "restore this repository to how it was on
 * Tuesday" out of it, which is the ops feature people ask for most.
 *
 * ## The sequence is per repository, and it is the ordering
 *
 * Not a timestamp: two pushes inside the same millisecond are ordinary, clocks
 * move backwards, and replay has to be deterministic. The sequence is dense
 * and monotonic per repository, which is what makes "replay from N" a
 * well-defined request and what phase 18c's compare-and-swap will hang off.
 *
 * ## Status is three states, and `pending` is the interesting one
 *
 * A row is written `pending` before the push is allowed, and moved to
 * `committed` when the push has actually landed. A row that stays `pending` is
 * a push that was refused, or one whose hook died between the two - the
 * reconciler sweeps those against the repository's real refs and either
 * commits or voids them. **Nothing deletes them silently**: a WAL that drops
 * entries it cannot explain is a backup with holes in it.
 */
export default defineModel({
  name: 'GitWalEntry',
  table: 'git_wal_entries',
  primaryKey: 'id',
  autoIncrement: true,

  /*
   * Cascade with the repository. A log entry describing pushes to something
   * that no longer exists cannot be replayed into anything, and the delete
   * path relies on the foreign keys rather than listing tables by hand.
   *
   * The *bundles* in the blob store are a separate question, and they are left
   * for the checkpoint sweep rather than deleted here: a repository deletion is
   * recoverable for thirty days by design, and taking its bundles at the moment
   * the row goes would make the row the only thing recoverable.
   */
  belongsTo: [{ model: 'Repository', onDelete: 'cascade' }],

  indexes: [
    /*
     * The ordering, and the uniqueness that makes it real. Two rows claiming
     * sequence 7 for one repository is a log that cannot be replayed, so the
     * database refuses it rather than the application promising not to.
     */
    { name: 'git_wal_entries_sequence_unique', columns: ['repository_id', 'sequence'], unique: true },
    // What the reconciler asks for: the pending rows, oldest first.
    { name: 'git_wal_entries_status_index', columns: ['status', 'created_at'] },
  ],

  traits: { useUuid: true, useTimestamps: true, useSeeder: { count: 0 } },

  attributes: {
    repository_id: {
      order: 1,
      fillable: true,
      required: true,
      validation: { rule: schema.number().required() },
      factory: () => 1,
    },

    /**
     * Dense and monotonic within the repository, starting at 1.
     *
     * Allocated under the same lock that writes the row, so a gap means an
     * entry was voided rather than that one was lost - which is a distinction
     * `git:restore` has to be able to make.
     */
    sequence: {
      order: 2,
      fillable: true,
      required: true,
      validation: { rule: schema.number().required() },
      factory: () => 1,
    },

    /**
     * The ref transaction, as JSON: `[{ ref, before, after }]`.
     *
     * The whole push, not one ref. git offers a receive as a set and applies
     * it as a set, and splitting it into rows would let a replay land half of
     * an atomic push - which is exactly the state a reviewer would see as a
     * branch pointing somewhere impossible.
     */
    updates: {
      order: 3,
      fillable: true,
      required: true,
      // `text`, not the default varchar: one entry is roughly a hundred
      // characters of ref name and two shas, so a push touching three
      // branches already overflows 255 - and a push touching thirty is what a
      // mirror sync or a first import looks like. A truncated ref transaction
      // is a log that replays into the wrong repository state.
      type: 'text',
      validation: { rule: schema.string().required() },
      factory: () => '[]',
    },

    /**
     * Where the bundle is in the blob store, or null when there is nothing to
     * bundle. Null is a fact about the push, not a failure to write one.
     */
    blob_key: {
      order: 4,
      fillable: true,
      validation: { rule: schema.string() },
      factory: () => null,
    },

    /** Bundle size, so retention can be reasoned about without listing storage. */
    blob_bytes: {
      order: 5,
      fillable: true,
      validation: { rule: schema.number() },
      factory: () => 0,
    },

    status: {
      order: 6,
      fillable: true,
      required: true,
      default: 'pending',
      validation: { rule: schema.enum(['pending', 'committed', 'void']) },
      factory: () => 'pending',
    },

    /**
     * Who pushed, when the instance knows.
     *
     * Nullable because a WAL entry is about bytes rather than about people: a
     * push over a transport that could not attribute it is still a push that
     * must be recorded, and refusing to log it would put a hole in the backup
     * to protect an audit trail that has its own table.
     */
    actor_id: {
      order: 7,
      fillable: true,
      validation: { rule: schema.number() },
      factory: () => null,
    },

    /** When the push was acknowledged, as opposed to when the row was written. */
    committed_at: {
      order: 8,
      fillable: true,
      validation: { rule: schema.string() },
      factory: () => null,
    },

    /**
     * Why a row was voided, for the operator reading a gap in the sequence.
     *
     * A voided entry with no reason is the kind of thing that makes somebody
     * distrust the whole log.
     */
    reason: {
      order: 9,
      fillable: true,
      // git's own refusal messages are the useful content here, and they are
      // paragraphs rather than labels.
      type: 'text',
      validation: { rule: schema.string() },
      factory: () => null,
    },
  },
})

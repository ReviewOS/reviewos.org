import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * Where a ref points, according to the database.
 *
 * The ledger from phase 18c. After it, disk stops being the truth about a
 * repository's refs and becomes a cache of them: `update-ref` follows this
 * table rather than leading it, and a node whose disk disagrees is a node with
 * a stale cache rather than a second opinion.
 *
 * ## What makes this safe without advisory locks
 *
 * Phase 17's design forbids Postgres advisory locks and this codebase's query
 * builder exposes no multi-statement transaction, so neither is used. The
 * linearization point is the one the write-ahead log already had: the unique
 * `(repository_id, sequence)` on `git_wal_entries`. Whoever wins that insert
 * owns the right to apply its ref transaction, and every row here is then
 * moved by a **conditional update** - `SET sha = new WHERE sha = old` - which
 * is atomic on its own on every engine this runs on.
 *
 * So a writer with a stale view of a ref loses its update rather than
 * overwriting somebody, and a writer that dies mid-apply leaves a partly
 * applied ledger that the WAL row can finish - because the row is the truth
 * and this table is an index of it. The per-repo `GET_LOCK` phase 17 brings
 * strengthens this to all-or-nothing across refs; it is not needed for the
 * table to be correct.
 *
 * ## Why the sequence is here
 *
 * `sequence` is the WAL entry that last moved this ref. It answers the
 * question materialization actually asks - *what does this node still need* -
 * without reading the log: a repository whose ledger is at sequence 40 needs
 * the checkpoint plus entries 41 onward, and nothing else.
 */
export default defineModel({
  name: 'GitRef',
  table: 'git_refs',
  primaryKey: 'id',
  autoIncrement: true,

  /*
   * Cascade, because a ledger row for a repository that no longer exists is
   * not a record of anything - the repository's whole history went with it.
   * Declared rather than left to the delete path: this codebase deletes a
   * repository in one statement and lets the foreign keys do the rest,
   * deliberately, so a table that forgets this is a table that blocks the
   * delete entirely.
   */
  belongsTo: [{ model: 'Repository', onDelete: 'cascade' }],

  indexes: [
    /*
     * One row per ref per repository, enforced by the database rather than
     * promised by the application. Two rows for one ref is a ledger that
     * cannot answer where the ref points, which is the one thing it is for.
     */
    { name: 'git_refs_unique', columns: ['repository_id', 'ref'], unique: true },
    // What the drift audit and materialization read: a repository's whole
    // ledger, in one indexed scan.
    { name: 'git_refs_repository_index', columns: ['repository_id'] },
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
     * The full ref name, `refs/heads/main` rather than `main`.
     *
     * Full, because a short name is ambiguous between a branch and a tag, and
     * the ambiguity would be resolved differently by this application than by
     * git - which is the kind of disagreement that puts a tag's sha on a
     * branch.
     */
    ref: {
      order: 2,
      fillable: true,
      required: true,
      validation: { rule: schema.string().max(255).required() },
      factory: () => 'refs/heads/main',
    },

    /** Where it points. Always a full 40-character sha; a deletion removes the row. */
    sha: {
      order: 3,
      fillable: true,
      required: true,
      validation: { rule: schema.string().max(64).required() },
      factory: () => 'a'.repeat(40),
    },

    /**
     * The write-ahead log entry that last moved this ref.
     *
     * Zero for a row seeded from disk on a repository that predates the
     * ledger, which is a fact worth being able to see: it means the ledger
     * was believed rather than derived from the log.
     */
    sequence: {
      order: 4,
      fillable: true,
      required: true,
      default: 0,
      validation: { rule: schema.number() },
      factory: () => 0,
    },
  },
})

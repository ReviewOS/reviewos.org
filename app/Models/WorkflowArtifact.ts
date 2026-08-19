import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * A file a run produced and somebody will come back for.
 *
 * Not a dependency cache, and the distinction is kept on purpose: a cache is an
 * optimisation the instance may drop whenever it likes, and an artifact is a
 * thing a person asks for by name three weeks later. Sharing a table would mean
 * one retention policy for both, and the two want opposite ones.
 *
 * **The row points at a digest, not at a path.** The bytes live at
 * `storage/artifacts/{aa}/{bb}/{sha256}`, so two jobs publishing identical
 * output cost one file, a re-run producing the same bytes costs nothing, and
 * the name - which is whatever the uploader typed - never reaches the
 * filesystem. An artifact called `../../config/app.ts` is a row with an odd
 * name rather than a write somewhere it should not be.
 *
 * `expires_at` is set when the artifact is uploaded rather than by whatever
 * sweeps later, because a reader is told the date and a policy that lives only
 * in a cron job is one nobody can quote.
 */
export default defineModel({
  name: 'WorkflowArtifact',
  table: 'workflow_artifacts',
  primaryKey: 'id',
  autoIncrement: true,

  indexes: [
    { name: 'workflow_artifacts_repository_index', columns: ['repository_id'] },
    // The list: everything one run produced, which is how the run screen and
    // the API both read them.
    { name: 'workflow_artifacts_run_index', columns: ['workflow_run_id'] },
    // The sweep: what has expired, across every repository at once.
    { name: 'workflow_artifacts_expiry_index', columns: ['expires_at'] },
    // The blob: whether anything still references a digest before it is
    // deleted. Content addressing means one file backs many rows.
    { name: 'workflow_artifacts_digest_index', columns: ['digest'] },
    /*
     * One name per run, which is what makes an upload idempotent.
     *
     * A runner that did not hear the answer uploads again, and at-least-once
     * delivery means that will happen. Without this the run grows two rows for
     * one file and the person collecting it has to guess which.
     */
    { name: 'workflow_artifacts_name_index', columns: ['workflow_run_id', 'name'], unique: true },
  ],

  traits: {
    useTimestamps: true,
    useSeeder: { count: 0 },
  },

  belongsTo: [{ model: 'WorkflowRun', onDelete: 'cascade' }],

  attributes: {
    workflow_run_id: {
      order: 1,
      fillable: true,
      validation: { rule: schema.number().required() },
      factory: () => null,
    },

    /**
     * The job that produced it, when one did.
     *
     * Nullable because a run may publish an artifact of its own once the
     * orchestrator exists, and because a job deleted from a re-planned run
     * should not take its artifact with it - the run is what a person came for.
     */
    workflow_job_id: {
      order: 2,
      fillable: true,
      validation: { rule: schema.number() },
      factory: () => null,
    },

    /** What the uploader called it. Metadata, never a path. */
    name: {
      order: 3,
      fillable: true,
      required: true,
      validation: { rule: schema.string().max(200).required() },
      factory: faker => faker.lorem.word(),
    },

    /** SHA-256 of the bytes, lower case hex. The file's address. */
    digest: {
      order: 4,
      fillable: true,
      required: true,
      validation: { rule: schema.string().max(64).required() },
      factory: () => 'a'.repeat(64),
    },

    /**
     * Where the bytes actually went in the blob store.
     *
     * Derivable from the digest, and recorded anyway. The derivation is stable
     * today because artifacts are content-addressed, but a row that says where
     * its own bytes are keeps working after the prefix changes, after a move
     * to object storage, and for anything written by a version that derived it
     * differently. Nullable, because every row written before this column
     * existed has bytes at the derived key - reading falls back to the
     * derivation rather than treating an old row as missing.
     */
    blob_key: {
      order: 5,
      fillable: true,
      validation: { rule: schema.string().max(255) },
      factory: () => null,
    },

    size_bytes: {
      order: 5,
      fillable: true,
      validation: { rule: schema.number().required() },
      factory: () => 1024,
    },

    /**
     * What the uploader said it is.
     *
     * A hint for the download's `Content-Type`, and nothing more: an artifact
     * is served as an attachment whatever this says, because the bytes came off
     * a machine running somebody's build and a browser that renders them in
     * place is a stored cross-site scripting hole with extra steps.
     */
    content_type: {
      order: 6,
      fillable: true,
      validation: { rule: schema.string().max(150) },
      factory: () => 'application/octet-stream',
    },

    /** When it stops being available, decided at upload. */
    expires_at: {
      order: 7,
      fillable: true,
      validation: { rule: schema.string() },
      factory: () => null,
    },

    /** Which runner uploaded it, for a fleet operator reading a trail. */
    runner_id: {
      order: 8,
      fillable: true,
      validation: { rule: schema.string().max(100) },
      factory: () => null,
    },

    /**
     * The repository this belongs to, copied from its workflow run.
     *
     * Denormalized, and the duplication is the point: this is the column a
     * sharded keyspace routes on, and Vitess cannot follow a foreign key to
     * find it. Without it this table lands in the unsharded keyspace, and every
     * transaction touching it and its workflow run crosses keyspaces - the one
     * thing sharding by repository was chosen to avoid.
     *
     * Written where the row is created, from the parent already in hand.
     * `buddy db:keyspaces --check` is what notices when it is not.
     */
    repository_id: {
      order: 90,
      fillable: true,
      validation: { rule: schema.number() },
      factory: () => null,
    },
  },
})

import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * A key and a value, shared by every job in one run.
 *
 * Buildkite's meta-data, and the reason it exists: a job that computes a version
 * number, a preview URL or a decision has to hand it to a job that runs later,
 * and the alternatives are worse. An artifact is a file for a string. An output
 * only reaches jobs that declared `needs:` on the one that produced it, which
 * means a value cannot travel sideways or skip a layer.
 *
 * **Scoped to the run, not the repository.** Two runs of the same workflow must
 * not see each other's values: they are different commits, and a deploy that
 * read the other one's version number would ship the wrong build.
 */
export default defineModel({
  name: 'RunMetadatum',
  table: 'run_metadata',
  primaryKey: 'id',
  autoIncrement: true,

  indexes: [
    /*
     * One row per key per run, enforced by the database rather than by a check
     * somebody remembers to write: two jobs setting the same key at the same
     * moment would both pass a look-then-insert, and the run would end with two
     * answers to one question.
     */
    { name: 'run_metadata_key_index', columns: ['workflow_run_id', 'key'], unique: true },
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

    key: {
      order: 2,
      fillable: true,
      validation: { rule: schema.string().required().max(200) },
      factory: () => 'version',
    },

    value: {
      order: 3,
      fillable: true,
      validation: { rule: schema.string().max(10_000) },
      factory: () => '',
    },

    /**
     * How many times this key has been written.
     *
     * What compare-and-set compares. A job that read version 3 and writes
     * against version 3 is writing against what it read; if another job got
     * there first the version is 4 and the write is refused rather than
     * silently landing on top of a value this one never saw.
     */
    version: {
      order: 4,
      fillable: true,
      default: 1,
      validation: { rule: schema.number() },
      factory: () => 1,
    },

    /** Which job wrote it last, so a value on a screen has an author. */
    updated_by_job_id: {
      order: 5,
      fillable: true,
      validation: { rule: schema.number() },
      factory: () => null,
    },
  },
})

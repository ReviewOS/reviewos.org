import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * What one repository allows an automated repair to do.
 *
 * A row per repository, and its absence is the answer for every repository
 * nobody has configured: repair is off. That is why this is a table rather than
 * columns on `repositories` - a `repair_enabled` column would be false four
 * thousand times to say something nobody has decided.
 *
 * ## Written as it was typed
 *
 * `forbidden_paths` and `steps` are stored newline separated, as the operator
 * wrote them, rather than expanded into rows. A path pattern is a statement
 * about intent - `**\/*.snap` covers files that do not exist yet - and a table of
 * expanded paths would be a list that stops being true on the next commit.
 *
 * ## The defaults live in code
 *
 * `defaultRepairPolicy()` is the safe reading of every question and this row
 * overrides it field by field. So a repository that turned repair on and said
 * nothing else still gets the forbidden list somebody would write after the
 * first incident - and a default added later protects every repository rather
 * than only the ones configured after it shipped.
 */
export default defineModel({
  name: 'RepairSetting',
  table: 'repair_settings',
  primaryKey: 'id',
  autoIncrement: true,

  belongsTo: [{ model: 'Repository', onDelete: 'cascade' }],

  indexes: [
    // One per repository. Two policies for one repository is a question with
    // two answers, and whichever the query ordered first would decide what an
    // agent may edit.
    { name: 'repair_settings_repository_index', columns: ['repository_id'], unique: true },
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

    /**
     * Whether repair is on at all.
     *
     * Off even with a row present, because a row is created by setting any
     * other field - and "an agent may push branches here" must not switch on as
     * a side effect of naming a forbidden path.
     */
    enabled: {
      order: 2,
      fillable: true,
      default: false,
      validation: { rule: schema.boolean() },
      factory: () => false,
    },

    /** Paths a repair may never change, newline separated, as `*` and `**` patterns. */
    forbidden_paths: {
      order: 3,
      fillable: true,
      validation: { rule: schema.string().max(4000) },
      factory: () => null,
    },

    /**
     * Which failed steps may trigger one, newline separated.
     *
     * An allowlist, and empty means any failed step - the reading somebody who
     * turned this on without naming steps intended. The narrower one is
     * available by naming them.
     */
    steps: {
      order: 4,
      fillable: true,
      validation: { rule: schema.string().max(2000) },
      factory: () => null,
    },

    /** How many repair attempts one failing run may produce. */
    max_attempts: {
      order: 5,
      fillable: true,
      default: 2,
      validation: { rule: schema.number() },
      factory: () => 2,
    },

    /** How long repair may take for one run, in minutes, across every attempt. */
    max_minutes: {
      order: 6,
      fillable: true,
      default: 20,
      validation: { rule: schema.number() },
      factory: () => 20,
    },

    /**
     * What one run's repair may cost, in whatever unit the operator is billed
     * in. Zero for no ceiling, which is the default because nobody shares a
     * unit and a number this instance invented would mean nothing.
     */
    max_cost: {
      order: 7,
      fillable: true,
      default: 0,
      validation: { rule: schema.number() },
      factory: () => 0,
    },
  },
})

import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * One thing a check found, on one range of lines in one file.
 *
 * **Rows rather than a JSON array on the run**, which the roadmap asks for and
 * is worth the sentence: annotations are queried by file and line when a diff
 * renders, and a JSON column means loading every annotation of every check on
 * the commit to find the three on the file somebody is looking at. It also
 * means no index, no partial update, and no way to count them without parsing.
 *
 * The whole value of an annotation is that it appears **on the line it is
 * about**. A lint failure listed in a log is a link nobody clicks; the same
 * failure on the line in the diff is read by whoever is already looking at that
 * line. So the anchor - path, start line, end line, side - is not optional
 * metadata, it is the feature.
 */
export default defineModel({
  name: 'CheckAnnotation',
  table: 'check_annotations',
  primaryKey: 'id',
  autoIncrement: true,

  indexes: [
    { name: 'check_annotations_repository_index', columns: ['repository_id'] },
    // How the diff asks: everything on this run, for this file.
    { name: 'check_annotations_run_path_index', columns: ['check_run_id', 'path'] },
  ],

  traits: {
    useTimestamps: true,
    useSeeder: { count: 0 },
  },

  belongsTo: [{ model: 'CheckRun', onDelete: 'cascade' }],

  attributes: {
    check_run_id: {
      order: 1,
      fillable: true,
      validation: { rule: schema.number().required() },
      factory: () => null,
    },

    /** Repository-relative, as the diff writes it. */
    path: {
      order: 2,
      fillable: true,
      validation: { rule: schema.string().required().max(1024) },
      factory: () => 'src/index.ts',
    },

    start_line: {
      order: 3,
      fillable: true,
      validation: { rule: schema.number().required() },
      factory: () => 1,
    },

    /**
     * The last line of the range, which equals `start_line` for a single line.
     *
     * Stored rather than left null for the common case, so every reader does
     * the same arithmetic. A renderer that has to decide what a missing end
     * line means is a renderer that will decide differently from the next one.
     */
    end_line: {
      order: 4,
      fillable: true,
      validation: { rule: schema.number().required() },
      factory: () => 1,
    },

    /**
     * Which side of the diff, because a check can be about a deleted line.
     *
     * A coverage tool reporting on removed code, or a linter complaining about
     * what a change took away, both anchor on the left. An annotation forced
     * onto the right lands on an unrelated line of the new file.
     */
    side: {
      order: 5,
      fillable: true,
      default: 'right',
      validation: { rule: schema.enum(['left', 'right']) },
      factory: () => 'right',
    },

    /**
     * How much attention it deserves.
     *
     * `failure` is what fails the check, `warning` and `notice` are advice.
     * Kept distinct so a diff can show three hundred notices without any of
     * them looking like the one thing that broke the build.
     */
    level: {
      order: 6,
      fillable: true,
      default: 'warning',
      validation: { rule: schema.enum(['notice', 'warning', 'failure']) },
      factory: () => 'warning',
    },

    title: {
      order: 7,
      fillable: true,
      validation: { rule: schema.string().max(255) },
      factory: () => null,
    },

    /** One or two lines, as it appears beside the code. */
    message: {
      order: 8,
      fillable: true,
      type: 'text',
      validation: { rule: schema.string().required() },
      factory: () => 'Something to look at',
    },

    /** The tool's own output, for whoever wants the unabridged version. */
    raw_details: {
      order: 9,
      fillable: true,
      type: 'text',
      validation: { rule: schema.string() },
      factory: () => null,
    },

    /**
     * The repository this belongs to, copied from its check run.
     *
     * Denormalized, and the duplication is the point: this is the column a
     * sharded keyspace routes on, and Vitess cannot follow a foreign key to
     * find it. Without it this table lands in the unsharded keyspace, and every
     * transaction touching it and its check run crosses keyspaces - the one
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
} as const)

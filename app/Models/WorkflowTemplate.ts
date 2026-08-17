import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * A workflow an owner publishes for their repositories to start from.
 *
 * The governance side of reuse: a reusable workflow is called by a repository
 * that decided to call it, and a template is what an organization puts in front
 * of every repository that has not decided anything yet. New repositories are
 * where CI conventions are actually set, and "copy it from another repository"
 * is how they drift.
 *
 * **Validated when it is published, not when it is applied.** A template that
 * does not parse is refused at the point somebody is looking at it, rather than
 * failing on the first push in a repository whose owner did not write it - by
 * which time the person debugging it has no idea it came from a template.
 */
export default defineModel({
  name: 'WorkflowTemplate',
  table: 'workflow_templates',
  primaryKey: 'id',
  autoIncrement: true,

  indexes: [
    { name: 'workflow_templates_slug_index', columns: ['owner_type', 'owner_id', 'slug'], unique: true },
  ],

  traits: { useUuid: true, useTimestamps: true, useSeeder: { count: 0 } },

  attributes: {
    owner_type: {
      order: 1,
      fillable: true,
      default: 'user',
      validation: { rule: schema.enum(['user', 'organization']) },
      factory: () => 'user',
    },

    owner_id: {
      order: 2,
      fillable: true,
      validation: { rule: schema.number().required() },
      factory: () => null,
    },

    /** What a repository asks for it by. */
    slug: {
      order: 3,
      fillable: true,
      validation: { rule: schema.string().required().max(120) },
      factory: () => 'ci',
    },

    name: {
      order: 4,
      fillable: true,
      validation: { rule: schema.string().required().max(200) },
      factory: () => 'Continuous integration',
    },

    /** One sentence: what this template is for, shown where somebody picks one. */
    description: {
      order: 5,
      fillable: true,
      default: '',
      validation: { rule: schema.string().max(1000) },
      factory: () => '',
    },

    /** Where applying it writes the file. */
    path: {
      order: 6,
      fillable: true,
      default: '.github/workflows/ci.yml',
      validation: { rule: schema.string().max(500) },
      factory: () => '.github/workflows/ci.yml',
    },

    /** The workflow itself, as written. Parsed and refused if it does not. */
    source: {
      order: 7,
      fillable: true,
      validation: { rule: schema.string().required().max(200_000) },
      factory: () => 'name: CI\non: push\n',
    },

    created_by_id: {
      order: 8,
      fillable: true,
      validation: { rule: schema.number() },
      factory: () => null,
    },
  },
})

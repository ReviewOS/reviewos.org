import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * A named group inside an organization that repository access can be granted to
 * as a unit.
 *
 * Teams nest: a child team inherits its parent's repository access, so an
 * organization can grant "engineering" read on everything and let "platform"
 * below it add write on its own repositories. Permission resolution treats the
 * most permissive grant as the answer, so nesting can only ever widen access.
 */
export default defineModel({
  name: 'Team',
  table: 'teams',
  primaryKey: 'id',
  autoIncrement: true,

  indexes: [
    { name: 'teams_org_slug_index', columns: ['organization_id', 'slug'] },
  ],

  traits: {
    useUuid: true,
    useTimestamps: true,
    useSeeder: { count: 6 },
  },

  belongsTo: ['Organization'],

  attributes: {
    organization_id: {
      order: 1,
      fillable: true,
      validation: {
        rule: schema.number().required(),
      },
      factory: () => null,
    },

    name: {
      order: 2,
      fillable: true,
      validation: {
        rule: schema.string().required().min(1).max(100),
      },
      factory: faker => faker.commerce.department(),
    },

    slug: {
      order: 3,
      fillable: true,
      validation: {
        rule: schema.string().required().max(100),
      },
      factory: faker => faker.commerce.department().toLowerCase(),
    },

    description: {
      order: 4,
      fillable: true,
      type: 'text',
      validation: {
        rule: schema.string().max(500),
      },
      factory: faker => faker.company.catchPhrase(),
    },

    parent_team_id: {
      order: 5,
      fillable: true,
      validation: {
        rule: schema.number(),
      },
      factory: () => null,
    },
  },
} as const)

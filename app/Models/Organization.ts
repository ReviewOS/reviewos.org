import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * An organization: a handle that owns repositories on behalf of several people.
 *
 * Shares the handle namespace with `User`, since both live at the root of a URL.
 */
export default defineModel({
  name: 'Organization',
  table: 'organizations',
  primaryKey: 'id',
  autoIncrement: true,

  indexes: [
    { name: 'organizations_handle_index', columns: ['handle'] },
  ],

  traits: {
    useUuid: true,
    useTimestamps: true,
    useSearch: {
      displayable: ['id', 'handle', 'name', 'description'],
      searchable: ['handle', 'name', 'description'],
      sortable: ['created_at'],
      filterable: [],
    },
    useSeeder: { count: 4 },
  },

  attributes: {
    handle: {
      order: 1,
      unique: true,
      fillable: true,
      validation: {
        rule: schema.string().required().min(1).max(39),
        message: { required: 'A handle is required' },
      },
      factory: faker => faker.company.name().toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 39),
    },

    name: {
      order: 2,
      fillable: true,
      validation: {
        rule: schema.string().max(100),
      },
      factory: faker => faker.company.name(),
    },

    description: {
      order: 3,
      fillable: true,
      type: 'text',
      validation: {
        rule: schema.string().max(500),
      },
      factory: faker => faker.company.catchPhrase(),
    },

    avatar_url: {
      order: 4,
      fillable: true,
      validation: {
        rule: schema.string().max(2048),
      },
      factory: faker => faker.image.avatar(),
    },

    website: {
      order: 5,
      fillable: true,
      validation: {
        rule: schema.string().max(2048),
      },
      factory: faker => faker.internet.url(),
    },

    billing_email: {
      order: 6,
      fillable: true,
      validation: {
        rule: schema.string().email(),
      },
      factory: faker => faker.internet.email().toLowerCase(),
    },
  },
} as const)

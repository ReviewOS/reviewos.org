import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * One permission granted to one token.
 *
 * A row rather than a bitfield or a comma-joined string, so adding a scope is an
 * insert and not a migration over every token ever issued, and so "which tokens
 * can write to issues" is a query rather than a scan with string matching.
 *
 * The scope and level vocabulary lives in `app/TokenScopes.ts`, which also
 * carries the rule that every ability the product has maps to one of these.
 */
export default defineModel({
  name: 'AccessTokenPermission',
  table: 'access_token_permissions',
  primaryKey: 'id',
  autoIncrement: true,

  indexes: [
    { name: 'access_token_permissions_token_index', columns: ['access_token_id'] },
  ],

  traits: {
    useTimestamps: true,
    useSeeder: { count: 20 },
  },

  // Cascades. A grant belonging to a token that no longer exists means nothing,
  // and without it the token could not be deleted at all while one row pointed
  // at it - the same gap the repository link beside it already avoided.
  belongsTo: [{ model: 'AccessToken', onDelete: 'cascade' }],

  attributes: {
    access_token_id: {
      order: 1,
      fillable: true,
      validation: { rule: schema.number().required() },
      factory: () => null,
    },

    scope: {
      order: 2,
      fillable: true,
      validation: {
        rule: schema.enum([
          'contents',
          'issues',
          'pull_requests',
          'webhooks',
          'administration',
          // Kept in step with `REPOSITORY_SCOPES` and `ORGANIZATION_SCOPES` in
          // `app/TokenScopes.ts`, which a unit test now enforces. `checks` was
          // added there and not here, and because this list becomes a Postgres
          // enum, every attempt to grant it failed at the insert - the scope
          // existed in the vocabulary and could not be written down.
          'checks',
          'members',
          'organization_administration',
          'billing',
        ]),
      },
      factory: faker => faker.helpers.arrayElement(['contents', 'issues', 'pull_requests']),
    },

    level: {
      order: 3,
      fillable: true,
      default: 'read',
      validation: { rule: schema.enum(['read', 'write', 'admin']) },
      factory: faker => faker.helpers.arrayElement(['read', 'write']),
    },
  },
} as const)

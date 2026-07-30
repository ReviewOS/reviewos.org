import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * Somebody's membership of a team.
 *
 * A user in two teams gets the union of what those teams can reach, which is
 * why permission resolution takes the most permissive grant rather than the
 * first one it finds.
 */
export default defineModel({
  name: 'TeamMember',
  table: 'team_members',
  primaryKey: 'id',
  autoIncrement: true,

  indexes: [
    { name: 'team_members_team_user_index', columns: ['team_id', 'user_id'] },
  ],

  traits: {
    useTimestamps: true,
    useSeeder: { count: 15 },
  },

  belongsTo: ['Team', 'User'],

  attributes: {
    team_id: {
      order: 1,
      fillable: true,
      validation: { rule: schema.number().required() },
      factory: () => null,
    },

    user_id: {
      order: 2,
      fillable: true,
      validation: { rule: schema.number().required() },
      factory: () => null,
    },

    role: {
      order: 3,
      fillable: true,
      default: 'member',
      validation: { rule: schema.enum(['maintainer', 'member']) },
      factory: faker => faker.helpers.arrayElement(['maintainer', 'member']),
    },
  },
} as const)

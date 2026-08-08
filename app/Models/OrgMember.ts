import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * Somebody's membership of an organization, and the role it carries.
 *
 * An organization always has at least one owner. `RemoveMemberAction` and
 * `ChangeMemberRoleAction` both refuse the change that would leave none, since
 * an organization nobody can administer cannot be repaired from the interface.
 */
export default defineModel({
  name: 'OrgMember',
  table: 'org_members',
  primaryKey: 'id',
  autoIncrement: true,

  indexes: [
    { name: 'org_members_org_user_index', columns: ['organization_id', 'user_id'] },
  ],

  traits: {
    useTimestamps: true,
    useSeeder: { count: 12 },
  },

  /*
   * Both cascade. A membership of an organization that no longer exists means
   * nothing, and one belonging to a deleted account means less - and without
   * the cascades neither the organization nor the user could be deleted at all
   * while a single row pointed at them.
   *
   * `invited_by_id` deliberately does not, and is not declared as a relation:
   * it records who did something, and the record should survive them leaving.
   */
  belongsTo: [
    { model: 'Organization', onDelete: 'cascade' },
    { model: 'User', onDelete: 'cascade' },
  ],

  attributes: {
    organization_id: {
      order: 1,
      fillable: true,
      validation: {
        rule: schema.number().required(),
      },
      factory: () => null,
    },

    user_id: {
      order: 2,
      fillable: true,
      validation: {
        rule: schema.number().required(),
      },
      factory: () => null,
    },

    role: {
      order: 3,
      fillable: true,
      default: 'member',
      validation: {
        rule: schema.enum(['owner', 'admin', 'member']),
      },
      factory: faker => faker.helpers.arrayElement(['owner', 'admin', 'member']),
    },

    invited_by_id: {
      order: 4,
      fillable: true,
      validation: {
        rule: schema.number(),
      },
      factory: () => null,
    },

    joined_at: {
      order: 5,
      fillable: true,
      validation: {
        rule: schema.string(),
      },
      factory: faker => faker.date.past().toISOString(),
    },
  },
} as const)

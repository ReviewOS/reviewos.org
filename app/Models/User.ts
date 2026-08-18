import { defineModel } from '@stacksjs/orm'
import { makeHash } from '@stacksjs/security'
import { schema } from '@stacksjs/validation'

/**
 * A person.
 *
 * Overrides the framework default to add the parts a forge needs: a handle,
 * which is the URL segment and the thing people call each other, and the
 * profile fields that hang off it.
 *
 * Handles share one namespace with organizations. Both appear at the root of a
 * URL (`/chris`, `/reviewos`), so `handleAvailable` in
 * `app/Actions/Identity/handles.ts` is the one place that decides whether a
 * handle can be taken, and both models go through it.
 */
export default defineModel({
  name: 'User',
  table: 'users',
  primaryKey: 'id',
  autoIncrement: true,

  indexes: [
    { name: 'users_handle_index', columns: ['handle'] },
  ],

  traits: {
    useAuth: { usePasskey: true },
    useUuid: true,
    useTimestamps: true,
    useSocials: ['github'],
    /*
     * A named projection, because the default one indexed the whole row.
     *
     * The whole row includes `password`. A hash in a search corpus turns any
     * read of the search node into an offline cracking target needing no
     * further access; it also carried `email`, making every address on the
     * instance queryable, and `is_admin`, which is a map of who is worth
     * attacking. `displayable` did not prevent any of it - that governs what
     * comes back from a query, not what is written.
     *
     * `shapeMany` is a deny list by construction: a column added to this table
     * stays out of the index until somebody names it in `userDocuments`.
     */
    useSearch: {
      displayable: ['id', 'handle', 'name', 'avatar_url'],
      searchable: ['handle', 'name'],
      sortable: [],
      filterable: [],
      shapeMany: async (rows: any[]) => {
        const { userDocuments } = await import('../Actions/Search/documents')

        return await userDocuments(rows)
      },
    },
    useSeeder: { count: 10 },
  },

  attributes: {
    handle: {
      order: 1,
      unique: true,
      fillable: true,
      validation: {
        rule: schema.string().required().min(1).max(39),
        message: {
          required: 'A handle is required',
          max: 'A handle can be at most 39 characters',
        },
      },
      factory: faker => faker.internet.username().toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 39) || 'user',
    },

    name: {
      order: 2,
      fillable: true,
      validation: {
        rule: schema.string().max(100),
      },
      factory: faker => faker.person.fullName(),
    },

    email: {
      order: 3,
      unique: true,
      fillable: true,
      validation: {
        rule: schema.string().email().required(),
        message: { required: 'An email address is required' },
      },
      factory: faker => faker.internet.email().toLowerCase(),
    },

    password: {
      order: 4,
      hidden: true,
      fillable: true,
      validation: {
        rule: schema.string().required().min(8).max(255),
        message: { min: 'A password must be at least 8 characters' },
      },
      factory: () => 'password123',
    },

    bio: {
      order: 5,
      fillable: true,
      type: 'text',
      validation: {
        rule: schema.string().max(500),
      },
      factory: faker => faker.lorem.sentence(),
    },

    avatar_url: {
      order: 6,
      fillable: true,
      validation: {
        rule: schema.string().max(2048),
      },
      factory: faker => faker.image.avatar(),
    },

    location: {
      order: 7,
      fillable: true,
      validation: {
        rule: schema.string().max(100),
      },
      factory: faker => `${faker.location.city()}, ${faker.location.country()}`,
    },

    website: {
      order: 8,
      fillable: true,
      validation: {
        rule: schema.string().max(2048),
      },
      factory: faker => faker.internet.url(),
    },

    is_admin: {
      order: 9,
      fillable: true,
      default: false,
      validation: {
        rule: schema.boolean(),
      },
      factory: () => false,
    },

    /**
     * The organization this account exists to serve, or null for a person.
     *
     * A **machine account**: an account that holds tokens and nothing else. No
     * password, no session login, owned by an organization rather than by
     * whoever happened to create it.
     *
     * It exists because the alternative happens anyway. Without one, CI needs a
     * credential and somebody uses their own, or the team creates a shared
     * human account with the password in a password manager - and then that
     * account has a mailbox, a review vote, and a session anybody who has ever
     * been on the team can still open. A machine account has none of those: it
     * cannot sign in, so there is nothing to share, and it belongs to the
     * organization, so it survives its creator leaving and is revocable by
     * people who are still there.
     *
     * Not fillable. It is set by `CreateMachineAccountAction` and by nothing
     * else - a profile update that could set it would be a way to turn your own
     * account into somebody's machine, or theirs into yours.
     */
    machine_for_organization_id: {
      order: 10,
      fillable: false,
      validation: {
        rule: schema.number(),
      },
      factory: () => null,
    },

    email_verified_at: {
      order: 11,
      fillable: true,
      validation: {
        rule: schema.string(),
      },
      factory: () => new Date().toISOString(),
    },

    /**
     * The GitHub account this user has linked, if any.
     *
     * Set only by the user, never inferred. It is what lets a mirrored issue or
     * review comment be attributed to them: an import that matched on handle
     * instead would hand one person's words to another who happens to share a
     * name on a different host, which is ordinary and not recoverable from.
     */
    github_username: {
      order: 12,
      fillable: true,
      unique: true,
      validation: {
        rule: schema.string().max(39),
      },
      factory: () => null,
    },
  },

  set: {
    // Widened to what the ORM actually passes. 0.72 types a setter as
    // `(attributes: Record<string, unknown>) => unknown`, and narrowing the
    // parameter to the one field this reads is the shape TypeScript refuses -
    // a setter must accept every attribute, not only its own.
    password: async (attributes: Record<string, unknown>) =>
      await makeHash(String(attributes.password ?? ''), { algorithm: 'bcrypt' }),
  },
} as const)
